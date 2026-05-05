// Teste unitare pentru auth-service. Mock-uim TOATE I/O via _deps:
//   - verifyIdToken (Firebase)
//   - getSecret (Secret Manager)
//   - pool.getSharedPool (DB)
//   - logger
// JWT-urile reale (jsonwebtoken) sunt folosite — testează și partea de
// semnare/verificare end-to-end fără a depinde de un real Firebase/Secret
// Manager/Postgres.

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'silent');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');
vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_SECRET_NAME', 'firebase-service-account-test');

const jwt = require('jsonwebtoken');
const authService = require('./auth-service');
const { UnauthorizedError, ForbiddenError } = require('../errors');

const realDeps = { ...authService._deps };

const TEST_JWT_SECRET = 'test-secret-key-with-enough-bytes-for-hs256-algorithm';

beforeEach(() => {
  authService._deps.verifyIdToken = vi.fn();
  authService._deps.getSecret = vi.fn(async (name) => {
    if (name === 'jwt-secret-test') return TEST_JWT_SECRET;
    return 'unused';
  });
  authService._deps.pool = {
    getSharedPool: vi.fn().mockResolvedValue({
      query: vi.fn(),
    }),
  };
  authService._deps.logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
});

afterAll(() => {
  Object.assign(authService._deps, realDeps);
});

describe('default _deps.verifyIdToken (lazy Firebase init)', () => {
  it('inițializează firebase-admin la primul apel și pasează idToken-ul', async () => {
    // Restaurăm wrapper-ul real (suprascris în beforeEach pentru control)
    // și înlocuim doar piesele lui externe: getSecret + firebaseAdmin.
    authService._deps.verifyIdToken = realDeps.verifyIdToken;

    const verifyIdTokenMock = vi.fn().mockResolvedValue({ uid: 'fb-1' });
    const initializeAppMock = vi.fn();
    const certMock = vi.fn(() => ({ kind: 'cert' }));

    authService._deps.getSecret = vi.fn(async () =>
      JSON.stringify({ project_id: 'fake', private_key: 'fake' })
    );
    authService._deps.firebaseAdmin = {
      initializeApp: initializeAppMock,
      credential: { cert: certMock },
      auth: () => ({ verifyIdToken: verifyIdTokenMock }),
    };

    const decoded = await authService._deps.verifyIdToken('id-token-1');
    expect(decoded).toEqual({ uid: 'fb-1' });
    expect(initializeAppMock).toHaveBeenCalledTimes(1);
    expect(certMock).toHaveBeenCalledWith({
      project_id: 'fake',
      private_key: 'fake',
    });
    expect(verifyIdTokenMock).toHaveBeenCalledWith('id-token-1');

    // Al doilea apel NU re-inițializează — `_firebaseInitialized` rămâne true.
    await authService._deps.verifyIdToken('id-token-2');
    expect(initializeAppMock).toHaveBeenCalledTimes(1);
    expect(verifyIdTokenMock).toHaveBeenCalledTimes(2);
  });
});

