// Unit tests pentru rutele de auth. Mock-uim authService prin _deps;
// integration tests (cu DB real + JWT real) sunt în
// tests/integration/auth.integration.test.js.

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'silent');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');
vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_SECRET_NAME', 'firebase-service-account-test');

const express = require('express');
const request = require('supertest');

const authRouter = require('./auth');
const errorHandler = require('../middleware/error-handler');
const { _deps } = authRouter;
const { UnauthorizedError, ForbiddenError } = require('../errors');

const realDeps = { ..._deps };

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use(errorHandler);
  return app;
}

const VALID_USER = {
  id: 7,
  tenant_id: 1,
  firebase_uid: 'fb-1',
  email: 'a@b.ro',
  role: 'tenant_admin',
  is_active: true,
  deleted_at: null,
  tenant_slug: 'dianex',
};

beforeEach(() => {
  _deps.authService = {
    validateFirebaseToken: vi.fn(),
    resolveTenantUser: vi.fn(),
    emitJwt: vi.fn(),
    emitRefreshToken: vi.fn(),
    verifyJwt: vi.fn(),
  };
  _deps.authMiddleware = vi.fn(async (req, _res, next) => {
    // Default mock: simulează un user autentificat. Tests îl pot suprascrie
    // dacă vor să testeze ramura „fără auth".
    req.user = {
      firebaseUid: 'fb-1',
      email: 'a@b.ro',
      tenantSlug: 'dianex',
      tenantId: 1,
      role: 'tenant_admin',
      jti: 'j1',
    };
    next();
  });
  _deps.logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
});

afterAll(() => {
  Object.assign(_deps, realDeps);
});

