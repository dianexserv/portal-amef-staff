// Middleware-ul central de erori — singurul loc care formatează răspunsuri
// HTTP de eroare. Routes/services aruncă (throw) erori custom; nu fac
// try/catch. Express prinde excepțiile din handler-ele async dacă folosim
// `express@^5` sau wrapper async; pentru `express@^4` (curent) ne bazăm pe
// pattern-ul `next(err)` apelat din .catch() / wrapper-ul de async (TBD în
// stage-urile următoare când avem rute reale).
//
// Reguli de formatare (per CLAUDE.md → API responses):
//   { success: false, error: <mesaj uman>, code: <ERROR_CODE>, details?: ... }
//
// `_deps.logger` permite testelor să verifice că eroarea e logată; în
// producție logul e Pino structurat ca Cloud Logging să-l indexeze.

const { z } = require('zod');
const { AppError } = require('../errors');
const config = require('../config');
const realLogger = require('../logger');

// _deps object exported strictly for testing. Tests mutate _deps.logger to
// inject mocks. Production code MUST NOT touch _deps directly except in
// lazy init.
//
// `getNodeEnv` e funcție (nu valoare) ca testele să poată varia
// development/production fără re-import — config e frozen la load time.
const _deps = {
  logger: realLogger,
  getNodeEnv: () => config.NODE_ENV,
};

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // `req.id` e adăugat de pino-http via `genReqId`; cade înapoi pe undefined
  // dacă pino-http nu e wired (ex: teste izolate de middleware).
  const requestId = req && req.id;
  _deps.logger.error(
    {
      err,
      requestId,
      method: req && req.method,
      url: req && req.originalUrl,
    },
    'Cerere eșuată'
  );

  // 1) Erorile custom AppError → format direct cu statusCode + code.
  if (err instanceof AppError) {
    const body = {
      success: false,
      error: err.message,
      code: err.code,
    };
    if (err.details !== undefined) {
      body.details = err.details;
    }
    return res.status(err.statusCode).json(body);
  }

  // 2) ZodError (de la `.parse()` în servicii sau middleware de validare)
  // → 400 cu lista de field-uri și mesajele aferente.
  if (err instanceof z.ZodError) {
    return res.status(400).json({
      success: false,
      error: 'Date invalide',
      code: 'VALIDATION_ERROR',
      details: err.issues.map((issue) => ({
        path: issue.path.join('.') || '<root>',
        message: issue.message,
      })),
    });
  }

  // 3) Erori HTTP din middleware-uri externe (body-parser PayloadTooLargeError
  // cu statusCode=413, etc.). Acceptăm `statusCode` 4xx ca semnal că eroarea
  // e „client error" și o expunem direct; 5xx-urile cad pe ramura generic.
  if (
    typeof err.statusCode === 'number' &&
    err.statusCode >= 400 &&
    err.statusCode < 500
  ) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message || 'Cerere invalidă',
      code: err.code || err.type || 'CLIENT_ERROR',
    });
  }

  // 4) Eroare necunoscută → 500. NU expunem err.message în staging/production
  // (poate conține detalii din DB / stack), iar stack-ul îl adăugăm doar în
  // development pentru triage local. (err e mereu non-null aici — Express
  // nu invocă error middleware fără err.)
  const body = {
    success: false,
    error: 'A apărut o eroare internă',
    code: 'INTERNAL_ERROR',
  };
  if (_deps.getNodeEnv() === 'development') {
    if (err.message) {
      body.error = err.message;
    }
    if (err.stack) {
      body.stack = err.stack;
    }
  }
  return res.status(500).json(body);
}

module.exports = errorHandler;
module.exports.errorHandler = errorHandler;
module.exports._deps = _deps;
