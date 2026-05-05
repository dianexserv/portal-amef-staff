// Teste pentru db/pool.js. Folosim `_deps` (test seam exportat din modul)
// pentru a injecta:
//   - PoolClass — un fake Pool care expune query/end/on și permite triggering
//     manual al handler-ului 'connect';
//   - getSecret — un mock care returnează un connection string fals;
//   - logger — un logger noop ca să nu emitem zgomot pe stdout.
//
// În CJS vi.mock NU interceptează require(), deci injecția explicită e
// abordarea robustă. `_deps` e mutabil intenționat — testele rescriu
// proprietățile între iterații.

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'silent');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');
vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_SECRET_NAME', 'firebase-service-account-test');

const pool = require('./pool');
const realDeps = { ...pool._deps };

// Fabrici utilitare locale — re-creăm la fiecare beforeEach ca testele să
// fie complet izolate (instanțele Pool create într-un test nu „scapă" în
// următorul).
let poolInstances;
let getSecretMock;

function makeFakePool() {
  return function FakePool(opts) {
    const handlers = {};
    const inst = {
      __opts: opts,
      __handlers: handlers,
      query: vi.fn().mockResolvedValue({ rows: [] }),
      end: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event, fn) => {
        handlers[event] = fn;
      }),
      __triggerConnect(client) {
        if (handlers.connect) {
          handlers.connect(client);
        }
      },
      idleCount: 0,
      totalCount: 0,
    };
    poolInstances.push(inst);
    return inst;
  };
}

beforeEach(async () => {
  // Asigurăm un start curat — poate un test anterior a lăsat ceva în cache
  await pool.closeAllPools();

  poolInstances = [];
  getSecretMock = vi.fn().mockResolvedValue('postgresql://u:p@127.0.0.1:5432/db');

  pool._deps.PoolClass = makeFakePool();
  pool._deps.getSecret = getSecretMock;
  pool._deps.logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  // Default: imită config.NODE_ENV='production' (vezi vi.stubEnv mai sus).
  // Tests individuale suprascriu pentru a verifica mapping-ul staging/dev.
  pool._deps.getNodeEnv = () => 'production';
});

afterEach(async () => {
  await pool.closeAllPools();
});

afterAll(() => {
  // Restaurăm dependențele reale la final ca să nu afectăm alte fișiere
  // care s-ar putea încărca în același worker (deși vitest izolează în
  // mod normal per fișier).
  Object.assign(pool._deps, realDeps);
  if (pool._cleanupTimer) {
    clearInterval(pool._cleanupTimer);
  }
});

describe('getTenantPool', () => {
  it('returnează același Pool la apeluri repetate (cache per slug)', async () => {
    const a = await pool.getTenantPool('dianex');
    const b = await pool.getTenantPool('dianex');
    expect(a).toBe(b);
    expect(poolInstances).toHaveLength(1);
  });

  it('cache-ul e per-tenant (slug-uri diferite → pool-uri diferite)', async () => {
    const a = await pool.getTenantPool('dianex');
    const b = await pool.getTenantPool('client-x');
    expect(a).not.toBe(b);
    expect(poolInstances).toHaveLength(2);
  });

  it('citește connection string din secretul derivat (tenant + production)', async () => {
    await pool.getTenantPool('dianex');
    expect(getSecretMock).toHaveBeenCalledWith('tenant-dianex-db-connection');
  });

  it('NODE_ENV=staging derivă tenant-{slug}-staging-db-connection', async () => {
    pool._deps.getNodeEnv = () => 'staging';
    await pool.getTenantPool('dianex');
    expect(getSecretMock).toHaveBeenCalledWith(
      'tenant-dianex-staging-db-connection'
    );
  });

  it('NODE_ENV=development → folosește DB-ul de staging (suffix -staging)', async () => {
    pool._deps.getNodeEnv = () => 'development';
    await pool.getTenantPool('dianex');
    expect(getSecretMock).toHaveBeenCalledWith(
      'tenant-dianex-staging-db-connection'
    );
  });

  it('configurează pool-ul cu max=10 și idleTimeoutMillis=30000', async () => {
    const p = await pool.getTenantPool('dianex');
    expect(p.__opts.max).toBe(10);
    expect(p.__opts.idleTimeoutMillis).toBe(30000);
  });

  it('injectează search_path=amef,public în connection string (param `options`)', async () => {
    const p = await pool.getTenantPool('dianex');
    const url = new URL(p.__opts.connectionString);
    expect(url.searchParams.get('options')).toBe('-c search_path=amef,public');
    // Părțile de bază ale URL-ului rămân intacte
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe('5432');
    expect(url.pathname).toBe('/db');
  });

  it('NU înregistrează handler "connect" pe tenant pool (search_path e în URL)', async () => {
    const p = await pool.getTenantPool('dianex');
    expect(p.on).not.toHaveBeenCalled();
  });

  it('respinge tenantSlug gol sau invalid', async () => {
    await expect(pool.getTenantPool('')).rejects.toThrow();
    await expect(pool.getTenantPool('   ')).rejects.toThrow();
    await expect(pool.getTenantPool(null)).rejects.toThrow();
    await expect(pool.getTenantPool(123)).rejects.toThrow();
  });
});

