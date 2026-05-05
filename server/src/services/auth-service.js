// Serviciu de autentificare. Două lumi de verificat: identitatea de la
// Firebase (Google SSO) și sesiunea proprie (JWT semnat de noi).
//
// Decizie D6 (MVP, revizuită): Google SSO ONLY via Firebase. 2FA e
// responsabilitatea TENANT-ului — `tenant_admin`-ul forțează 2FA prin
// Google Workspace policy (admin.google.com → Security → 2-Step Verification
// → Enforce). Backend-ul NU face o verificare Firebase MFA suplimentară
// (claim `firebase.sign_in_second_factor`): Google a validat deja factorul
// înainte de a emite ID token-ul, iar Firebase MFA peste asta ar fi
// redundant și un feature plătit (Identity Platform). E pattern-ul standard
// SaaS B2B 2026 (Salesforce / Asana / Linear).
//
// Email/parolă și Microsoft SSO se adaugă când avem nevoie de un tenant
// non-Google-Workspace.
//
// `_deps` (vezi „Testing seam pattern" în CLAUDE.md) injectează firebase
// admin, getSecret, pool și logger — testele rescriu intrările.

const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const admin = require('firebase-admin');

const config = require('../config');
const { getSecret } = require('../utils/secret-manager');
const realPool = require('../db/pool');
const realLogger = require('../logger');
const { UnauthorizedError, ForbiddenError } = require('../errors');

// Inițializăm firebase-admin lazy (la primul verifyIdToken). În teste
// suprascriem `_deps.verifyIdToken` direct, deci ramura de inițializare nu
// rulează. Variabilă de modul ca să nu reinitializăm la fiecare apel.
let _firebaseInitialized = false;
async function ensureFirebaseInitialized() {
  if (_firebaseInitialized) return;
  const json = await _deps.getSecret(
    config.FIREBASE_SERVICE_ACCOUNT_SECRET_NAME
  );
  const credentials = JSON.parse(json);
  _deps.firebaseAdmin.initializeApp({
    credential: _deps.firebaseAdmin.credential.cert(credentials),
  });
  _firebaseInitialized = true;
}

// _deps object exported strictly for testing. Tests mutate _deps.client/_deps.logger
// to inject mocks. Production code MUST NOT touch _deps directly except in lazy init.
const _deps = {
  firebaseAdmin: admin,
  // Wrapper-ul închide peste `_deps` — la call time citește
  // `_deps.firebaseAdmin`, deci dacă teste suprascriu firebaseAdmin, închide
  // peste valoarea curentă. Tests preferă să suprascrie direct verifyIdToken.
  verifyIdToken: async (idToken) => {
    await ensureFirebaseInitialized();
    return _deps.firebaseAdmin.auth().verifyIdToken(idToken);
  },
  getSecret,
  pool: realPool,
  logger: realLogger,
};

// Acceptăm orice token Firebase valid emis prin Google provider. 2FA e
// gestionat de Google (delegat). Tenant_admin-ul e responsabil să forțeze
// 2FA prin Google Workspace policy.
async function validateFirebaseToken(idToken) {
  try {
    return await _deps.verifyIdToken(idToken);
  } catch (err) {
    // Wrap cu UnauthorizedError ca middleware-ul de erori să răspundă 401,
    // nu 500. Mesajul brut din firebase ajută la triage local; în prod nu
    // e leak-uit pentru că errorHandler-ul ascunde detaliile de la 5xx —
    // 401-urile noastre conțin doar mesajul scurt.
    throw new UnauthorizedError(
      `Token Firebase invalid: ${err && err.message ? err.message : 'verificare eșuată'}`
    );
  }
}

async function emitJwt({ firebaseUid, email, tenantSlug, role, tenantId }) {
  const secret = await _deps.getSecret(config.JWT_SECRET_NAME);
  // jti = identificator unic per token. Util pentru audit log + revoke list
  // (când / dacă o introducem). randomUUID e cripto-safe și stabil în Node.
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    {
      sub: firebaseUid,
      email,
      tenant_slug: tenantSlug,
      tenant_id: tenantId,
      role,
      type: 'access',
      jti,
    },
    secret,
    {
      algorithm: 'HS256',
      expiresIn: `${config.JWT_EXPIRY_HOURS}h`,
    }
  );
  // Decodăm propriu token-ul ca să returnăm `expiresAt` corect — timestamp-ul
  // exp e setat de jsonwebtoken pe baza expiresIn, nu de noi.
  const decoded = jwt.decode(token);
  return { token, expiresAt: decoded.exp };
}

async function emitRefreshToken({ firebaseUid, tenantId }) {
  const secret = await _deps.getSecret(config.JWT_SECRET_NAME);
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    {
      sub: firebaseUid,
      tenant_id: tenantId,
      type: 'refresh',
      jti,
    },
    secret,
    {
      algorithm: 'HS256',
      expiresIn: `${config.REFRESH_TOKEN_EXPIRY_DAYS}d`,
    }
  );
  const decoded = jwt.decode(token);
  return { token, expiresAt: decoded.exp };
}

async function verifyJwt(token) {
  const secret = await _deps.getSecret(config.JWT_SECRET_NAME);
  try {
    return jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (err) {
    throw new UnauthorizedError(
      `Token JWT invalid: ${err && err.message ? err.message : 'verificare eșuată'}`
    );
  }
}

async function resolveTenantUser(firebaseUid, email) {
  const pool = await _deps.pool.getSharedPool();
  const result = await pool.query(
    `SELECT u.id, u.tenant_id, u.firebase_uid, u.email, u.role,
            u.is_active, u.deleted_at,
            t.slug AS tenant_slug
       FROM amef_shared.tenant_users u
       JOIN amef_shared.tenants t ON t.id = u.tenant_id
      WHERE u.firebase_uid = $1
      LIMIT 1`,
    [firebaseUid]
  );
  const row = result.rows[0];
  if (!row) {
    _deps.logger.warn(
      { firebaseUid, email },
      'Login refuzat: utilizatorul Firebase nu e înregistrat în tenant_users'
    );
    throw new ForbiddenError(
      'Contul tău Google nu e înregistrat în AMEF. Contactează un admin.'
    );
  }
  if (row.deleted_at) {
    throw new ForbiddenError('Contul tău a fost șters.');
  }
  if (!row.is_active) {
    throw new ForbiddenError('Contul tău e dezactivat.');
  }
  return row;
}

module.exports = {
  validateFirebaseToken,
  emitJwt,
  emitRefreshToken,
  verifyJwt,
  resolveTenantUser,
  // Test seam — vezi „Testing seam pattern" în CLAUDE.md.
  _deps,
};
