// Higher-order middleware care permite doar utilizatorii cu unul dintre rolurile
// permise. Scris ca factory ca să poată fi montat pe rute concrete:
//
//   router.post('/admin/clients',
//     authMiddleware,
//     requireRole(['tenant_admin', 'platform_operator']),
//     handler);
//
// Roluri AMEF (vezi CLAUDE.md): tenant_admin, tenant_user, platform_operator.

const { UnauthorizedError, ForbiddenError } = require('../errors');

function requireRole(allowedRoles) {
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
    // Greșeala asta e a programatorului, nu a request-ului — aruncăm sincron
    // ca să eșueze imediat la wire-up, nu la primul request.
    throw new Error(
      'requireRole: parametrul `allowedRoles` trebuie să fie un array non-gol.'
    );
  }
  return function requireRoleMiddleware(req, _res, next) {
    if (!req.user) {
      // authMiddleware n-a rulat înainte, sau a setat req.user = undefined.
      // Tratăm ca 401, NU 403 — clientul ar putea n-aibă autentificare deloc.
      return next(
        new UnauthorizedError('Necesită autentificare pentru această acțiune.')
      );
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new ForbiddenError(
          `Rol insuficient: necesită unul dintre [${allowedRoles.join(', ')}].`
        )
      );
    }
    next();
  };
}

module.exports = requireRole;
