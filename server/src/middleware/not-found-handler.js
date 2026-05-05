// Middleware terminal pentru rute care nu match-uiesc nimic.
//
// În Express, dacă niciun handler nu răspunde, request-ul rămâne agățat —
// setăm acest handler la final ca să transformăm 404-urile implicite în
// `NotFoundError` aruncate spre middleware-ul central de erori (un singur
// loc care formatează răspunsul).
//
// Folosim `next(err)` (nu `throw`) pentru că Express 4 nu prinde
// excepțiile sincrone aruncate dintr-un middleware decât dacă sunt
// next-ate. Pe Express 5 ambele variante funcționează.

const { NotFoundError } = require('../errors');

function notFoundHandler(req, _res, next) {
  next(
    new NotFoundError(
      `Resursa nu a fost găsită: ${req.method} ${req.originalUrl}`
    )
  );
}

module.exports = notFoundHandler;
