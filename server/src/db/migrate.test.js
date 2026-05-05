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

const migrate = require('./migrate');
const {
  applyMigrations,
  listMigrationFiles,
  listAppliedMigrations,
  MIGRATION_ADVISORY_LOCK_ID,
} = migrate;

const realDeps = { ...migrate._deps };

// Toate testele care nu testează rezolvarea default a schemei trec un schema
// explicit ca să imite uzul real (CLI / app code). 'amef' e o alegere
// arbitrară — pentru mock pool nu contează valoarea, doar prefix-ul în SQL.
const TEST_OPTS = { schema: 'amef' };

// Helper: fabrică un client fals care înregistrează toate query-urile.
// `appliedSeed` controlează ce returnează SELECT-ul pe schema_migrations.
// `defaultSchema` controlează ce returnează SELECT current_schemas(false)[1].
function makeClient({
  appliedSeed = [],
  failOn = null,
  defaultSchema = 'amef',
} = {}) {
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
      // Default-schema lookup
      if (typeof sql === 'string' && sql.includes('current_schemas(false)')) {
        return { rows: [{ schema: defaultSchema }] };
      }
      // SELECT-ul de schema_migrations returnează seed-ul
      if (
        typeof sql === 'string' &&
        sql.includes('SELECT filename') &&
        sql.includes('schema_migrations')
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
  it('interoghează schema_migrations cu schema explicită', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ filename: '001_a.sql' }, { filename: '002_b.sql' }],
      }),
    };
    const result = await listAppliedMigrations(pool, 'amef_shared');
    expect(result).toEqual(['001_a.sql', '002_b.sql']);
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT filename FROM "amef_shared".schema_migrations ORDER BY filename ASC'
    );
  });

  it('respinge schema name invalid', async () => {
    const pool = { query: vi.fn() };
    await expect(
      listAppliedMigrations(pool, 'amef"; DROP TABLE--')
    ).rejects.toThrow(/Numele schemei invalid/);
    expect(pool.query).not.toHaveBeenCalled();
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

    const result = await applyMigrations(pool, '/migs', TEST_OPTS);

    expect(result.applied).toEqual(['001_a.sql', '002_b.sql']);
    expect(result.skipped).toEqual([]);

    // Secvența esențială (în această ordine): pg_advisory_lock, CREATE SCHEMA,
    // CREATE TABLE schema_migrations, SELECT filename..., BEGIN, SQL, INSERT,
    // COMMIT (× 2 migrații), pg_advisory_unlock.
    const sqls = client.calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('pg_advisory_lock'))).toBe(true);
    expect(sqls.some((s) => s.includes('CREATE SCHEMA IF NOT EXISTS "amef"'))).toBe(true);
    expect(sqls.some((s) => s.includes('"amef".schema_migrations'))).toBe(true);
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

    const result = await applyMigrations(pool, '/migs', TEST_OPTS);

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

    const result = await applyMigrations(pool, '/migs', TEST_OPTS);

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

    const result = await applyMigrations(pool, '/migs', TEST_OPTS);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['001_a.sql', '002_b.sql']);
    const sqls = client.calls.map((c) => c.sql);
    expect(sqls.filter((s) => s === 'BEGIN')).toHaveLength(0);
  });
});

