// Rute de autentificare:
//   POST /firebase-login → schimbă un Firebase idToken cu un JWT propriu
//   POST /refresh        → rotește perechea (access, refresh) la expirare
//   POST /logout         → loghează evenimentul (MVP — fără revocare server-side)
//
// Decizie D6 (MVP): Google SSO ONLY via Firebase Identity Platform. 2FA e
// delegat lui Google (Workspace + YubiKey/TOTP). Refuzăm tokenul dacă lipsesc
// claim-urile de 2FA (vezi auth-service.validateFirebaseToken).
//
// Rate-limit-ul la /api/* (configurat în app.js) acoperă și aceste rute —
// 100 req / 15 min per IP e suficient pentru un user normal, oprește brute
// force-ul pe enumerări de email-uri.

const express = require('express');
const { z } = require('zod');

const realAuthService = require('../services/auth-service');
const realAuthMiddleware = require('../middleware/auth-middleware');
const realLogger = require('../logger');
const { UnauthorizedError } = require('../errors');

// _deps object exported strictly for testing. Tests mutate _deps.authService
// to inject mocks. Production code MUST NOT touch _deps directly except in
// lazy init.
const _deps = {
  authService: realAuthService,
  authMiddleware: realAuthMiddleware,
  logger: realLogger,
};

const FirebaseLoginSchema = z.object({
  // 10 caractere e o limită inferioară foarte permisivă — token-urile reale
  // au sute de caractere, dar evităm să picăm eronat în Zod când dezvoltatorii
  // testează manual cu token-uri scurte.
  idToken: z.string().min(10),
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(10),
});

const router = express.Router();

router.post('/firebase-login', async (req, res, next) => {
  try {
    const { idToken } = FirebaseLoginSchema.parse(req.body);
    const decoded = await _deps.authService.validateFirebaseToken(idToken);
    const user = await _deps.authService.resolveTenantUser(
      decoded.uid,
      decoded.email
    );
    const access = await _deps.authService.emitJwt({
      firebaseUid: decoded.uid,
      email: user.email,
      tenantSlug: user.tenant_slug,
      tenantId: user.tenant_id,
      role: user.role,
    });
    const refresh = await _deps.authService.emitRefreshToken({
      firebaseUid: decoded.uid,
      tenantId: user.tenant_id,
    });
    _deps.logger.info(
      {
        firebaseUid: decoded.uid,
        email: user.email,
        tenantSlug: user.tenant_slug,
        role: user.role,
      },
      'Login reușit'
    );
    return res.status(200).json({
      success: true,
      data: {
        jwt: access.token,
        refreshToken: refresh.token,
        expiresAt: access.expiresAt,
        user: {
          email: user.email,
          role: user.role,
          tenantSlug: user.tenant_slug,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = RefreshSchema.parse(req.body);
    const claims = await _deps.authService.verifyJwt(refreshToken);
    if (claims.type !== 'refresh') {
      // Nu lăsa pe nimeni să folosească un access token la refresh — e un
      // semnal de abuz / bug client side.
      throw new UnauthorizedError(
        'Token invalid: așteptat un refresh token, primit alt tip.'
      );
    }
    // Re-rezolvăm user-ul din DB ca să captăm rolul curent (poate fi
    // schimbat de admin între login și refresh — TTL-ul access-token-ului
    // e scurt tocmai ca rotația aici să propage rapid schimbările).
    const user = await _deps.authService.resolveTenantUser(claims.sub);
    const access = await _deps.authService.emitJwt({
      firebaseUid: claims.sub,
      email: user.email,
      tenantSlug: user.tenant_slug,
      tenantId: user.tenant_id,
      role: user.role,
    });
    // Rotație: emitem și un refresh token nou. Vechiul rămâne valid până la
    // expirare (MVP — fără revocare server-side); pentru hardening ulterior
    // ar trebui o listă de jti revocate.
    const newRefresh = await _deps.authService.emitRefreshToken({
      firebaseUid: claims.sub,
      tenantId: user.tenant_id,
    });
    return res.status(200).json({
      success: true,
      data: {
        jwt: access.token,
        refreshToken: newRefresh.token,
        expiresAt: access.expiresAt,
        user: {
          email: user.email,
          role: user.role,
          tenantSlug: user.tenant_slug,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// Logout: cere autentificare ca să loghezi „cine" se delogează (audit).
// În MVP nu avem revocare server-side — JWT-ul rămâne valid până la expirare.
// Frontend-ul șterge token-urile din storage; pentru revocare immediată ar
// fi nevoie de o blacklist pe jti (afară din Stage 4).
router.post(
  '/logout',
  // Wrapper ca să folosim _deps.authMiddleware (testabil) — Express acceptă
  // direct funcția, dar atunci am pierde indirecția pentru injecție.
  (req, res, next) => _deps.authMiddleware(req, res, next),
  (req, res) => {
    _deps.logger.info(
      {
        actorEmail: req.user.email,
        tenantSlug: req.user.tenantSlug,
        firebaseUid: req.user.firebaseUid,
        jti: req.user.jti,
      },
      'Logout'
    );
    return res.status(200).json({
      success: true,
      data: { message: 'Logged out.' },
    });
  }
);

module.exports = router;
module.exports._deps = _deps;
