// Logger Pino centralizat pentru întregul backend.
//
// În development folosim transport-ul `pino-pretty` (citibil în terminal);
// în staging/production emitem JSON pur ca să poată fi parsat structurat de
// Cloud Logging — orice câmp adăugat via bindings (tenant_slug, request_id)
// devine field indexat, esențial pentru debugging cross-tenant.
//
// `createChildLogger` e wrapper-ul peste `logger.child()` — adaugă bindings
// constante (ex: tenant_slug per request) ca toate log-urile dintr-un context
// să fie corelabile fără să repetăm câmpurile la fiecare apel.

const pino = require('pino');
const config = require('./config');

// `buildPinoOptions` e exportat pur ca să fie testabil cu obiecte config
// custom — ne ferim de problemele de require-cache în CJS și verificăm
// configurarea corectă pentru fiecare combinație NODE_ENV / LOG_LEVEL.
function buildPinoOptions(cfg) {
  const c = cfg || config;
  const base = {
    level: c.LOG_LEVEL,
    // Bindings de bază — `env` apare în orice log, ușurează filtrarea în
    // Cloud Logging când staging și production scriu în același backend.
    base: {
      env: c.NODE_ENV,
    },
    // ISO ca să fie compatibil cu majoritatea sistemelor de log; epoch e mai
    // ieftin la scriere dar mai greu de citit la triage.
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (c.NODE_ENV === 'development') {
    return {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    };
  }
  return base;
}

const logger = pino(buildPinoOptions());

// Wrapper subțire ca să avem un punct unic de evoluție (dacă mai târziu
// adăugăm hooks: redact, sample, propagare trace_id etc.).
function createChildLogger(bindings) {
  return logger.child(bindings || {});
}

module.exports = logger;
module.exports.createChildLogger = createChildLogger;
module.exports.buildPinoOptions = buildPinoOptions;
