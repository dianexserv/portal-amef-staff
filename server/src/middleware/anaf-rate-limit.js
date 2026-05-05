// Rate-limit dedicat pentru lookup-ul ANAF (sub-stage 5d, decizia 1c).
//
// De ce un rate-limit separat de cel global pe `/api`:
//   - ANAF e un serviciu extern terț care poate suspenda integrarea dacă
//     trimitem volume mari (regula lor: max câteva sute de cereri/zi pentru
//     un client). 30/oră/user e o limită prudentă pentru uz uman normal:
//     contabilul nu introduce 30 de clienți noi/oră.
//   - Limit-ul global pe `/api` e per-IP — într-un birou cu mai mulți
//     utilizatori pe aceeași IP toată echipa ar împărți cota. Aici cheia
//     e per-user (`tenant_slug:user_id`) ca cota să fie individuală.
//
// Trade-off acceptat: pe Cloud Run cu auto-scaling, fiecare instanță are
// propriul MemoryStore (default-ul lui express-rate-limit), deci cota
// efectivă e `30 × N instances`. La scale mic (1-3 instances) e neglijabil;
// dacă Stage 12+ aducem o instanță Memorystore Redis pentru cron-uri,
// mutăm și store-ul aici.

const rateLimit = require('express-rate-limit');

const ANAF_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 oră
const ANAF_RATE_LIMIT_MAX = 30;

// Factory pattern: testele construiesc o instanță cu fereastră scurtă
// (ms-uri) ca să atingem 429 fără să așteptăm 30 cereri reale într-o oră.
function buildAnafRateLimit(options = {}) {
  return rateLimit({
    windowMs: options.windowMs || ANAF_RATE_LIMIT_WINDOW_MS,
    max: options.max || ANAF_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Cheia: `tenant_slug:user_id`. authMiddleware rulează ÎNAINTE de
    // acest middleware (montat în router), deci `req.user` e garantat
    // setat. Fallback pe IP doar ca defense-in-depth — n-ar trebui
    // să se ajungă acolo în flow-ul normal.
    keyGenerator: (req) => {
      if (req.user && req.user.tenantSlug && req.user.firebaseUid) {
        return `${req.user.tenantSlug}:${req.user.firebaseUid}`;
      }
      // Fallback la req.ip — Express îl setează mereu (din socket); dacă în
      // mod excepțional lipsește, express-rate-limit refuză request-ul cu 500
      // (key undefined invalidează store-ul). Acceptăm comportamentul implicit.
      return req.ip;
    },
    message: {
      success: false,
      error:
        'Limita zilnică de verificări ANAF atinsă. Reîncearcă peste o oră.',
      code: 'ANAF_RATE_LIMIT',
    },
  });
}

// Instanță default pentru wire-up în router. Testele importă
// `buildAnafRateLimit` direct ca să creeze instanțe cu config custom.
const anafRateLimit = buildAnafRateLimit();

module.exports = anafRateLimit;
module.exports.anafRateLimit = anafRateLimit;
module.exports.buildAnafRateLimit = buildAnafRateLimit;
module.exports.ANAF_RATE_LIMIT_WINDOW_MS = ANAF_RATE_LIMIT_WINDOW_MS;
module.exports.ANAF_RATE_LIMIT_MAX = ANAF_RATE_LIMIT_MAX;