describe('applyMigrations — schema explicit vs default', () => {
  it('creează schema_migrations dacă nu există (CREATE IF NOT EXISTS)', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => []);
    const client = makeClient({ appliedSeed: [] });
    const pool = makePool(client);

    await applyMigrations(pool, '/migs', TEST_OPTS);

    const sqls = client.calls.map((c) => c.sql);
    const ddlCall = sqls.find(
      (s) => s.includes('CREATE TABLE') && s.includes('schema_migrations')
    );
    expect(ddlCall).toBeDefined();
    expect(ddlCall).toContain('IF NOT EXISTS');
  });

  it('creează schema_migrations în schema explicită, nu default', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => []);
    const client = makeClient({ appliedSeed: [] });
    const pool = makePool(client);

    await applyMigrations(pool, '/migs', { schema: 'custom_x' });

    const sqls = client.calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('"custom_x".schema_migrations'))).toBe(true);
    expect(sqls.some((s) => s.includes('CREATE SCHEMA IF NOT EXISTS "custom_x"'))).toBe(true);
    // Nu trebuie să atingă alte schema-uri
    expect(sqls.some((s) => s.includes('"amef".schema_migrations'))).toBe(false);
    expect(sqls.some((s) => s.includes('"amef_shared".schema_migrations'))).toBe(false);
    // Default-ul (current_schemas) nu e interogat când schema e furnizată
    expect(sqls.some((s) => s.includes('current_schemas'))).toBe(false);
  });

  it('când schema NU e furnizată, citește prima schema din search_path', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => []);
    const client = makeClient({
      appliedSeed: [],
      defaultSchema: 'amef_shared',
    });
    const pool = makePool(client);

    await applyMigrations(pool, '/migs');

    const sqls = client.calls.map((c) => c.sql);
    // current_schemas a fost interogat
    expect(sqls.some((s) => s.includes('current_schemas(false)'))).toBe(true);
    // Schema rezolvată e folosită în CREATE TABLE
    expect(sqls.some((s) => s.includes('"amef_shared".schema_migrations'))).toBe(true);
  });

  it('aruncă dacă search_path-ul e gol și nu s-a furnizat schema', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => []);
    const client = makeClient({ appliedSeed: [], defaultSchema: null });
    const pool = makePool(client);

    await expect(applyMigrations(pool, '/migs')).rejects.toThrow(
      /search_path.*gol sau invalid/
    );
    // Client trebuie eliberat chiar dacă rezolvarea schemei eșuează
    expect(client.released).toBe(true);
  });

  it('respinge schema name with invalid characters (SQL injection)', async () => {
    const client = makeClient({ appliedSeed: [] });
    const pool = makePool(client);

    await expect(
      applyMigrations(pool, '/migs', { schema: 'amef"; DROP TABLE foo --' })
    ).rejects.toThrow(/Numele schemei invalid/);
    // Validare sync — nu trebuie să acquire connection deloc
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('respinge schema name cu majuscule sau spații', async () => {
    const client = makeClient({ appliedSeed: [] });
    const pool = makePool(client);

    await expect(
      applyMigrations(pool, '/migs', { schema: 'Amef' })
    ).rejects.toThrow(/Numele schemei invalid/);
    await expect(
      applyMigrations(pool, '/migs', { schema: 'amef shared' })
    ).rejects.toThrow(/Numele schemei invalid/);
    await expect(
      applyMigrations(pool, '/migs', { schema: '' })
    ).rejects.toThrow(/Numele schemei invalid/);
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

    await expect(applyMigrations(pool, '/migs', TEST_OPTS)).rejects.toThrow(
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

    await expect(applyMigrations(pool, '/migs', TEST_OPTS)).rejects.toThrow();

    // 002_good.sql nu trebuie să apară în calls
    const sqls = client.calls.map((c) => c.sql);
    expect(sqls.some((s) => s === 'SELECT 1;')).toBe(false);
  });

  it('eliberează advisory lock chiar și pe eșec', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => ['001_bad.sql']);
    migrate._deps.fs.readFileSync = vi.fn(() => 'SELECT FAIL_ME;');
    const client = makeClient({ appliedSeed: [], failOn: 'FAIL_ME' });
    const pool = makePool(client);

    await expect(applyMigrations(pool, '/migs', TEST_OPTS)).rejects.toThrow();

    const sqls = client.calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
    expect(client.released).toBe(true);
  });

  it('logează eroarea cu filename înainte de a arunca', async () => {
    migrate._deps.fs.readdirSync = vi.fn(() => ['001_bad.sql']);
    migrate._deps.fs.readFileSync = vi.fn(() => 'SELECT FAIL_ME;');
    const client = makeClient({ appliedSeed: [], failOn: 'FAIL_ME' });
    const pool = makePool(client);

    await expect(applyMigrations(pool, '/migs', TEST_OPTS)).rejects.toThrow();

    expect(migrate._deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: '001_bad.sql',
        schema: 'amef',
      }),
      expect.stringContaining('ROLLBACK')
    );
  });
});

describe('applyMigrations — advisory lock', () => {
  it('apelează pg_advisory_lock ÎNAINTE de orice DDL și de orice migrație', async () => {
    // Ordinea contează: `CREATE TABLE IF NOT EXISTS` din Postgres NU e atomic
    // împotriva DDL-ului concurent — două instanțe care pornesc simultan pot
    // amândouă trece IF NOT EXISTS și apoi una eșuează cu duplicate-key pe
    // pg_type_typname_nsp_index. Lock-ul trebuie acquired înainte de
    // bootstrap-ul schemei, nu doar înainte de tranzacții.
    migrate._deps.fs.readdirSync = vi.fn(() => ['001_a.sql']);
    migrate._deps.fs.readFileSync = vi.fn(() => 'SELECT 1;');
    const client = makeClient({ appliedSeed: [] });
    const pool = makePool(client);

    await applyMigrations(pool, '/migs', TEST_OPTS);

    const lockIdx = client.calls.findIndex(
      (c) =>
        typeof c.sql === 'string' && c.sql.includes('pg_advisory_lock(')
    );
    const createSchemaIdx = client.calls.findIndex(
      (c) =>
        typeof c.sql === 'string' &&
        c.sql.includes('CREATE SCHEMA IF NOT EXISTS')
    );
    const createTableIdx = client.calls.findIndex(
      (c) =>
        typeof c.sql === 'string' &&
        c.sql.includes('CREATE TABLE IF NOT EXISTS') &&
        c.sql.includes('schema_migrations')
    );
    const beginIdx = client.calls.findIndex((c) => c.sql === 'BEGIN');

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    // Lock-ul vine înainte de TOATE: CREATE SCHEMA, CREATE TABLE, BEGIN.
    expect(createSchemaIdx).toBeGreaterThan(lockIdx);
    expect(createTableIdx).toBeGreaterThan(lockIdx);
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

    await applyMigrations(pool, '/migs', TEST_OPTS);

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

    await expect(applyMigrations(pool, '/migs', TEST_OPTS)).rejects.toThrow();

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
          sql.includes('SELECT filename') &&
          sql.includes('schema_migrations')
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

    await expect(
      applyMigrations(pool, '/migs', TEST_OPTS)
    ).resolves.toBeDefined();
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

    await applyMigrations(pool, '/migs', {
      schema: 'amef',
      logger: customLogger,
    });

    expect(customLogger.info).toHaveBeenCalledWith(
      { filename: '001_a.sql', schema: 'amef' },
      'Migrație aplicată'
    );
    // _deps.logger NU trebuie chemat când e override-uit
    expect(migrate._deps.logger.info).not.toHaveBeenCalled();
  });
});