describe('POST /auth/firebase-login', () => {
  it('happy path → 200 cu jwt, refreshToken și user', async () => {
    _deps.authService.validateFirebaseToken.mockResolvedValue({
      uid: 'fb-1',
      email: 'a@b.ro',
    });
    _deps.authService.resolveTenantUser.mockResolvedValue(VALID_USER);
    _deps.authService.emitJwt.mockResolvedValue({
      token: 'access.jwt',
      expiresAt: 1234,
    });
    _deps.authService.emitRefreshToken.mockResolvedValue({
      token: 'refresh.jwt',
      expiresAt: 99999,
    });

    const res = await request(makeApp())
      .post('/auth/firebase-login')
      .send({ idToken: 'firebase-id-token-blabla' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        jwt: 'access.jwt',
        refreshToken: 'refresh.jwt',
        expiresAt: 1234,
        user: {
          email: 'a@b.ro',
          role: 'tenant_admin',
          tenantSlug: 'dianex',
        },
      },
    });
    expect(_deps.authService.validateFirebaseToken).toHaveBeenCalledWith(
      'firebase-id-token-blabla'
    );
    expect(_deps.authService.resolveTenantUser).toHaveBeenCalledWith(
      'fb-1',
      'a@b.ro'
    );
  });

  it('idToken lipsă → 400 (Zod)', async () => {
    const res = await request(makeApp()).post('/auth/firebase-login').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('idToken prea scurt → 400', async () => {
    const res = await request(makeApp())
      .post('/auth/firebase-login')
      .send({ idToken: 'x' });
    expect(res.status).toBe(400);
  });

  it('Firebase token invalid → 401 (UnauthorizedError din service)', async () => {
    _deps.authService.validateFirebaseToken.mockRejectedValue(
      new UnauthorizedError('Token Firebase invalid')
    );
    const res = await request(makeApp())
      .post('/auth/firebase-login')
      .send({ idToken: 'firebase-id-token' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('Firebase fără MFA → 403', async () => {
    _deps.authService.validateFirebaseToken.mockRejectedValue(
      new ForbiddenError('2FA obligatoriu pe contul Google.')
    );
    const res = await request(makeApp())
      .post('/auth/firebase-login')
      .send({ idToken: 'firebase-id-token' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/2FA/);
  });

  it('user nu e în tenant_users → 403', async () => {
    _deps.authService.validateFirebaseToken.mockResolvedValue({
      uid: 'fb-1',
      email: 'a@b.ro',
    });
    _deps.authService.resolveTenantUser.mockRejectedValue(
      new ForbiddenError('Contul tău Google nu e înregistrat în AMEF.')
    );
    const res = await request(makeApp())
      .post('/auth/firebase-login')
      .send({ idToken: 'firebase-id-token' });
    expect(res.status).toBe(403);
  });

  it('logger.info e apelat la login reușit (audit)', async () => {
    _deps.authService.validateFirebaseToken.mockResolvedValue({
      uid: 'fb-1',
      email: 'a@b.ro',
    });
    _deps.authService.resolveTenantUser.mockResolvedValue(VALID_USER);
    _deps.authService.emitJwt.mockResolvedValue({ token: 'a', expiresAt: 1 });
    _deps.authService.emitRefreshToken.mockResolvedValue({ token: 'r', expiresAt: 2 });

    await request(makeApp())
      .post('/auth/firebase-login')
      .send({ idToken: 'firebase-id-token-blabla' });

    expect(_deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        firebaseUid: 'fb-1',
        tenantSlug: 'dianex',
      }),
      expect.stringContaining('Login')
    );
  });
});

describe('POST /auth/refresh', () => {
  it('refresh token valid → 200 cu tokens noi', async () => {
    _deps.authService.verifyJwt.mockResolvedValue({
      sub: 'fb-1',
      type: 'refresh',
      tenant_id: 1,
      jti: 'jr',
    });
    _deps.authService.resolveTenantUser.mockResolvedValue(VALID_USER);
    _deps.authService.emitJwt.mockResolvedValue({
      token: 'new.access',
      expiresAt: 5555,
    });
    _deps.authService.emitRefreshToken.mockResolvedValue({
      token: 'new.refresh',
      expiresAt: 99999,
    });

    const res = await request(makeApp())
      .post('/auth/refresh')
      .send({ refreshToken: 'old.refresh.token' });

    expect(res.status).toBe(200);
    expect(res.body.data.jwt).toBe('new.access');
    expect(res.body.data.refreshToken).toBe('new.refresh');
    expect(res.body.data.user.role).toBe('tenant_admin');
  });

  it('access token folosit ca refresh → 401', async () => {
    _deps.authService.verifyJwt.mockResolvedValue({
      sub: 'fb-1',
      type: 'access', // nu refresh!
      tenant_id: 1,
    });
    const res = await request(makeApp())
      .post('/auth/refresh')
      .send({ refreshToken: 'access.token' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/refresh token/i);
  });

  it('refresh token invalid → 401', async () => {
    _deps.authService.verifyJwt.mockRejectedValue(
      new UnauthorizedError('Token JWT invalid')
    );
    const res = await request(makeApp())
      .post('/auth/refresh')
      .send({ refreshToken: 'bad.token.value' });
    expect(res.status).toBe(401);
  });

  it('body fără refreshToken → 400', async () => {
    const res = await request(makeApp()).post('/auth/refresh').send({});
    expect(res.status).toBe(400);
  });

  it('user-ul a fost dezactivat după login → 403 la refresh', async () => {
    _deps.authService.verifyJwt.mockResolvedValue({
      sub: 'fb-1',
      type: 'refresh',
      tenant_id: 1,
    });
    _deps.authService.resolveTenantUser.mockRejectedValue(
      new ForbiddenError('Contul tău e dezactivat.')
    );
    const res = await request(makeApp())
      .post('/auth/refresh')
      .send({ refreshToken: 'old.refresh' });
    expect(res.status).toBe(403);
  });
});

describe('POST /auth/logout', () => {
  it('cu auth (mocked) → 200 și loghează evenimentul', async () => {
    const res = await request(makeApp()).post('/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(_deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        actorEmail: 'a@b.ro',
        tenantSlug: 'dianex',
        jti: 'j1',
      }),
      'Logout'
    );
  });

  it('fără auth (middleware aruncă) → 401', async () => {
    _deps.authMiddleware = vi.fn(async (_req, _res, next) => {
      next(new UnauthorizedError('Header Authorization absent.'));
    });
    const res = await request(makeApp()).post('/auth/logout');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});
