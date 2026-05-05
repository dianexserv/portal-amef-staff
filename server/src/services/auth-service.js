// Serviciu de autentificare. Două lumi de verificat: identitatea de la
// Firebase (Google SSO) și sesiunea proprie (JWT semnat de noi).
//
// Decizie D6 (MVP): Google SSO ONLY. 2FA delegat lui Google (Dianex are
// YubiKey + cont Google cu 2FA). Refuzăm login dacă claim-ul de second
// factor lipsește. Email/parolă și Microsoft SSO se adaugă când avem
// nevoie de un tenant non-Google-Workspace.
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

function hasMfa(decoded) {
  // Două surse posibile, ambele acceptate:
  //   - `firebase.sign_in_second_factor` — set de Firebase când e enrollat
  //     un al doilea factor în Firebase Identity Platform (TOTP).
  //   - `mfa_verified === true` — claim custom pe care l-am putea seta via
  //     Cloud Function pe baza Google sign-in atributes (când 2FA e pe
  //     contul Google, nu în Firebase).
  // Pentru MVP cerem cel puțin una — Dianex are 2FA pe Google, deci în
  // practică va fi `mfa_verified` (după ce wire-uim Cloud Function-ul) sau
  // 2FA enrollat direct în Firebase pentru cei fără Workspace.
  if (!decoded || typeof decoded !== 'object') return false;
  if (decoded.mfa_verified === true) return true;
  if (
    decoded.firebase &&
    typeof decoded.firebase === 'object' &&
    decoded.firebase.sign_in_second_factor
  ) {
    return true;
  }
  return false;
}

async function validateFirebaseToken(idToken) {
  let decoded;
  try {
    decoded = await _deps.verifyIdToken(idToken);
  } catch (err) {
    // Wrap cu UnauthorizedError ca middleware-ul de erori să răspundă 401,
    // nu 500. Mesajul brut din firebase ajută la triage local; în prod nu
    // e leak-uit pentru că errorHandler-ul ascunde detaliile de la 5xx —
    // 401-urile noastre conțin doar mesajul scurt.
    throw new UnauthorizedError(
      `Token Firebase invalid: ${err && err.message ? err.message : 'verificare eșuată'}`
    );
  }
  if (!hasMfa(decoded)) {
    throw new ForbiddenError(
      '2FA obligatoriu pe contul Google. Activează-l și reîncearcă.'
    );
  }
  return decoded;
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
