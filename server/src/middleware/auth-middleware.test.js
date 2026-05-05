// Teste pentru auth-middleware. Mock-uim authService.verifyJwt prin _deps;
// nu testăm criptografia JWT aici (acoperită în auth-service.test.js).

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'silent');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');
vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_SECRET_NAME', 'firebase-service-account-test');

const authMiddleware = require('./auth-middleware');
const { _deps } = authMiddleware;
const { UnauthorizedError } = require('../errors');

const realDeps = { ..._deps };

beforeEach(() => {
  _deps.authService = {
    verifyJwt: vi.fn(),
  };
});

afterAll(() => {
  Object.assign(_deps, realDeps);
});

function makeReq(headers = {}) {
  return { headers };
}

describe('authMiddleware', () => {
  it('fără header Authorization → next(UnauthorizedError)', async () => {
    const next = vi.fn();
    await authMiddleware(makeReq(), {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err.message).toMatch(/absent/);
  });

  it('header neasteptat (Basic auth) → 401', async () => {
    const next = vi.fn();
    await authMiddleware(makeReq({ authorization: 'Basic abc' }), {}, next);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err.message).toMatch(/malformat/);
  });

  it('Bearer fără token → 401', async () => {
    const next = vi.fn();
    await authMiddleware(makeReq({ authorization: 'Bearer ' }), {}, next);
    expect(next.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
  });

  it('verifyJwt aruncă → next cu eroarea propagată', async () => {
    _deps.authService.verifyJwt.mockRejectedValue(
      new UnauthorizedError('expired')
    );
    const next = vi.fn();
    await authMiddleware(
      makeReq({ authorization: 'Bearer xxx.yyy.zzz' }),
      {},
      next
    );
    expect(next.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
    expect(next.mock.calls[0][0].message).toBe('expired');
  });

  it('token de tip refresh → respins (așteptăm access)', async () => {
    _deps.authService.verifyJwt.mockResolvedValue({
      sub: 'fb-1',
      type: 'refresh',
      tenant_slug: 'dianex',
      tenant_id: 1,
      role: 'tenant_admin',
      jti: 'j1',
    });
    const next = vi.fn();
    await authMiddleware(
      makeReq({ authorization: 'Bearer xxx.yyy.zzz' }),
      {},
      next
    );
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err.message).toMatch(/access/);
  });

  it('token valid → req.user populat și next() fără eroare', async () => {
    _deps.authService.verifyJwt.mockResolvedValue({
      sub: 'fb-1',
      email: 'a@b.ro',
      type: 'access',
      tenant_slug: 'dianex',
      tenant_id: 1,
      role: 'tenant_admin',
      jti: 'j1',
    });
    const req = makeReq({ authorization: 'Bearer xxx.yyy.zzz' });
    const next = vi.fn();
    await authMiddleware(req, {}, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual({
      firebaseUid: 'fb-1',
      email: 'a@b.ro',
      tenantSlug: 'dianex',
      tenantId: 1,
      role: 'tenant_admin',
      jti: 'j1',
    });
  });

  it('extrage corect token-ul după "Bearer " (trim)', async () => {
    _deps.authService.verifyJwt.mockResolvedValue({
      sub: 'fb-1',
      email: 'a@b.ro',
      type: 'access',
      tenant_slug: 'dianex',
      tenant_id: 1,
      role: 'tenant_admin',
      jti: 'j1',
    });
    const next = vi.fn();
    await authMiddleware(
      makeReq({ authorization: 'Bearer abc.def.ghi  ' }),
      {},
      next
    );
    expect(_deps.authService.verifyJwt).toHaveBeenCalledWith('abc.def.ghi');
  });
});
