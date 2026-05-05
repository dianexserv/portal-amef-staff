// Configurația centralizată a backend-ului — citește și validează variabilele
// de mediu cu Zod. Folosim un singur punct de validare pentru a opri pornirea
// serverului dacă lipsesc valori critice (pattern fail-fast pe Cloud Run).
//
// `loadConfig` e exportat ca factory pentru teste; restul codului consumă
// obiectul înghețat exportat la nivel de modul (citit o singură dată la
// pornire — env-ul nu se schimbă în timpul rulării unui container).

const { z } = require('zod');

// Helpers de preprocess. În Cloud Run / .env lipsa unei variabile produce
// `undefined`, iar `vi.stubEnv` poate seta string gol — tratăm ambele identic.
// Substituim default-ul direct în preprocess pentru ca `.default()` la nivel
// outer să nu rateze cazul `''` (Zod aplică default doar pe undefined).
const withDefault = (defaultValue) => (v) =>
  v === '' || v === undefined ? defaultValue : v;
const blankToUndefined = (v) => (v === '' ? undefined : v);

const positiveIntWithDefault = (defaultValue) =>
  z.preprocess(
    withDefault(defaultValue),
    z.coerce.number().int().positive()
  );

const requiredString = (fieldName) =>
  z.preprocess(
    blankToUndefined,
    z
      .string({ required_error: `${fieldName} este obligatoriu` })
      .min(1, `${fieldName} este obligatoriu`)
  );

const ConfigSchema = z.object({
  // Mediul de rulare — gating-ul staging-înainte-de-production e regulă AMEF.
  NODE_ENV: z.preprocess(
    withDefault('development'),
    z.enum(['development', 'staging', 'production'])
  ),

  // Portul HTTP pentru Express. 3001 e portul local convenit (frontend-ul Vite
  // proxy-ază /api → localhost:3001).
  PORT: positiveIntWithDefault(3001),

  // Niveluri Pino — controlează verbozitatea log-urilor.
  LOG_LEVEL: z.preprocess(
    withDefault('info'),
    z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
  ),

  // ID-ul proiectului GCP — folosit de Secret Manager și Cloud SQL.
  GCP_PROJECT_ID: requiredString('GCP_PROJECT_ID'),

  // Numele secretului care conține cheia JWT (NU valoarea, ci numele resursei
  // din Secret Manager). Valoarea se citește lazy, cu cache 5 min.
  JWT_SECRET_NAME: requiredString('JWT_SECRET_NAME'),

  // Durate de viață ale token-urilor — convertite la numere pentru calculele
  // de expirare în middleware-ul de auth (Stage 4).
  JWT_EXPIRY_HOURS: positiveIntWithDefault(1),
  REFRESH_TOKEN_EXPIRY_DAYS: positiveIntWithDefault(7),

  // Firebase Identity Platform — verificarea token-urilor SSO/2FA TOTP.
  FIREBASE_PROJECT_ID: requiredString('FIREBASE_PROJECT_ID'),

  // Conexiunea către DB-ul `amef_shared` (date partajate cross-tenant).
  // Pool-urile per-tenant își rezolvă singure secretele după convenția
  // `tenant-{slug}-db-connection`.
  SHARED_DB_CONNECTION_SECRET_NAME: requiredString(
    'SHARED_DB_CONNECTION_SECRET_NAME'
  ),
});

function loadConfig(env = process.env) {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    // Format flatten + path explicit ca să dăm un mesaj clar imediat la
    // pornire (logul Cloud Run rămâne ca singura sursă de diagnostic).
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Configurație invalidă: ${issues}`);
  }
  return Object.freeze({ ...result.data });
}

const config = loadConfig();

// Atașăm și factory-ul ca să poată fi re-evaluat în teste (vi.stubEnv +
// vi.resetModules). Înghețăm exportul ca să blocăm modificările accidentale.
module.exports = Object.freeze({
  ...config,
  loadConfig,
});
