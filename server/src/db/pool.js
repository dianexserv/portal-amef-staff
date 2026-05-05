// Cache de pool-uri pg per tenant.
//
// Modelul C (DB-per-tenant pe instanță Cloud SQL partajată) implică un Pool
// pg distinct pentru fiecare tenant + un Pool pentru DB-ul shared
// (`amef_shared`). Cache-ul `Map<tenantSlug, Pool>` evită re-crearea
// conexiunilor la fiecare request HTTP — `pg.Pool` e relativ scump
// (handshake TCP + autentificare) și Cloud Run instanța poate trăi minute.
//
// `search_path` e setat explicit la `amef`/`amef_shared` ca să forțăm
// folosirea schemei dedicate (NU `public` — regulă din CLAUDE.md). Setarea
// se face prin parametrul `options=-c search_path=...` din connection string —
// Postgres îl aplică ATOMIC, înainte de orice query, garantat de protocol.
// Alternativa cu `pool.on('connect', SET search_path)` rulează asincron și
// fără await; deși benignă în condiții normale, poate eșua în edge cases
// (retries de conexiune, timeouts), iar fix-ul e simplu: îl mutăm în URL.
//
// `_deps` e un test seam — în CJS vi.mock NU interceptează require(), deci
// folosim injecție explicită pentru Pool/getSecret/logger ca testele să
// poată substitui implementarea fără a depinde de hoisting magic.

const { Pool } = require('pg');
const config = require('../config');
const secretManager = require('../utils/secret-manager');
const realLogger = require('../logger');
const {
  deriveSecretName,
  envFromNodeEnv,
} = require('../utils/secret-naming');

// _deps object exported strictly for testing. Tests mutate _deps.client/_deps.logger
// to inject mocks. Production code MUST NOT touch _deps directly except in lazy init.
//
// În CJS, vi.mock NU interceptează require() și nu putem mock-ui pg/secret-manager
// pe alte căi fără hack-uri fragile. Vezi „Testing seam pattern" în CLAUDE.md.
//
// `getNodeEnv` e o funcție (nu o valoare cached) ca testele să poată varia
// răspunsul per-test fără re-import — config.NODE_ENV e capturat la load.
const _deps = {
  PoolClass: Pool,
  getSecret: secretManager.getSecret,
  logger: realLogger,
  getNodeEnv: () => config.NODE_ENV,
};

const tenantPools = new Map();
let sharedPool = null;

const TENANT_POOL_MAX = 10;
const SHARED_POOL_MAX = 5;
const POOL_IDLE_TIMEOUT_MS = 30000;
// Cleanup la fiecare 30 min — eliberăm conexiunile complet inactive ca să
// permitem re-resolve DNS (Cloud SQL IP poate pivota la failover) și să
// nu ținem deschis un pool nefolosit pentru un tenant rar accesat.
const IDLE_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

// Adaugă `?options=-c search_path=<schema>,public` la connection string.
// Postgres aplică `options` la handshake — orice query pe conexiunea respectivă
// vede deja search_path-ul corect, fără SET asincron post-connect.
function withSearchPath(connectionString, schema) {
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return url.toString();
}

async function getTenantPool(tenantSlug) {
  if (typeof tenantSlug !== 'string' || tenantSlug.trim() === '') {
    throw new Error('tenantSlug trebuie să fie un string non-gol');
  }
  const cached = tenantPools.get(tenantSlug);
  if (cached) {
    return cached;
  }
  const env = envFromNodeEnv(_deps.getNodeEnv());
  const secretName = deriveSecretName('tenant', env, tenantSlug);
  const rawConnectionString = await _deps.getSecret(secretName);
  const pool = new _deps.PoolClass({
    connectionString: withSearchPath(rawConnectionString, 'amef'),
    max: TENANT_POOL_MAX,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  });
  tenantPools.set(tenantSlug, pool);
  return pool;
}

async function getSharedPool() {
  if (sharedPool) {
    return sharedPool;
  }
  const env = envFromNodeEnv(_deps.getNodeEnv());
  const secretName = deriveSecretName('shared', env);
  const rawConnectionString = await _deps.getSecret(secretName);
  sharedPool = new _deps.PoolClass({
    connectionString: withSearchPath(rawConnectionString, 'amef_shared'),
    max: SHARED_POOL_MAX,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  });
  return sharedPool;
}

async function closeAllPools() {
  const closes = [];
  for (const [, pool] of tenantPools) {
    closes.push(pool.end());
  }
  if (sharedPool) {
    closes.push(sharedPool.end());
  }
  // allSettled ca să nu eșueze tot teardown-ul dacă un pool moare la .end()
  await Promise.allSettled(closes);
  tenantPools.clear();
  sharedPool = null;
}

function closeIdlePools() {
  for (const [slug, pool] of tenantPools) {
    if (pool.totalCount > 0 && pool.idleCount === pool.totalCount) {
      pool.end().catch((err) => {
        _deps.logger.error(
          { err, slug },
          'Eșec la închiderea pool-ului tenant idle'
        );
      });
      tenantPools.delete(slug);
    }
  }
  if (
    sharedPool &&
    sharedPool.totalCount > 0 &&
    sharedPool.idleCount === sharedPool.totalCount
  ) {
    sharedPool.end().catch((err) => {
      _deps.logger.error({ err }, 'Eșec la închiderea pool-ului shared idle');
    });
    sharedPool = null;
  }
}

// `unref()` ca timer-ul să nu blocheze exit-ul procesului — important pentru
// Cloud Run shutdown (SIGTERM la deploy nou) și pentru rularea testelor.
const cleanupTimer = setInterval(closeIdlePools, IDLE_CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

module.exports = {
  getTenantPool,
  getSharedPool,
  closeAllPools,
  // Expuse pentru teste (NU folosi în cod de producție — runtime-ul
  // gestionează deja interval-ul automat).
  _closeIdlePools: closeIdlePools,
  _cleanupTimer: cleanupTimer,
  _deps,
};