describe('validateFirebaseToken', () => {
  it('token valid cu mfa via firebase.sign_in_second_factor → returnează decoded', async () => {
    authService._deps.verifyIdToken.mockResolvedValue({
      uid: 'fb-1',
      email: 'a@b.ro',
      firebase: { sign_in_second_factor: 'totp' },
    });
    const decoded = await authService.validateFirebaseToken('idtoken');
    expect(decoded.uid).toBe('fb-1');
    expect(authService._deps.verifyIdToken).toHaveBeenCalledWith('idtoken');
  });

  it('token valid cu mfa via custom claim mfa_verified → acceptat', async () => {
    authService._deps.verifyIdToken.mockResolvedValue({
      uid: 'fb-1',
      email: 'a@b.ro',
      mfa_verified: true,
    });
    const decoded = await authService.validateFirebaseToken('idtoken');
    expect(decoded.uid).toBe('fb-1');
  });

  it('token invalid → UnauthorizedError', async () => {
    authService._deps.verifyIdToken.mockRejectedValue(
      new Error('id-token-expired')
    );
    await expect(
      authService.validateFirebaseToken('idtoken')
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      authService.validateFirebaseToken('idtoken')
    ).rejects.toThrow(/Token Firebase invalid/);
  });

  it('token fără mfa → ForbiddenError cu mesaj despre 2FA', async () => {
    authService._deps.verifyIdToken.mockResolvedValue({
      uid: 'fb-1',
      email: 'a@b.ro',
      firebase: { sign_in_provider: 'google.com' },
    });
    await expect(
      authService.validateFirebaseToken('idtoken')
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      authService.validateFirebaseToken('idtoken')
    ).rejects.toThrow(/2FA obligatoriu/);
  });

  it('token fără claim firebase deloc → ForbiddenError', async () => {
    authService._deps.verifyIdToken.mockResolvedValue({
      uid: 'fb-1',
      email: 'a@b.ro',
    });
    await expect(
      authService.validateFirebaseToken('idtoken')
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('token cu mfa_verified=false → ForbiddenError', async () => {
    authService._deps.verifyIdToken.mockResolvedValue({
      uid: 'fb-1',
      mfa_verified: false,
    });
    await expect(
      authService.validateFirebaseToken('idtoken')
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('emitJwt', () => {
  const VALID_INPUT = {
    firebaseUid: 'fb-1',
    email: 'a@b.ro',
    tenantSlug: 'dianex',
    role: 'tenant_admin',
    tenantId: 1,
  };

  it('returnează token cu toate claim-urile așteptate', async () => {
    const { token, expiresAt } = await authService.emitJwt(VALID_INPUT);
    expect(typeof token).toBe('string');
    const decoded = jwt.verify(token, TEST_JWT_SECRET);
    expect(decoded.sub).toBe('fb-1');
    expect(decoded.email).toBe('a@b.ro');
    expect(decoded.tenant_slug).toBe('dianex');
    expect(decoded.tenant_id).toBe(1);
    expect(decoded.role).toBe('tenant_admin');
    expect(decoded.type).toBe('access');
    expect(typeof decoded.jti).toBe('string');
    expect(decoded.jti.length).toBeGreaterThan(0);
    expect(decoded.exp).toBe(expiresAt);
  });

  it('jti e unic la apeluri repetate', async () => {
    const a = await authService.emitJwt(VALID_INPUT);
    const b = await authService.emitJwt(VALID_INPUT);
    const da = jwt.decode(a.token);
    const db = jwt.decode(b.token);
    expect(da.jti).not.toBe(db.jti);
  });

  it('exp respectă JWT_EXPIRY_HOURS din config', async () => {
    const { token } = await authService.emitJwt(VALID_INPUT);
    const decoded = jwt.decode(token);
    // JWT_EXPIRY_HOURS=1 (din vi.stubEnv) → exp − iat ≈ 3600s
    expect(decoded.exp - decoded.iat).toBe(3600);
  });

  it('semnează cu secret-ul citit din Secret Manager', async () => {
    await authService.emitJwt(VALID_INPUT);
    expect(authService._deps.getSecret).toHaveBeenCalledWith('jwt-secret-test');
  });
});

describe('emitRefreshToken', () => {
  const INPUT = { firebaseUid: 'fb-1', tenantId: 1 };

  it('returnează token cu type=refresh', async () => {
    const { token } = await authService.emitRefreshToken(INPUT);
    const decoded = jwt.verify(token, TEST_JWT_SECRET);
    expect(decoded.type).toBe('refresh');
    expect(decoded.sub).toBe('fb-1');
    expect(decoded.tenant_id).toBe(1);
  });

  it('exp respectă REFRESH_TOKEN_EXPIRY_DAYS din config', async () => {
    const { token } = await authService.emitRefreshToken(INPUT);
    const decoded = jwt.decode(token);
    // REFRESH_TOKEN_EXPIRY_DAYS=7 → 7*86400 = 604800s
    expect(decoded.exp - decoded.iat).toBe(604800);
  });

  it('refresh token e considerabil mai lung-trăitor decât access', async () => {
    const access = await authService.emitJwt({
      firebaseUid: 'fb-1',
      email: 'a@b.ro',
      tenantSlug: 'dianex',
      role: 'tenant_admin',
      tenantId: 1,
    });
    const refresh = await authService.emitRefreshToken(INPUT);
    expect(refresh.expiresAt).toBeGreaterThan(access.expiresAt);
  });
});

describe('verifyJwt', () => {
  it('token valid → returnează claims', async () => {
    const { token } = await authService.emitJwt({
      firebaseUid: 'fb-1',
      email: 'a@b.ro',
      tenantSlug: 'dianex',
      role: 'tenant_admin',
      tenantId: 1,
    });
    const claims = await authService.verifyJwt(token);
    expect(claims.sub).toBe('fb-1');
    expect(claims.tenant_slug).toBe('dianex');
    expect(claims.type).toBe('access');
  });

  it('token tampered → UnauthorizedError', async () => {
    const { token } = await authService.emitJwt({
      firebaseUid: 'fb-1',
      email: 'a@b.ro',
      tenantSlug: 'dianex',
      role: 'tenant_admin',
      tenantId: 1,
    });
    // Modificăm un caracter în signature (ultimul segment)
    const tampered = token.slice(0, -3) + 'AAA';
    await expect(authService.verifyJwt(tampered)).rejects.toBeInstanceOf(
      UnauthorizedError
    );
  });

  it('token expirat → UnauthorizedError', async () => {
    // Semnăm direct cu expiresIn negativ (ca să fie deja expirat)
    const expiredToken = jwt.sign(
      { sub: 'fb-1', type: 'access' },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '-1s' }
    );
    await expect(authService.verifyJwt(expiredToken)).rejects.toBeInstanceOf(
      UnauthorizedError
    );
    await expect(authService.verifyJwt(expiredToken)).rejects.toThrow(
      /Token JWT invalid/
    );
  });

  it('token semnat cu alt secret → UnauthorizedError', async () => {
    const wrongToken = jwt.sign(
      { sub: 'fb-1', type: 'access' },
      'alt-secret-blabla-blabla',
      { algorithm: 'HS256', expiresIn: '1h' }
    );
    await expect(authService.verifyJwt(wrongToken)).rejects.toBeInstanceOf(
      UnauthorizedError
    );
  });

  it('token semnat cu algoritm diferit (none) → respins', async () => {
    // Atac de tip „algorithm confusion": cineva semnează cu alg=none.
    // Verifierul nostru permite DOAR HS256, deci respinge.
    const noneToken = jwt.sign({ sub: 'fb-1' }, '', { algorithm: 'none' });
    await expect(authService.verifyJwt(noneToken)).rejects.toBeInstanceOf(
      UnauthorizedError
    );
  });
});

describe('resolveTenantUser', () => {
  function setupRow(row) {
    const queryMock = vi.fn().mockResolvedValue({
      rows: row ? [row] : [],
    });
    authService._deps.pool.getSharedPool = vi.fn().mockResolvedValue({
      query: queryMock,
    });
    return queryMock;
  }

  it('user activ și existent → returnează rândul cu tenant_slug', async () => {
    setupRow({
      id: 7,
      tenant_id: 1,
      firebase_uid: 'fb-1',
      email: 'a@b.ro',
      role: 'tenant_admin',
      is_active: true,
      deleted_at: null,
      tenant_slug: 'dianex',
    });
    const user = await authService.resolveTenantUser('fb-1', 'a@b.ro');
    expect(user.tenant_slug).toBe('dianex');
    expect(user.role).toBe('tenant_admin');
    expect(user.tenant_id).toBe(1);
  });

  it('query e pe firebase_uid (parametrizat, nu interpolat)', async () => {
    const queryMock = setupRow({
      id: 7,
      tenant_id: 1,
      firebase_uid: 'fb-1',
      email: 'a@b.ro',
      role: 'tenant_admin',
      is_active: true,
      deleted_at: null,
      tenant_slug: 'dianex',
    });
    await authService.resolveTenantUser('fb-1', 'a@b.ro');
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('amef_shared.tenant_users');
    expect(sql).toContain('amef_shared.tenants');
    expect(params).toEqual(['fb-1']);
  });

  it('user inexistent → ForbiddenError cu mesaj clar', async () => {
    setupRow(null);
    await expect(
      authService.resolveTenantUser('fb-unknown', 'x@y.ro')
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      authService.resolveTenantUser('fb-unknown', 'x@y.ro')
    ).rejects.toThrow(/nu e înregistrat în AMEF/);
  });

  it('user cu deleted_at setat → ForbiddenError "Contul tău a fost șters"', async () => {
    setupRow({
      id: 7,
      tenant_id: 1,
      firebase_uid: 'fb-1',
      email: 'a@b.ro',
      role: 'tenant_admin',
      is_active: true,
      deleted_at: new Date('2025-01-01').toISOString(),
      tenant_slug: 'dianex',
    });
    await expect(
      authService.resolveTenantUser('fb-1', 'a@b.ro')
    ).rejects.toThrow(/șters/);
  });

  it('user cu is_active=false → ForbiddenError "Contul tău e dezactivat"', async () => {
    setupRow({
      id: 7,
      tenant_id: 1,
      firebase_uid: 'fb-1',
      email: 'a@b.ro',
      role: 'tenant_admin',
      is_active: false,
      deleted_at: null,
      tenant_slug: 'dianex',
    });
    await expect(
      authService.resolveTenantUser('fb-1', 'a@b.ro')
    ).rejects.toThrow(/dezactivat/);
  });

  it('logger.warn e apelat când user lipsește (audit trail)', async () => {
    setupRow(null);
    await authService.resolveTenantUser('fb-unknown', 'x@y.ro').catch(() => {});
    expect(authService._deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ firebaseUid: 'fb-unknown' }),
      expect.any(String)
    );
  });
});
