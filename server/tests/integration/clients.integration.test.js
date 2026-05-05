// Integration test pentru rutele /api/v1/clients/*.
//
// Scope:
//   - Postgres real (CI service container; skip local fără TEST_DB_CONNECTION_STRING).
//   - Schema completă tenant + shared aplicate cu migrate.js.
//   - clientService folosește pool-ul de test (override pe `_deps.getTenantPool`).
//   - anafLookupService MOCK-uit (testele nu lovesc ANAF real).
//   - authMiddleware MOCK-uit prin clientsRouter._deps — populăm req.user manual.
//     Auth-ul real e deja integration-tested în auth.integration.test.js.
//
// Goal: verificăm route + service + DB end-to-end. Curățăm DB-ul între teste
// ca să fie independente.

const path = require('node:path');

const TEST_DB = process.env.TEST_DB_CONNECTION_STRING;
const skipIfNoDb = TEST_DB ? describe : describe.skip;

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'silent');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');
vi.stubEnv(
  'FIREBASE_SERVICE_ACCOUNT_SECRET_NAME',
  'firebase-service-account-test'
);

const { Pool } = require('pg');
const request = require('supertest');

const { applyMigrations } = require('../../src/db/migrate');
const clientService = require('../../src/services/client-service');
const anafLookupService = require('../../src/services/anaf-lookup-service');
const clientsRouter = require('../../src/routes/clients');
const createApp = require('../../src/app');

const SHARED_MIGRATIONS_DIR = path.join(
  __dirname,
  '..',
  '..',
  'src',
  'db',
  'migrations',
  'shared'
);
const TENANT_MIGRATIONS_DIR = path.join(
  __dirname,
  '..',
  '..',
  'src',
  'db',
  'migrations',
  'tenant'
);

const TEST_TENANT_SLUG = 'dianex-clients-it';
const TEST_USER_ID = 1;

