// Factory `createApp()` — construiește un Express app fără să-l pornească.
//
// De ce factory (nu un singleton la nivel de modul):
//   1. Testabilitate — Supertest preferă o instanță nouă per fișier de
//      test, fără port ocupat și fără side-effects partajate.
//   2. Flexibilitate la deploy — dacă vom avea în viitor un al doilea
//      proces (ex: worker pentru job-uri ANAF) putem reutiliza middleware-le
//      construindu-ne instanța proprie cu opțiuni diferite (rate-limit
//      mai relaxat, etc.).
//   3. Override pentru rate-limit în teste — `options.rateLimit` permite
//      restrânge fereastra/limita ca testele să poată simula 429 fără
//      să trimită 100 de cereri reale.
//
// Order-ul middleware-elor contează:
//   helmet → cors → pino-http → json → rateLimit(/api) → /health → /api/v1
//   → notFoundHandler → errorHandler

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const notFoundHandler = require('./middleware/not-found-handler');
const errorHandler = require('./middleware/error-handler');

const DEFAULT_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000,
  // 100 req per IP în fereastra de 15 min — generos pentru un user normal,
  // dar oprește scriptele agresive (scrapers, brute force pe login).
  max: 100,
};

function createApp(options = {}) {
  const app = express();

  // Trust proxy ON — Cloud Run injectează X-Forwarded-For; fără asta
  // express-rate-limit ar limita per IP-ul load-balancer-ului (toate
  // cererile = aceeași sursă = limit imediat). LIMITAT la 1 hop ca să
  // nu acceptăm spoof-uri de la clienți direct.
  app.set('trust proxy', 1);

  // 1) Helmet — set de header-uri de securitate (X-Content-Type-Options,
  // X-Frame-Options, Strict-Transport-Security pe HTTPS etc.).
  app.use(helmet());

  // 2) CORS — origin-ul controlat din config; default localhost pentru dev.
  // `credentials: true` ca să trimitem cookie-urile JWT (refresh token-ul
  // va fi httpOnly cookie în Stage 4).
  app.use(
    cors({
      origin: config.CORS_ORIGIN,
      credentials: true,
    })
  );

  // 3) Request logging — pino-http adaugă req.log + req.id (auto-generat),
  // log-urile din handler-e moștenesc bindings-urile request-ului.
  app.use(
    pinoHttp({
      logger,
      // Cloud Run trimite trace ID-ul; dacă-l avem în header-ul
      // X-Cloud-Trace-Context îl putem propaga aici la nevoie.
    })
  );

  // 4) JSON parsing cu limită — 1mb e mai mult decât suficient pentru
  // payload-urile noastre (clienți, facturi); peste asta e suspect.
  app.use(express.json({ limit: '1mb' }));

  // 5) Rate limit pe /api/* — health rămâne în afara limitei ca să nu
  // blocăm probe-urile Cloud Run la trafic mare.
  const rateLimitOpts = { ...DEFAULT_RATE_LIMIT, ...(options.rateLimit || {}) };
  app.use(
    '/api',
    rateLimit({
      ...rateLimitOpts,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      // Mesaj custom în formatul nostru { success, error, code }.
      message: {
        success: false,
        error: 'Prea multe cereri — încearcă din nou mai târziu.',
        code: 'RATE_LIMITED',
      },
    })
  );

  // 6) Health — montat pe /health (NU /api/health) ca să bypass-eze rate limit-ul.
  app.use('/health', healthRouter);

  // 7) Placeholder pentru rute API. Stage 4+ va monta aici:
  //   /api/v1/auth, /api/v1/clients, /api/v1/invoices, etc.
  // Ținem un router gol acum ca structura URL-ului să fie stabilă.
  const apiV1 = express.Router();
  app.use('/api/v1', apiV1);

  // 8) 404 pentru orice nu a fost prins mai sus.
  app.use(notFoundHandler);

  // 9) Error handler — TREBUIE ultim, semnătură (err, req, res, next).
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
module.exports.createApp = createApp;
