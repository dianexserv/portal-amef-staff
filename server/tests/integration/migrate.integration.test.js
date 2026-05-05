// Integration test pentru runner-ul de migrații — folosește un Postgres real
// (CI-ul îl pornește ca service container). Local skipăm dacă variabila
// `TEST_DB_CONNECTION_STRING` nu e setată, ca dezvoltatorii să poată rula
// `pnpm test:run` fără un Postgres local.
//
// Validări end-to-end:
//   - schema_migrations e creată automat pe DB curat
//   - aplicarea efectivă a SQL-ului din 001_init_shared.sql se face cu succes
//   - re-rularea sare peste fișierele aplicate
//   - SQL invalid produce ROLLBACK fără side-effects parțiale
//   - advisory lock-ul previne aplicarea concurentă (al doilea client așteaptă)
//
// IMPORTANT: testele lucrează DOAR pe `TEST_DB_CONNECTION_STRING`. Curățăm
// `schema_migrations` și schemele AMEF înainte/după fiecare test ca să fie
// independente. NU rula împotriva unui DB cu date reale.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Pool } = require('pg');

const TEST_DB = process.env.TEST_DB_CONNECTION_STRING;
const skipIfNoDb = TEST_DB ? describe : describe.skip;

// Setup env minim pentru ca importul migrate.js (care pull-uie config + logger)
// să nu arunce. Toate valorile sunt false pentru testare unitară.
vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'silent');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');

const { applyMigrations } = require('../../src/db/migrate');

const SHARED_MIGRATIONS_DIR = path.join(
  __dirname,
  '..',
  '..',
  'src',
  'db',
  'migrations',
  'shared'
);

// Toate testele integration vizează DB-ul shared — schema-ul e pasat EXPLICIT
// la applyMigrations ca tracking-ul (`schema_migrations`) să nu depindă de
// search_path-ul curent (care poate fi mutat de migrațiile-utilizator).
const SHARED_OPTS = { schema: 'amef_shared' };