skipIfNoDb('clients integration', () => {
  let pool;
  let app;
  let realClientServiceDeps;
  let realAnafServiceDeps;
  let realRouterDeps;

  async function dropAll() {
    const client = await pool.connect();
    try {
      await client.query('DROP TABLE IF EXISTS public.schema_migrations CASCADE');
      await client.query('DROP SCHEMA IF EXISTS amef CASCADE');
      await client.query('DROP SCHEMA IF EXISTS amef_shared CASCADE');
    } finally {
      client.release();
    }
  }

  async function seedTenantUser() {
    // tenant_users folosit ca FK semantică pentru created_by_id (cross-DB
    // în prod, intra-DB în test setup unde rulăm shared + tenant pe aceeași
    // instanță). Inserăm un singur user de test cu id=TEST_USER_ID.
    await pool.query(
      `INSERT INTO amef_shared.tenants (slug, company_name, cui)
       VALUES ($1, 'Test Tenant', 'RO00000001') ON CONFLICT DO NOTHING`,
      [TEST_TENANT_SLUG]
    );
    const tenantRow = await pool.query(
      `SELECT id FROM amef_shared.tenants WHERE slug = $1`,
      [TEST_TENANT_SLUG]
    );
    const tenantId = tenantRow.rows[0].id;
    await pool.query(
      `INSERT INTO amef_shared.tenant_users (id, tenant_id, firebase_uid, email, role, is_active)
       VALUES ($1, $2, 'fb-clients-it', 'clients-it@test.ro', 'tenant_admin', TRUE)
       ON CONFLICT DO NOTHING`,
      [TEST_USER_ID, tenantId]
    );
    return tenantId;
  }

  async function clearClients() {
    await pool.query('TRUNCATE amef.core_clients RESTART IDENTITY CASCADE');
  }

  function buildAuthMock({ role = 'tenant_admin' } = {}) {
    return async function fakeAuth(req, _res, next) {
      req.user = {
        firebaseUid: 'fb-clients-it',
        email: 'clients-it@test.ro',
        tenantSlug: TEST_TENANT_SLUG,
        tenantId: 1,
        id: TEST_USER_ID,
        role,
        jti: 'j-it',
      };
      next();
    };
  }

  beforeAll(async () => {
    // Connection string-ul include search_path=amef ca query-urile pe
    // schema_migrations (tracking) să fie consistente cross-runs. Migrațiile
    // folosesc FQN, deci search_path-ul e doar pentru tracking + queries
    // ad-hoc din test setup.
    const url = new URL(TEST_DB);
    url.searchParams.set('options', '-c search_path=amef,public');
    pool = new Pool({ connectionString: url.toString(), max: 4 });

    await dropAll();
    await applyMigrations(pool, SHARED_MIGRATIONS_DIR, {
      schema: 'amef_shared',
    });
    await applyMigrations(pool, TENANT_MIGRATIONS_DIR, { schema: 'amef' });

    // Inject pool-ul nostru în clientService (override pe _deps.getTenantPool).
    realClientServiceDeps = { ...clientService._deps };
    clientService._deps.getTenantPool = async () => pool;

    // Mock anafLookupService.lookupByCui ca să nu lovim ANAF.
    realAnafServiceDeps = { ...anafLookupService._deps };

    // Mock authMiddleware în router ca să sărim peste JWT real.
    realRouterDeps = { ...clientsRouter._deps };
    clientsRouter._deps.authMiddleware = buildAuthMock({ role: 'tenant_admin' });

    app = createApp();

    // Seed tenant + user după ce app e construit (independent de aplicare
    // migrații, ON CONFLICT DO NOTHING pentru re-rulare locală).
    await seedTenantUser();
  });

  afterAll(async () => {
    if (clientService && realClientServiceDeps) {
      Object.assign(clientService._deps, realClientServiceDeps);
    }
    if (anafLookupService && realAnafServiceDeps) {
      Object.assign(anafLookupService._deps, realAnafServiceDeps);
    }
    if (clientsRouter && realRouterDeps) {
      Object.assign(clientsRouter._deps, realRouterDeps);
    }
    if (pool) {
      await dropAll().catch(() => {});
      await pool.end();
    }
  });

  beforeEach(async () => {
    await clearClients();
    // Restaurează auth la tenant_admin default; teste individuale pot suprascrie.
    clientsRouter._deps.authMiddleware = buildAuthMock({ role: 'tenant_admin' });
    // Re-mock anafLookupService la default (fiecare test setează propriile
    // răspunsuri / erori).
    anafLookupService._deps.httpClient = vi.fn();
  });

  // Helper: creează un client direct via SQL (bypass route) pentru setup-uri
  // de teste GET/PUT/DELETE care presupun existența unui rând.
  async function insertClientDirect(overrides = {}) {
    const data = {
      fiscal_code: 'RO12345678',
      fiscal_code_type: 'CUI',
      company_name: 'Test SRL',
      county: 'București',
      city: 'București',
      street: 'Str. Exemplu',
      street_number: '12',
      phone: '+40700000000',
      representative_role_id: 1,
      representative_name: 'Ion Popescu',
      representative_ci_number: '123456',
      representative_ci_issued_by: 'SPCLEP',
      representative_ci_issued_at: '2020-01-15',
      representative_county: 'București',
      representative_city: 'București',
      representative_street: 'Str. Reprezentant',
      representative_street_number: '5',
      created_by_id: TEST_USER_ID,
      ...overrides,
    };
    const cols = Object.keys(data);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `INSERT INTO amef.core_clients (${cols.join(', ')})
       VALUES (${placeholders}) RETURNING *`,
      cols.map((c) => data[c])
    );
    return result.rows[0];
  }

  // Body valid pentru POST /clients — trecut prin Zod-ul service-ului.
  const validCreateBody = {
    fiscal_code_type: 'CUI',
    fiscal_code: 'RO87654321',
    company_name: 'New SRL',
    county: 'Cluj',
    city: 'Cluj-Napoca',
    street: 'Str. Memorandumului',
    street_number: '1',
    phone: '+40711222333',
    email: 'contact@newsrl.ro',
    representative_role_id: 1,
    representative_name: 'Maria Ionescu',
    representative_ci_number: '654321',
    representative_ci_issued_by: 'SPCLEP Cluj',
    representative_ci_issued_at: '2019-06-15',
    representative_county: 'Cluj',
    representative_city: 'Cluj-Napoca',
    representative_street: 'Str. Memorandumului',
    representative_street_number: '1',
  };

  // ─────────────────────────────────────────────────────────────────────
  // GET /clients
  // ─────────────────────────────────────────────────────────────────────

  describe('GET /clients', () => {
    it('listă goală → 200 { rows: [], total: 0 }', async () => {
      const res = await request(app).get('/api/v1/clients');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.rows).toEqual([]);
      expect(res.body.data.total).toBe(0);
    });

    it('cu clienți seedați → 200 cu rândurile + total', async () => {
      await insertClientDirect();
      await insertClientDirect({ fiscal_code: 'RO22222222', company_name: 'Alt SRL' });

      const res = await request(app).get('/api/v1/clients');
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.rows).toHaveLength(2);
    });

    it('search filter → returnează doar matching company_name', async () => {
      await insertClientDirect({ fiscal_code: 'RO11111111', company_name: 'Dianex SRL' });
      await insertClientDirect({ fiscal_code: 'RO22222222', company_name: 'Other Co' });

      const res = await request(app).get('/api/v1/clients?search=Dianex');
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.rows[0].company_name).toBe('Dianex SRL');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // POST /clients
  // ─────────────────────────────────────────────────────────────────────

  describe('POST /clients', () => {
    it('body valid → 201 + rândul există în DB', async () => {
      const res = await request(app).post('/api/v1/clients').send(validCreateBody);
      expect(res.status).toBe(201);
      expect(res.body.data.fiscal_code).toBe('RO87654321');
      expect(res.body.data.created_by_id).toBe(TEST_USER_ID);

      const dbRow = await pool.query(
        `SELECT * FROM amef.core_clients WHERE fiscal_code = $1`,
        ['RO87654321']
      );
      expect(dbRow.rows).toHaveLength(1);
    });

    it('fiscal_code duplicat → 409 FISCAL_CODE_DUPLICATE', async () => {
      await insertClientDirect({ fiscal_code: 'RO87654321' });
      const res = await request(app).post('/api/v1/clients').send(validCreateBody);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('FISCAL_CODE_DUPLICATE');
    });

    it('email duplicat → 409 EMAIL_DUPLICATE', async () => {
      await insertClientDirect({
        fiscal_code: 'RO99999999',
        email: 'dup@test.ro',
      });
      const res = await request(app)
        .post('/api/v1/clients')
        .send({ ...validCreateBody, email: 'dup@test.ro' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EMAIL_DUPLICATE');
    });

    it('phone ȘI email lipsesc → 400 ZodError pe path phone', async () => {
      const body = { ...validCreateBody };
      delete body.phone;
      delete body.email;
      const res = await request(app).post('/api/v1/clients').send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // GET /clients/:id
  // ─────────────────────────────────────────────────────────────────────

  describe('GET /clients/:id', () => {
    it('existent → 200', async () => {
      const inserted = await insertClientDirect();
      const res = await request(app).get(`/api/v1/clients/${inserted.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(inserted.id);
    });

    it('inexistent → 404', async () => {
      const res = await request(app).get('/api/v1/clients/999999');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // PUT /clients/:id
  // ─────────────────────────────────────────────────────────────────────

  describe('PUT /clients/:id', () => {
    it('partial update → 200 + DB reflectă schimbarea', async () => {
      const inserted = await insertClientDirect();
      const res = await request(app)
        .put(`/api/v1/clients/${inserted.id}`)
        .send({ phone: '+40799999999' });
      expect(res.status).toBe(200);
      expect(res.body.data.phone).toBe('+40799999999');

      const dbRow = await pool.query(
        `SELECT phone FROM amef.core_clients WHERE id = $1`,
        [inserted.id]
      );
      expect(dbRow.rows[0].phone).toBe('+40799999999');
    });

    it('inexistent → 404', async () => {
      const res = await request(app)
        .put('/api/v1/clients/999999')
        .send({ phone: '+40700000000' });
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // DELETE /clients/:id
  // ─────────────────────────────────────────────────────────────────────

  describe('DELETE /clients/:id', () => {
    it('tenant_admin → 200 + deleted_at setat în DB', async () => {
      const inserted = await insertClientDirect();
      const res = await request(app).delete(`/api/v1/clients/${inserted.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.deleted_at).toBeDefined();

      const dbRow = await pool.query(
        `SELECT deleted_at FROM amef.core_clients WHERE id = $1`,
        [inserted.id]
      );
      expect(dbRow.rows[0].deleted_at).not.toBeNull();
    });

    it('tenant_user → 403', async () => {
      const inserted = await insertClientDirect({ fiscal_code: 'RO77777777' });
      // Suprascriem auth la tenant_user pentru ACEST test.
      clientsRouter._deps.authMiddleware = buildAuthMock({ role: 'tenant_user' });
      const res = await request(app).delete(`/api/v1/clients/${inserted.id}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('deja șters → 404', async () => {
      const inserted = await insertClientDirect();
      // Soft-delete direct via SQL ca să simulăm starea „deja șters".
      await pool.query(
        `UPDATE amef.core_clients SET deleted_at = NOW() WHERE id = $1`,
        [inserted.id]
      );
      const res = await request(app).delete(`/api/v1/clients/${inserted.id}`);
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // POST /clients/lookup-by-cui
  // ─────────────────────────────────────────────────────────────────────

  describe('POST /clients/lookup-by-cui', () => {
    it('mock service returnează date → 200', async () => {
      // Mock răspunsul ANAF la nivelul httpClient — service-ul îl mapează.
      anafLookupService._deps.httpClient = vi.fn().mockResolvedValue({
        data: {
          cod: 200,
          message: 'SUCCES',
          found: [
            {
              date_generale: {
                cui: 1234567,
                data: '2026-05-05',
                denumire: 'EXAMPLE SRL',
                adresa: 'STR. EXAMPLE',
                nrRegCom: 'J40/123/2020',
                cod_CAEN: '6201',
                data_inregistrare: '2020-01-15',
              },
              inregistrare_scop_Tva: { scpTVA: true },
              stare_inactiv: { statusInactivi: false },
              inregistrare_SplitTVA: { statusSplitTVA: false },
            },
          ],
          notFound: [],
        },
      });
      anafLookupService._clearCache();

      const res = await request(app)
        .post('/api/v1/clients/lookup-by-cui')
        .send({ cui: 'RO1234567', referenceDate: '2026-05-05' });
      expect(res.status).toBe(200);
      expect(res.body.data.denumire).toBe('EXAMPLE SRL');
      expect(res.body.data.is_vat_payer).toBe(true);
    });

    it('mock service returnează notFound → 404', async () => {
      anafLookupService._deps.httpClient = vi.fn().mockResolvedValue({
        data: { cod: 200, message: 'SUCCES', found: [], notFound: [9999999] },
      });
      anafLookupService._clearCache();

      const res = await request(app)
        .post('/api/v1/clients/lookup-by-cui')
        .send({ cui: '9999999', referenceDate: '2026-05-05' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('CUI_NOT_FOUND_AT_ANAF');
    });

    it('mock service eșuează (ANAF jos, fără cache) → 503', async () => {
      const err500 = new Error('ANAF down');
      err500.response = { status: 500 };
      anafLookupService._deps.httpClient = vi
        .fn()
        .mockRejectedValue(err500);
      anafLookupService._clearCache();

      const res = await request(app)
        .post('/api/v1/clients/lookup-by-cui')
        .send({ cui: '5555555', referenceDate: '2026-05-05' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('ANAF_UNAVAILABLE');
    }, 30000); // mărit timeout-ul: 3 retries cu backoff exponențial pot dura ~6-7s
  });
});
