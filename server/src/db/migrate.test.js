// Unit tests pentru migrate.js. Mock-uim:
//   - pool.connect() → un client fals cu query() / release()
//   - _deps.fs cu readdirSync/readFileSync controlate
//   - _deps.logger noop
// Toate scenariile se testează aici fără a atinge Postgres real; pentru
// validarea end-to-end vezi tests/integration/migrate.integration.test.js.

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'silent');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');
vi.stubEnv('SHARED_DB_CONNECTION_SECRET_NAME', 'shared-db-connection-test');

const migrate = require('./migrate');
const {
  applyMigrations,
  listMigrationFiles,
  listAppliedMigrations,
  MIGRATION_ADVISORY_LOCK_ID,
} = migrate;

const realDeps = { ...migrate._deps };

// Helper: fabrică un client fals care înregistrează toate query-urile.
// `appliedSeed` controlează ce returnează SELECT-ul după acquire lock.
function makeClient({ appliedSeed = [], failOn = null } = {}) {
  const calls = [];
  const client = {
    calls,
    released: false,
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      // Simulăm eșecul pe SQL-ul indicat (string match)
      if (failOn && typeof sql === 'string' && sql.includes(failOn)) {
        throw new Error('boom: ' + failOn);
      }
      // SELECT-ul de schema_migrations returnează seed-ul
      if (
        typeof sql === 'string' &&
        sql.includes('SELECT filename FROM schema_migrations')
      ) {
        return { rows: appliedSeed.map((f) => ({ filename: f })) };
      }
      // Default: fără rânduri
      return { rows: [] };
    }),
    release: vi.fn(() => {
      client.released = true;
    }),
  };
  return client;
}

function makePool(client) {
  return {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rows: [] })),
  };
}

beforeEach(() => {
  migrate._deps.fs = {
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => ''),
  };
  migrate._deps.logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
});

afterAll(() => {
  Object.assign(migrate._deps, realDeps);
});

describe('listMigrationFiles', () => {
  it('returnează doar fișierele .sql, sortate ascendent', () => {
    migrate._deps.fs.readdirSync = vi.fn(() => [
      '003_third.sql',
      '001_first.sql',
      '002_second.sql',
    ]);
    expect(listMigrationFiles('/migs')).toEqual([
      '001_first.sql',
      '002_second.sql',
      '003_third.sql',
    ]);
  });

  it('ignoră fișierele non-.sql (README, .gitkeep, etc.)', () => {
    migrate._deps.fs.readdirSync = vi.fn(() => [
      '001_init.sql',
      'README.md',
      '.gitkeep',
      'notes.txt',
    ]);
    expect(listMigrationFiles('/migs')).toEqual(['001_init.sql']);
  });

  it('returnează array gol când directorul e gol', () => {
    migrate._deps.fs.readdirSync = vi.fn(() => []);
    expect(listMigrationFiles('/migs')).toEqual([]);
  });
});

describe('listAppliedMigrations', () => {
  it('interoghează schema_migrations sortat ascendent', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ filename: '001_a.sql' }, { filename: '002_b.sql' }],
      }),
    };
    const result = await listAppliedMigrations(pool);
    expect(result).toEqual(['001_a.sql', '002_b.sql']);
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT filename FROM schema_migrations ORDER BY filename ASC'
    );
  });
});

