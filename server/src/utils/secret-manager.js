// Wrapper peste @google-cloud/secret-manager.
//
// Cache cu TTL de 5 minute reduce drastic numărul de cereri către GCP — un
// container Cloud Run citește același secret zeci de ori pe minut (la fiecare
// request care creează/refolosește pool-ul DB sau verifică JWT). În același
// timp 5 min e suficient de scurt încât rotația de secrete să se propage fără
// reboot manual.
//
// `_deps` e un test seam — în CJS vi.mock NU interceptează require(), deci
// folosim injecție explicită pentru a permite testelor să substituie clientul
// GCP. Producția nu atinge `_deps` decât pentru a citi `ClientClass` la prima
// instanțiere a clientului.

const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const config = require('../config');

// Eroare custom cu `code` ca să poată fi prinsă selectiv (`err.code === ...`).
// O lăsăm aici până apare un al doilea consumator — mutăm în utils/errors.js
// la nevoie, fără a bloca Stage 2a.
class ValidationError extends Error {
  constructor(message, code = 'VALIDATION_ERROR') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

// _deps object exported strictly for testing. Tests mutate _deps.client/_deps.logger
// to inject mocks. Production code MUST NOT touch _deps directly except in lazy init.
//
// În CJS, vi.mock NU interceptează require(), iar `vi.resetModules` nu curăță
// cache-ul native Node — testarea fiabilă a clientului GCP depinde de această
// injecție explicită. Vezi „Testing seam pattern" în CLAUDE.md pentru context.
const _deps = {
  ClientClass: SecretManagerServiceClient,
};

let clientInstance = null;
function getClient() {
  if (!clientInstance) {
    clientInstance = new _deps.ClientClass();
  }
  return clientInstance;
}

async function getSecret(secretName) {
  if (typeof secretName !== 'string' || secretName.trim() === '') {
    throw new ValidationError(
      'Numele secretului trebuie să fie un string non-gol',
      'INVALID_SECRET_NAME'
    );
  }

  const now = Date.now();
  const cached = cache.get(secretName);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const fullName = `projects/${config.GCP_PROJECT_ID}/secrets/${secretName}/versions/latest`;
  let response;
  try {
    [response] = await getClient().accessSecretVersion({ name: fullName });
  } catch (err) {
    // Wrap explicit cu numele secretului — fără asta, mesajul GCP brut
    // („PERMISSION_DENIED on resource ...") e greu de corelat în logs.
    throw new Error(
      `Eșec la citirea secretului "${secretName}" din GCP Secret Manager: ${err.message}`
    );
  }

  const payload = response && response.payload && response.payload.data;
  if (!payload) {
    throw new Error(
      `Secretul "${secretName}" are payload gol sau invalid (versiunea latest)`
    );
  }
  // Buffer.toString('utf8') — secret-ul nostru e mereu text (connection
  // string, JWT key); pentru binar am avea nevoie de o variantă separată.
  const value = Buffer.isBuffer(payload)
    ? payload.toString('utf8')
    : Buffer.from(payload).toString('utf8');

  cache.set(secretName, {
    value,
    expiresAt: now + CACHE_TTL_MS,
  });
  return value;
}

function clearCache() {
  cache.clear();
  // Reset client ca testele să poată injecta `_deps.ClientClass` și să vadă
  // efectul imediat. În producție, clearCache se apelează rar (doar la
  // teardown), deci re-instantierea e neglijabilă.
  clientInstance = null;
}

module.exports = {
  getSecret,
  clearCache,
  ValidationError,
  CACHE_TTL_MS,
  // Test seam — NU folosi în cod de producție.
  _deps,
};