skipIfNoDb('migrate (integration, real Postgres)', () => {
  let pool;

  async function dropAll() {
    const client = await pool.connect();
    try {
      // Curățăm tot ce ar putea exista de la o rulare anterioară.
      // Ordinea: schema_migrations din ambele search_path-uri posibile,
      // apoi schemele cu CASCADE.
      await client.query('DROP TABLE IF EXISTS public.schema_migrations CASCADE');
      await client
        .query('DROP TABLE IF EXISTS amef_shared.schema_migrations CASCADE')
        .catch(() => {});
      await client
        .query('DROP TABLE IF EXISTS amef.schema_migrations CASCADE')
        .catch(() => {});
      await client.query('DROP SCHEMA IF EXISTS amef_shared CASCADE');
      await client.query('DROP SCHEMA IF EXISTS amef CASCADE');
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    const url = new URL(TEST_DB);
    // Search_path setat in connection string -> aplicat de Postgres INAINTE de
    // orice query, eliminand race condition-ul cu SET asincron din on('connect').
    url.searchParams.set('options', '-c search_path=amef_shared,public');
    pool = new Pool({ connectionString: url.toString(), max: 4 });
  });

  afterAll(async () => {
    if (pool) {
      await dropAll().catch(() => {});
      await pool.end();
    }
  });

  beforeEach(async () => {
    await dropAll();
  });

  it('pe DB curat creează schema_migrations + aplică toate fișierele shared', async () => {
    const result = await applyMigrations(pool, SHARED_MIGRATIONS_DIR, SHARED_OPTS);

    expect(result.applied).toContain('001_init_shared.sql');
    expect(result.skipped).toEqual([]);

    // schema_migrations are rândul corespunzător — interogăm cu schema EXPLICITĂ
    // ca să nu depindem de search_path-ul curent (care poate fi schimbat de
    // migrațiile rulate).
    const { rows } = await pool.query(
      'SELECT filename FROM amef_shared.schema_migrations ORDER BY filename'
    );
    expect(rows.map((r) => r.filename)).toEqual(result.applied);

    // Tabelele reale există
    const { rows: tables } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'amef_shared'
       ORDER BY table_name`
    );
    const names = tables.map((r) => r.table_name);
    expect(names).toContain('tenants');
    expect(names).toContain('tenant_users');
    expect(names).toContain('audit_log_global');
  });

  it('a doua rulare sare peste 001 (idempotent)', async () => {
    await applyMigrations(pool, SHARED_MIGRATIONS_DIR, SHARED_OPTS);
    const second = await applyMigrations(pool, SHARED_MIGRATIONS_DIR, SHARED_OPTS);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('001_init_shared.sql');
  });

  it('aplică o nouă migrație 002 dintr-un director temporar (simulare 002)', async () => {
    // Folosim un director temporar care conține și 001 real (copiat) + un 002 fixture.
    // Asta exersează drumul „aplică doar ce-i nou, sare peste ce-i deja aplicat".
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amef-mig-'));
    try {
      fs.copyFileSync(
        path.join(SHARED_MIGRATIONS_DIR, '001_init_shared.sql'),
        path.join(tmp, '001_init_shared.sql')
      );
      fs.writeFileSync(
        path.join(tmp, '002_test_marker.sql'),
        // Adăugăm o coloană în tenants pentru a verifica că SQL-ul rulează
        'ALTER TABLE amef_shared.tenants ADD COLUMN IF NOT EXISTS test_marker TEXT;'
      );

      // Prima rulare aplică 001
      const first = await applyMigrations(pool, tmp, SHARED_OPTS);
      expect(first.applied).toContain('001_init_shared.sql');
      expect(first.applied).toContain('002_test_marker.sql');

      // A doua rulare le sare pe ambele
      const second = await applyMigrations(pool, tmp, SHARED_OPTS);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(
        expect.arrayContaining(['001_init_shared.sql', '002_test_marker.sql'])
      );

      // Coloana există
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'amef_shared'
           AND table_name = 'tenants'
           AND column_name = 'test_marker'`
      );
      expect(rows).toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('SQL invalid → aruncă, ROLLBACK, niciun efect parțial', async () => {
    // Aplicăm întâi 001 ca să avem schema
    await applyMigrations(pool, SHARED_MIGRATIONS_DIR, SHARED_OPTS);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amef-mig-bad-'));
    try {
      fs.writeFileSync(
        path.join(tmp, '999_broken.sql'),
        // Două statement-uri: prima merge, a doua e invalidă. ROLLBACK trebuie
        // să șteargă efectul primei, ca tranzacția să fie tot-sau-nimic.
        `CREATE TABLE amef_shared.partial_table (id INT);
         THIS_IS_NOT_SQL;`
      );
      await expect(applyMigrations(pool, tmp, SHARED_OPTS)).rejects.toThrow(
        /Migrație eșuată "999_broken\.sql"/
      );

      // Tabela parțială NU trebuie să existe (ROLLBACK)
      const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'amef_shared' AND table_name = 'partial_table'`
      );
      expect(rows).toHaveLength(0);

      // 999 NU e marcat ca aplicat — interogăm cu schema EXPLICITĂ
      const { rows: applied } = await pool.query(
        "SELECT filename FROM amef_shared.schema_migrations WHERE filename = '999_broken.sql'"
      );
      expect(applied).toHaveLength(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('aplicări concurente — advisory lock serializează, niciuna nu aplică dublu', async () => {
    // Lansăm două applyMigrations în paralel pe același pool. Lock-ul
    // pg_advisory_lock pe aceeași conexiune e re-entrant, dar pe conexiuni
    // diferite (pool acordă conexiuni separate) e mutually exclusive.
    // Așteptăm ca după ambele să avem un singur rând în schema_migrations
    // pentru 001.
    const [a, b] = await Promise.all([
      applyMigrations(pool, SHARED_MIGRATIONS_DIR, SHARED_OPTS),
      applyMigrations(pool, SHARED_MIGRATIONS_DIR, SHARED_OPTS),
    ]);

    const totalApplied = [...a.applied, ...b.applied].filter(
      (f) => f === '001_init_shared.sql'
    );
    // Exact un singur applyMigrations a aplicat 001; celălalt l-a sărit.
    expect(totalApplied).toHaveLength(1);

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS c FROM amef_shared.schema_migrations WHERE filename = '001_init_shared.sql'"
    );
    expect(rows[0].c).toBe(1);
  });
});
