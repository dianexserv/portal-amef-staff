// Integration test pentru fluxul auth: /firebase-login → /refresh → /logout.
//   - Folosește un Postgres real (CI service container) pentru
//     amef_shared.tenant_users și amef_shared.tenants.
//   - MOCK-uim Firebase via authService._deps.verifyIdToken (nu lovim
//     Firebase real). JWT-urile noastre sunt SEMNATE/VERIFICATE real
//     (cu un secret stub din getSecret).
//   - Skip dacă TEST_DB_CONNECTION_STRING nu e setat — devs locali pot
//     rula `pnpm test:run` fără DB; CI îl injectează.
//
// Setup per-test: ștergem și re-seedăm un tenant + tenant_user. Fluxul
// real bate prin createApp() complet — verificăm middleware-ele
// (helmet/cors/json/rate-limit/auth) end-to-end.

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
vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_SECRET_NAME', 'firebase-service-account-test');

const { Pool } = require('pg');
const request = require('supertest');

const { applyMigrations } = require('../../src/db/migrate');
const authService = require('../../src/services/auth-service');
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

const TEST_TENANT_SLUG = 'dianex-auth-it';
const TEST_TENANT_NAME = 'Test Tenant Auth';
const TEST_CUI = 'RO00000000';
const TEST_FIREBASE_UID = 'firebase-uid-auth-it-1';
const TEST_EMAIL = 'auth-it@dianex-test.ro';

const TEST_JWT_SECRET = 'integration-test-secret-with-enough-bytes-for-hs256';