describe('applyMigrations — happy path', () => {
  it('pe schema goală aplică toate fișierele în ordine', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => [
      '002_b.sql',
      '001_a.sql',
    ]);
    migrate._deps.fs.readFileSync = vi.fn((fullPath) => {
      if (fullPath.includes('001_a.sql')) return 'CREATE TABLE a (id INT);';
      return 'CREATE TABLE b (id INT);';
    });
    const client = makeClient({ appliedSeed: [] });
    const pool = makePool(client);

    const result = await applyMigrations(pool, '/migs');

    expect(result.applied).toEqual(['001_a.sql', '002_b.sql']);
    expect(result.skipped).toEqual([]);

    // Verificăm secvența esențială: CREATE TABLE schema_migrations,
    // pg_advisory_lock, BEGIN, SQL, INSERT, COMMIT (de două ori), unlock.
    const sqls = client.calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('schema_migrations'))).toBe(true);
    expect(sqls.some((s) => s.includes('pg_advisory_lock'))).toBe(true);
    expect(sqls.filter((s) => s === 'BEGIN')).toHaveLength(2);
    expect(sqls.filter((s) => s === 'COMMIT')).toHaveLength(2);
    expect(sqls.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);

    // Conținutul SQL-ului din fișiere a ajuns la query
    expect(client.query).toHaveBeenCalledWith('CREATE TABLE a (id INT);');
    expect(client.query).toHaveBeenCalledWith('CREATE TABLE b (id INT);');

    // Client release la finally
    expect(client.released).toBe(true);
  });

  it('sare peste fișierele deja aplicate', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => ['001_a.sql', '002_b.sql']);
    migrate._deps.fs.readFileSync = vi.fn(() => 'SELECT 1;');
    const client = makeClient({ appliedSeed: ['001_a.sql'] });
    const pool = makePool(client);

    const result = await applyMigrations(pool, '/migs');

    expect(result.applied).toEqual(['002_b.sql']);
    expect(result.skipped).toEqual(['001_a.sql']);

    // Doar o singură pereche BEGIN/COMMIT (pentru 002)
    const sqls = client.calls.map((c) => c.sql);
    expect(sqls.filter((s) => s === 'BEGIN')).toHaveLength(1);
    expect(sqls.filter((s) => s === 'COMMIT')).toHaveLength(1);
  });

  it('cu director gol returnează arrays goale fără tranzacții', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => []);
    const client = makeClient({ appliedSeed: [] });
    const pool = makePool(client);

    const result = await applyMigrations(pool, '/migs');

    expect(result).toEqual({ applied: [], skipped: [] });
    const sqls = client.calls.map((c) => c.sql);
    expect(sqls.filter((s) => s === 'BEGIN')).toHaveLength(0);
    expect(sqls.filter((s) => s === 'COMMIT')).toHaveLength(0);
  });

  it('toate fișierele aplicate → toate sărite, fără tranzacții', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => ['001_a.sql', '002_b.sql']);
    migrate._deps.fs.readFileSync = vi.fn(() => 'SELECT 1;');
    const client = makeClient({
      appliedSeed: ['001_a.sql', '002_b.sql'],
    });
    const pool = makePool(client);

    const result = await applyMigrations(pool, '/migs');

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['001_a.sql', '002_b.sql']);
    const sqls = client.calls.map((c) => c.sql);
    expect(sqls.filter((s) => s === 'BEGIN')).toHaveLength(0);
  });
});

describe('applyMigrations — schema_migrations bootstrap', () => {
  it('creează schema_migrations dacă nu există (CREATE IF NOT EXISTS)', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => []);
    const client = makeClient({ appliedSeed: [] });
    const pool = makePool(client);

    await applyMigrations(pool, '/migs');

    const sqls = client.calls.map((c) => c.sql);
    const ddlCall = sqls.find(
      (s) => s.includes('CREATE TABLE') && s.includes('schema_migrations')
    );
    expect(ddlCall).toBeDefined();
    expect(ddlCall).toContain('IF NOT EXISTS');
  });
});

describe('applyMigrations — error path', () => {
  it('pe SQL eșuat face ROLLBACK și aruncă cu filename inclus', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => ['001_bad.sql']);
    migrate._deps.fs.readFileSync = vi.fn(() => 'SELECT FAIL_ME;');
    const client = makeClient({
      appliedSeed: [],
      failOn: 'FAIL_ME',
    });
    const pool = makePool(client);

    await expect(applyMigrations(pool, '/migs')).rejects.toThrow(
      /Migrație eșuată "001_bad\.sql"/
    );

    const sqls = client.calls.map((c) => c.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
  });

  it('NU continuă la următoarea migrație după un eșec', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => [
      '001_bad.sql',
      '002_good.sql',
    ]);
    migrate._deps.fs.readFileSync = vi.fn((fullPath) => {
      if (fullPath.includes('001_bad.sql')) return 'SELECT FAIL_ME;';
      return 'SELECT 1;';
    });
    const client = makeClient({ appliedSeed: [], failOn: 'FAIL_ME' });
    const pool = makePool(client);

    await expect(applyMigrations(pool, '/migs')).rejects.toThrow();

    // 002_good.sql nu trebuie să apară în calls
    const sqls = client.calls.map((c) => c.sql);
    expect(sqls.some((s) => s === 'SELECT 1;')).toBe(false);
  });

  it('eliberează advisory lock chiar și pe eșec', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => ['001_bad.sql']);
    migrate._deps.fs.readFileSync = vi.fn(() => 'SELECT FAIL_ME;');
    const client = makeClient({ appliedSeed: [], failOn: 'FAIL_ME' });
    const pool = makePool(client);

    await expect(applyMigrations(pool, '/migs')).rejects.toThrow();

    const sqls = client.calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
    expect(client.released).toBe(true);
  });

  it('logează eroarea cu filename înainte de a arunca', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => ['001_bad.sql']);
    migrate._deps.fs.readFileSync = vi.fn(() => 'SELECT FAIL_ME;');
    const client = makeClient({ appliedSeed: [], failOn: 'FAIL_ME' });
    const pool = makePool(client);

    await expect(applyMigrations(pool, '/migs')).rejects.toThrow();

    expect(migrate._deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ filename: '001_bad.sql' }),
      expect.stringContaining('ROLLBACK')
    );
  });
});