describe('getSharedPool', () => {
  it('returnează un pool separat de orice tenant pool', async () => {
    const t = await pool.getTenantPool('dianex');
    const s = await pool.getSharedPool();
    expect(t).not.toBe(s);
    expect(poolInstances).toHaveLength(2);
  });

  it('e idempotent (aceeași instanță la apeluri repetate)', async () => {
    const a = await pool.getSharedPool();
    const b = await pool.getSharedPool();
    expect(a).toBe(b);
    expect(poolInstances).toHaveLength(1);
  });

  it('citește connection string din secretul derivat (shared + production)', async () => {
    await pool.getSharedPool();
    expect(getSecretMock).toHaveBeenCalledWith('shared-db-connection');
  });

  it('NODE_ENV=staging derivă shared-staging-db-connection', async () => {
    pool._deps.getNodeEnv = () => 'staging';
    await pool.getSharedPool();
    expect(getSecretMock).toHaveBeenCalledWith('shared-staging-db-connection');
  });

  it('NODE_ENV=development → folosește DB-ul de staging (suffix -staging)', async () => {
    pool._deps.getNodeEnv = () => 'development';
    await pool.getSharedPool();
    expect(getSecretMock).toHaveBeenCalledWith('shared-staging-db-connection');
  });

  it('configurează shared pool cu max=5 și idleTimeoutMillis=30000', async () => {
    const p = await pool.getSharedPool();
    expect(p.__opts.max).toBe(5);
    expect(p.__opts.idleTimeoutMillis).toBe(30000);
  });

  it('injectează search_path=amef_shared,public în connection string (param `options`)', async () => {
    const p = await pool.getSharedPool();
    const url = new URL(p.__opts.connectionString);
    expect(url.searchParams.get('options')).toBe(
      '-c search_path=amef_shared,public'
    );
  });

  it('NU înregistrează handler "connect" pe shared pool (search_path e în URL)', async () => {
    const p = await pool.getSharedPool();
    expect(p.on).not.toHaveBeenCalled();
  });
});

describe('closeAllPools', () => {
  it('închide toate pool-urile și golește cache-ul', async () => {
    const t1 = await pool.getTenantPool('dianex');
    const t2 = await pool.getTenantPool('client-x');
    const s = await pool.getSharedPool();

    await pool.closeAllPools();

    expect(t1.end).toHaveBeenCalledTimes(1);
    expect(t2.end).toHaveBeenCalledTimes(1);
    expect(s.end).toHaveBeenCalledTimes(1);

    // Cache golit: un nou getTenantPool creează pool nou
    const t1Again = await pool.getTenantPool('dianex');
    expect(t1Again).not.toBe(t1);
  });

  it('tolerează erori la .end() (allSettled)', async () => {
    const t = await pool.getTenantPool('dianex');
    t.end.mockRejectedValueOnce(new Error('end failed'));
    await expect(pool.closeAllPools()).resolves.toBeUndefined();
  });

  it('e safe de apelat când nu există pool-uri', async () => {
    await expect(pool.closeAllPools()).resolves.toBeUndefined();
  });
});

describe('_closeIdlePools', () => {
  it('închide pool-urile complet idle (idleCount === totalCount)', async () => {
    const t = await pool.getTenantPool('dianex');
    t.idleCount = 3;
    t.totalCount = 3;

    pool._closeIdlePools();

    expect(t.end).toHaveBeenCalledTimes(1);

    // Pool-ul a fost evacuat din cache: getTenantPool returnează unul nou
    const t2 = await pool.getTenantPool('dianex');
    expect(t2).not.toBe(t);
  });

  it('NU închide pool-uri cu conexiuni active', async () => {
    const t = await pool.getTenantPool('dianex');
    t.idleCount = 2;
    t.totalCount = 5;

    pool._closeIdlePools();

    expect(t.end).not.toHaveBeenCalled();

    // Pool-ul e încă în cache
    const tAgain = await pool.getTenantPool('dianex');
    expect(tAgain).toBe(t);
  });

  it('NU închide pool cu totalCount=0 (gol, neconectat)', async () => {
    const t = await pool.getTenantPool('dianex');
    t.idleCount = 0;
    t.totalCount = 0;

    pool._closeIdlePools();

    expect(t.end).not.toHaveBeenCalled();
  });

  it('închide și shared pool când e complet idle', async () => {
    const s = await pool.getSharedPool();
    s.idleCount = 1;
    s.totalCount = 1;

    pool._closeIdlePools();

    expect(s.end).toHaveBeenCalledTimes(1);

    // Re-creat la următorul apel
    const s2 = await pool.getSharedPool();
    expect(s2).not.toBe(s);
  });

  it('NU închide shared pool cu conexiuni active', async () => {
    const s = await pool.getSharedPool();
    s.idleCount = 0;
    s.totalCount = 3;

    pool._closeIdlePools();

    expect(s.end).not.toHaveBeenCalled();
  });

  it('logează când .end() eșuează în cleanup', async () => {
    const t = await pool.getTenantPool('dianex');
    t.idleCount = 1;
    t.totalCount = 1;
    t.end.mockRejectedValueOnce(new Error('end-failed'));

    pool._closeIdlePools();
    await Promise.resolve();
    await Promise.resolve();

    expect(pool._deps.logger.error).toHaveBeenCalled();
  });
});

describe('_cleanupTimer', () => {
  it('e un Timer Node cu unref() (nu blochează exit-ul procesului)', () => {
    expect(pool._cleanupTimer).toBeDefined();
    expect(typeof pool._cleanupTimer.unref).toBe('function');
    expect(typeof pool._cleanupTimer.ref).toBe('function');
  });
});