skipIfNoDb('auth integration', () => {
  let pool;
  let app;
  let realDeps;

  async function dropAll() {
    const client = await pool.connect();
    try {
      await client.query('DROP SCHEMA IF EXISTS amef_shared CASCADE');
      await client.query(
        'DROP TABLE IF EXISTS public.schema_migrations CASCADE'
      );
    } finally {
      client.release();
    }
  }

  async function seedTenantAndUser({ role = 'tenant_admin', isActive = true } = {}) {
    const tRes = await pool.query(
      `INSERT INTO amef_shared.tenants (slug, company_name, cui)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [TEST_TENANT_SLUG, TEST_TENANT_NAME, TEST_CUI]
    );
    const tenantId = tRes.rows[0].id;
    await pool.query(
      `INSERT INTO amef_shared.tenant_users
         (tenant_id, firebase_uid, email, role, is_active)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, TEST_FIREBASE_UID, TEST_EMAIL, role, isActive]
    );
    return tenantId;
  }

  async function clearUsersAndTenants() {
    await pool.query('DELETE FROM amef_shared.tenant_users');
    await pool.query('DELETE FROM amef_shared.tenants');
  }

  beforeAll(async () => {
    const url = new URL(TEST_DB);
    url.searchParams.set('options', '-c search_path=amef_shared,public');
    pool = new Pool({ connectionString: url.toString(), max: 4 });
    await dropAll();
    await applyMigrations(pool, SHARED_MIGRATIONS_DIR, {
      schema: 'amef_shared',
    });

    // Salvăm dependențele reale și injectăm pool-ul + getSecret-ul de test
    // în authService. App-ul folosește același singleton authService prin
    // require, deci modificările pe `_deps` sunt vizibile end-to-end.
    realDeps = { ...authService._deps };
    authService._deps.pool = {
      getSharedPool: async () => pool,
    };
    authService._deps.getSecret = async (name) => {
      if (name === 'jwt-secret-test') return TEST_JWT_SECRET;
      if (name === 'firebase-service-account-test') {
        return JSON.stringify({ project_id: 'fake', private_key: 'fake' });
      }
      return 'unused';
    };

    app = createApp();
  });

  afterAll(async () => {
    if (authService && realDeps) {
      Object.assign(authService._deps, realDeps);
    }
    if (pool) {
      await dropAll().catch(() => {});
      await pool.end();
    }
  });

  beforeEach(async () => {
    await clearUsersAndTenants();
    // Default: token Firebase valid, user activ cu MFA. Per-test override-uim.
    authService._deps.verifyIdToken = vi.fn().mockResolvedValue({
      uid: TEST_FIREBASE_UID,
      email: TEST_EMAIL,
      firebase: { sign_in_second_factor: 'totp' },
    });
  });

  describe('POST /api/v1/auth/firebase-login', () => {
    it('Firebase token valid + user în tenant_users → 200 cu jwt + refresh', async () => {
      await seedTenantAndUser();
      const res = await request(app)
        .post('/api/v1/auth/firebase-login')
        .send({ idToken: 'fake-firebase-id-token' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.jwt).toBe('string');
      expect(typeof res.body.data.refreshToken).toBe('string');
      expect(typeof res.body.data.expiresAt).toBe('number');
      expect(res.body.data.user).toEqual({
        email: TEST_EMAIL,
        role: 'tenant_admin',
        tenantSlug: TEST_TENANT_SLUG,
      });
    });

    it('Firebase token invalid → 401', async () => {
      await seedTenantAndUser();
      authService._deps.verifyIdToken = vi
        .fn()
        .mockRejectedValue(new Error('id-token-revoked'));
      const res = await request(app)
        .post('/api/v1/auth/firebase-login')
        .send({ idToken: 'fake-invalid' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('user nu e în tenant_users → 403 cu mesaj de admin', async () => {
      // Nu seed-uim user — DB-ul e curat.
      const res = await request(app)
        .post('/api/v1/auth/firebase-login')
        .send({ idToken: 'fake-firebase-id-token' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(res.body.error).toMatch(/Contactează un admin/);
    });

    it('user există dar is_active=false → 403 "dezactivat"', async () => {
      await seedTenantAndUser({ isActive: false });
      const res = await request(app)
        .post('/api/v1/auth/firebase-login')
        .send({ idToken: 'fake-firebase-id-token' });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/dezactivat/);
    });

    it('body fără idToken → 400 (Zod validation)', async () => {
      const res = await request(app)
        .post('/api/v1/auth/firebase-login')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('idToken prea scurt → 400', async () => {
      const res = await request(app)
        .post('/api/v1/auth/firebase-login')
        .send({ idToken: 'short' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    async function loginAndGetTokens() {
      await seedTenantAndUser();
      const res = await request(app)
        .post('/api/v1/auth/firebase-login')
        .send({ idToken: 'fake-firebase-id-token' });
      expect(res.status).toBe(200);
      return { jwt: res.body.data.jwt, refreshToken: res.body.data.refreshToken };
    }

    it('refresh token valid → 200 cu tokens noi', async () => {
      const tokens = await loginAndGetTokens();
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokens.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.jwt).toBe('string');
      expect(typeof res.body.data.refreshToken).toBe('string');
      // Token-ul nou trebuie să fie diferit de cel vechi (jti diferit garantat)
      expect(res.body.data.refreshToken).not.toBe(tokens.refreshToken);
      expect(res.body.data.jwt).not.toBe(tokens.jwt);
    });

    it('access token folosit ca refresh → 401 (tip greșit)', async () => {
      const tokens = await loginAndGetTokens();
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokens.jwt }); // intenționat folosim access

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
      expect(res.body.error).toMatch(/refresh token/i);
    });

    it('refresh token invalid (semnătură stricată) → 401', async () => {
      const tokens = await loginAndGetTokens();
      const tampered = tokens.refreshToken.slice(0, -3) + 'AAA';
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tampered });

      expect(res.status).toBe(401);
    });

    it('body fără refreshToken → 400', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rolul actualizat în DB e reflectat în noul token', async () => {
      await seedTenantAndUser({ role: 'tenant_user' });
      const loginRes = await request(app)
        .post('/api/v1/auth/firebase-login')
        .send({ idToken: 'fake-firebase-id-token' });
      expect(loginRes.body.data.user.role).toBe('tenant_user');
      const oldRefresh = loginRes.body.data.refreshToken;

      // Promovăm user-ul la tenant_admin în DB
      await pool.query(
        `UPDATE amef_shared.tenant_users SET role = 'tenant_admin'
         WHERE firebase_uid = $1`,
        [TEST_FIREBASE_UID]
      );

      const refreshRes = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: oldRefresh });
      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.data.user.role).toBe('tenant_admin');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('cu JWT valid → 200', async () => {
      await seedTenantAndUser();
      const loginRes = await request(app)
        .post('/api/v1/auth/firebase-login')
        .send({ idToken: 'fake-firebase-id-token' });
      const jwt = loginRes.body.data.jwt;

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${jwt}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('fără auth header → 401', async () => {
      const res = await request(app).post('/api/v1/auth/logout');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('cu refresh token în loc de access → 401', async () => {
      await seedTenantAndUser();
      const loginRes = await request(app)
        .post('/api/v1/auth/firebase-login')
        .send({ idToken: 'fake-firebase-id-token' });
      const refresh = loginRes.body.data.refreshToken;

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${refresh}`);

      expect(res.status).toBe(401);
    });
  });
});