describe('applyMigrations — advisory lock', () => {
  it('apelează pg_advisory_lock cu lock id-ul fix înainte de orice migrație', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => ['001_a.sql']);
    migrate._deps.fs.readFileSync = vi.fn(() => 'SELECT 1;');
    const client = makeClient({ appliedSeed: [] });
    const pool = makePool(client);

    await applyMigrations(pool, '/migs');

    // Găsim indicele apelului de lock
    const lockIdx = client.calls.findIndex(
      (c) =>
        typeof c.sql === 'string' && c.sql.includes('pg_advisory_lock(')
    );
    const beginIdx = client.calls.findIndex((c) => c.sql === 'BEGIN');
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(beginIdx).toBeGreaterThan(lockIdx);

    // Verifică param-ul = MIGRATION_ADVISORY_LOCK_ID
    expect(client.calls[lockIdx].params).toEqual([
      MIGRATION_ADVISORY_LOCK_ID,
    ]);
  });

  it('eliberează lock-ul după succes', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => []);
    const client = makeClient({ appliedSeed: [] });
    const pool = makePool(client);

    await applyMigrations(pool, '/migs');

    const unlockCall = client.calls.find(
      (c) =>
        typeof c.sql === 'string' &&
        c.sql.includes('pg_advisory_unlock(')
    );
    expect(unlockCall).toBeDefined();
    expect(unlockCall.params).toEqual([MIGRATION_ADVISORY_LOCK_ID]);
  });

  it('NU eliberează lock-ul dacă acquisition-ul a eșuat', async () => {
    // Simulăm eșec la acquire — fără lock acquired, nu trebuie să apelăm unlock
    migrate._deps.fs.readdirSync = vi.fn(() => []);
    const client = makeClient({
      appliedSeed: [],
      failOn: 'pg_advisory_lock',
    });
    const pool = makePool(client);

    await expect(applyMigrations(pool, '/migs')).rejects.toThrow();

    const unlockCall = client.calls.find(
      (c) =>
        typeof c.sql === 'string' &&
        c.sql.includes('pg_advisory_unlock(')
    );
    expect(unlockCall).toBeUndefined();
    expect(client.released).toBe(true);
  });

  it('tolerează eșecul la unlock (loghează warn, nu aruncă)', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => []);
    // Construim manual un client unde unlock-ul eșuează dar restul merge
    const calls = [];
    const client = {
      calls,
      released: false,
      query: vi.fn(async (sql, params) => {
        calls.push({ sql, params });
        if (typeof sql === 'string' && sql.includes('pg_advisory_unlock')) {
          throw new Error('unlock-failed');
        }
        if (
          typeof sql === 'string' &&
          sql.includes('SELECT filename FROM schema_migrations')
        ) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: vi.fn(() => {
        client.released = true;
      }),
    };
    const pool = makePool(client);

    await expect(applyMigrations(pool, '/migs')).resolves.toBeDefined();
    expect(migrate._deps.logger.warn).toHaveBeenCalled();
    expect(client.released).toBe(true);
  });
});

describe('applyMigrations — logger', () => {
  it('logger override are prioritate față de _deps.logger', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => ['001_a.sql']);
    migrate._deps.fs.readFileSync = vi.fn(() => 'SELECT 1;');
    const client = makeClient({ appliedSeed: [] });
    const pool = makePool(client);
    const customLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await applyMigrations(pool, '/migs', customLogger);

    expect(customLogger.info).toHaveBeenCalledWith(
      { filename: '001_a.sql' },
      'Migrație aplicată'
    );
    // _deps.logger NU trebuie chemat când e override-uit
    expect(migrate._deps.logger.info).not.toHaveBeenCalled();
  });
});
