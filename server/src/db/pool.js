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
// se face în handler-ul `connect` pentru ca fiecare conexiune nouă creată
// de pool să aibă search_path corect înainte de prima query.
//
// `_deps` e un test seam — în CJS vi.mock NU interceptează require(), deci
// folosim injecție explicită pentru Pool/getSecret/logger ca testele să
// poată substitui implementarea fără a depinde de hoisting magic.

const { Pool } = require('pg');
const config = require('../config');
const secretManager = require('../utils/secret-manager');
const realLogger = require('../logger');

// _deps object exported strictly for testing. Tests mutate _deps.client/_deps.logger
// to inject mocks. Production code MUST NOT touch _deps directly except in lazy init.
//
// În CJS, vi.mock NU interceptează require() și nu putem mock-ui pg/secret-manager
// pe alte căi fără hack-uri fragile. Vezi „Testing seam pattern" în CLAUDE.md.
const _deps = {
  PoolClass: Pool,
  getSecret: secretManager.getSecret,
  logger: realLogger,
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

function buildTenantSecretName(tenantSlug) {
  return `tenant-${tenantSlug}-db-connection`;
}

async function getTenantPool(tenantSlug) {
  if (typeof tenantSlug !== 'string' || tenantSlug.trim() === '') {
    throw new Error('tenantSlug trebuie să fie un string non-gol');
  }
  const cached = tenantPools.get(tenantSlug);
  if (cached) {
    return cached;
  }
  const connectionString = await _deps.getSecret(
    buildTenantSecretName(tenantSlug)
  );
  const pool = new _deps.PoolClass({
    connectionString,
    max: TENANT_POOL_MAX,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  });
  // Atenție: handler-ul 'connect' nu e await-uit de pg-pool, dar query-urile
  // pe aceeași conexiune sunt serializate de protocolul Postgres — SET-ul
  // se execută înainte de primul SELECT al user-ului.
  pool.on('connect', (client) => {
    client.query('SET search_path TO amef, public').catch((err) => {
      _deps.logger.error(
        { err, tenantSlug },
        'Eșec la setarea search_path pe conexiune tenant'
      );
    });
  });
  tenantPools.set(tenantSlug, pool);
  return pool;
}

async function getSharedPool() {
  if (sharedPool) {
    return sharedPool;
  }
  const connectionString = await _deps.getSecret(
    config.SHARED_DB_CONNECTION_SECRET_NAME
  );
  sharedPool = new _deps.PoolClass({
    connectionString,
    max: SHARED_POOL_MAX,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  });
  sharedPool.on('connect', (client) => {
    client.query('SET search_path TO amef_shared, public').catch((err) => {
      _deps.logger.error(
        { err },
        'Eșec la setarea search_path pe conexiune shared'
      );
    });
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
