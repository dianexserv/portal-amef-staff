// Middleware de autentificare. Verifică header-ul `Authorization: Bearer <jwt>`,
// validează semnătura și expirarea, apoi populează `req.user` cu claim-urile
// utile pentru route-urile de mai jos. Nu atinge DB-ul — ne bazăm pe claim-urile
// din JWT (tenantSlug, role) care au fost setate la login.
//
// Rolurile pot deveni „învechite" dacă admin-ul retrage un drept între
// două login-uri — dar JWT-ul are TTL scurt (1h via config), deci fereastra
// e acceptabilă pentru MVP. Pentru revocare imediată ar trebui o blacklist
// pe jti — afară din scope-ul Stage 4.

const realAuthService = require('../services/auth-service');
const { UnauthorizedError } = require('../errors');

// _deps object exported strictly for testing. Tests mutate _deps.authService
// to inject mocks. Production code MUST NOT touch _deps directly except in
// lazy init.
const _deps = {
  authService: realAuthService,
};

async function authMiddleware(req, _res, next) {
  try {
    const header = req.headers && req.headers.authorization;
    if (!header || typeof header !== 'string') {
      throw new UnauthorizedError('Header Authorization absent.');
    }
    if (!header.startsWith('Bearer ')) {
      throw new UnauthorizedError(
        'Header Authorization malformat — așteptat „Bearer <token>".'
      );
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedError('Token absent în header.');
    }

    const claims = await _deps.authService.verifyJwt(token);
    if (claims.type !== 'access') {
      // Refuzăm refresh-token-urile pe endpoint-uri normale — așa nu poate
      // cineva folosi un refresh token (care e long-lived) ca pe un access.
      throw new UnauthorizedError('Token invalid: așteptat token de tip access.');
    }

    req.user = {
      firebaseUid: claims.sub,
      email: claims.email,
      tenantSlug: claims.tenant_slug,
      tenantId: claims.tenant_id,
      role: claims.role,
      jti: claims.jti,
    };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = authMiddleware;
module.exports._deps = _deps;
