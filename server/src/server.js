// Entry point real al backend-ului. Singurul loc care încarcă dotenv și
// pornește listener-ul HTTP. `app.js` rămâne pur (factory) ca să fie
// testabil cu Supertest fără port ocupat.
//
// Ordinea operațiunilor:
//   1. dotenv.config() — citește .env (în production Cloud Run injectează env
//      direct, dar dotenv.config() nu strică: nu suprascrie variabile setate).
//   2. require('./config') — validează env-ul; dacă lipsește ceva critic,
//      throw aici închide procesul cu cod ≠ 0 (Cloud Run reîncearcă).
//   3. createApp() — construiește Express-ul.
//   4. listen() pe config.PORT.
//   5. SIGTERM handler — Cloud Run trimite SIGTERM la deploy-uri/scaling
//      pentru graceful shutdown (max 10s implicit). Închidem listener-ul,
//      apoi pool-urile DB, apoi exit 0.

require('dotenv').config();

const config = require('./config');
const logger = require('./logger');
const createApp = require('./app');
const { closeAllPools } = require('./db/pool');

const SHUTDOWN_TIMEOUT_MS = 8000;

const app = createApp();
const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, nodeEnv: config.NODE_ENV },
    'server pornit'
  );
});

async function shutdown(signal) {
  logger.info({ signal }, 'shutdown inițiat');
  // Forțăm exit dacă cleanup-ul se blochează — Cloud Run oricum ne taie
  // după ~10s, dar vrem un mesaj de log explicit înainte.
  const killTimer = setTimeout(() => {
    logger.error({ signal }, 'shutdown timeout — forțăm exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  killTimer.unref();

  try {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await closeAllPools();
    logger.info({ signal }, 'shutdown complet');
    process.exit(0);
  } catch (err) {
    logger.error({ err, signal }, 'shutdown a eșuat');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
