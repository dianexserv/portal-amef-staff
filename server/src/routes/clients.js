// Rute pentru modulul Clienți (sub-stage 5d).
//
// 6 endpoint-uri:
//   GET    /api/v1/clients               — listare paginată cu filtre
//   GET    /api/v1/clients/:id           — detalii client
//   POST   /api/v1/clients               — creare (UI strict — representative full)
//   PUT    /api/v1/clients/:id           — update parțial
//   DELETE /api/v1/clients/:id           — soft-delete (tenant_admin only)
//   POST   /api/v1/clients/lookup-by-cui — auto-completare ANAF
//
// Convenții:
//   - authMiddleware aplicat pe ÎNTREGUL router (router.use) — toate
//     endpoint-urile cer JWT valid.
//   - requireRole pe DELETE — doar tenant_admin (decizie 4b: ștergerea
//     clienților e o operație delicată, ținută la rolul cu mai multă
//     responsabilitate).
//   - anafRateLimit aplicat NUMAI pe /lookup-by-cui — celelalte rute lovesc
//     DB-ul nostru (fără limită externă), doar lookup-ul atinge ANAF.
//   - Validare Zod la nivel de rută DOAR pentru path/query (id, limit, etc.).
//     Body-urile pentru POST/PUT trec direct la service — `client-service.js`
//     are deja Zod schemas complete (CreateClientFromUiSchema etc.) și
//     aruncă ZodError care e formatat de error-handler-ul central.
//   - Erorile NU sunt try/catch-uite și re-aruncate — cad la `next(err)` și
//     error-handler-ul global decide formatul HTTP.
//
// `_deps` test seam: testele rescriu `_deps.clientService`,
// `_deps.anafLookupService`, `_deps.logger`. authMiddleware și requireRole
// rămân pe modulul real în unit tests; testele care vor să bypass-eze
// autentificarea construiesc o mini-app Express și montează direct
// router-ul cu un middleware de auth fals înainte.

const express = require('express');
const { z } = require('zod');

const realClientService = require('../services/client-service');
const realAnafLookupService = require('../services/anaf-lookup-service');
const realAuthMiddleware = require('../middleware/auth-middleware');
const requireRole = require('../middleware/require-role');
const anafRateLimit = require('../middleware/anaf-rate-limit');
const realLogger = require('../logger');

// _deps object exported strictly for testing. Tests mutate _deps.clientService
// and _deps.anafLookupService to inject mocks. Production code MUST NOT touch
// _deps directly except in lazy init.
const _deps = {
  clientService: realClientService,
  anafLookupService: realAnafLookupService,
  authMiddleware: realAuthMiddleware,
  logger: realLogger,
};

// ─────────────────────────────────────────────────────────────────────────
// Zod — input validation pe path/query.
// ─────────────────────────────────────────────────────────────────────────

const IdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// `coerce` pe limit/offset/anafVerified pentru că query-string-urile sunt
// întotdeauna stringuri în Express. Default-urile vin din service, dar le
// punem și aici ca să avem un set valid garantat înainte de a apela.
const ListClientsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().max(200).optional(),
  fiscalCodeType: z.enum(['CUI', 'CNP']).optional(),
  // boolean coercion via preprocess: 'true'/'false' (string) → boolean.
  // `z.coerce.boolean()` ar accepta orice non-empty string ca true (inclusiv
  // 'false'), deci preprocesăm explicit.
  anafVerified: z
    .preprocess(
      (v) => (v === 'true' ? true : v === 'false' ? false : v),
      z.boolean().optional()
    )
    .optional(),
});

const LookupCuiBodySchema = z.object({
  cui: z.union([z.string().min(1), z.number().int().positive()]),
  referenceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data trebuie în format YYYY-MM-DD')
    .optional(),
});

// ─────────────────────────────────────────────────────────────────────────
// Router setup
// ─────────────────────────────────────────────────────────────────────────

const router = express.Router();

// authMiddleware pe toate rutele. Wrapper-ul ca să folosim _deps (testabil)
// — Express acceptă direct funcția, dar atunci pierdem indirecția pentru
// injecție în unit tests.
router.use((req, res, next) => _deps.authMiddleware(req, res, next));

// ─────────────────────────────────────────────────────────────────────────
// GET /api/v1/clients
// ─────────────────────────────────────────────────────────────────────────

router.get(
  '/',
  requireRole(['tenant_admin', 'tenant_user']),
  async (req, res, next) => {
    try {
      const query = ListClientsQuerySchema.parse(req.query);
      const result = await _deps.clientService.listClients(
        req.user.tenantSlug,
        query
      );
      return res.status(200).json({
        success: true,
        data: {
          rows: result.rows,
          total: result.total,
          limit: query.limit,
          offset: query.offset,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/clients/lookup-by-cui
//
// Definit ÎNAINTE de `/:id` ca match-ul să se facă pe ruta exactă, NU pe
// `/:id` cu id='lookup-by-cui'. Express folosește ordinea de declarare.
// ─────────────────────────────────────────────────────────────────────────

router.post(
  '/lookup-by-cui',
  requireRole(['tenant_admin', 'tenant_user']),
  anafRateLimit,
  async (req, res, next) => {
    try {
      const { cui, referenceDate } = LookupCuiBodySchema.parse(req.body || {});
      const data = await _deps.anafLookupService.lookupByCui(cui, {
        referenceDate,
      });
      return res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /api/v1/clients/:id
// ─────────────────────────────────────────────────────────────────────────

router.get(
  '/:id',
  requireRole(['tenant_admin', 'tenant_user']),
  async (req, res, next) => {
    try {
      const { id } = IdParamSchema.parse(req.params);
      const row = await _deps.clientService.getClientById(
        req.user.tenantSlug,
        id
      );
      return res.status(200).json({ success: true, data: row });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/clients
// ─────────────────────────────────────────────────────────────────────────

router.post(
  '/',
  requireRole(['tenant_admin', 'tenant_user']),
  async (req, res, next) => {
    try {
      // Body validation = job-ul service-ului (CreateClientFromUiSchema).
      // Aici doar verificăm că e un obiect — protect against `null`/`undefined`
      // care ar arunca pe `Object.keys(undefined)` în service.
      if (
        !req.body ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body)
      ) {
        return res.status(400).json({
          success: false,
          error: 'Body invalid: așteptat un obiect JSON.',
          code: 'VALIDATION_ERROR',
        });
      }
      // `req.user.id` = `tenant_users.id` (claim-ul `user_id` din JWT —
      // adăugat în Stage 5d). Folosit ca `created_by_id` în core_clients.
      const row = await _deps.clientService.createClientFromUi(
        req.user.tenantSlug,
        req.user.id,
        req.body
      );
      _deps.logger.info(
        {
          tenantSlug: req.user.tenantSlug,
          actorEmail: req.user.email,
          clientId: row.id,
        },
        'Client creat via UI'
      );
      return res.status(201).json({ success: true, data: row });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/v1/clients/:id
// ─────────────────────────────────────────────────────────────────────────

router.put(
  '/:id',
  requireRole(['tenant_admin', 'tenant_user']),
  async (req, res, next) => {
    try {
      const { id } = IdParamSchema.parse(req.params);
      if (
        !req.body ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body)
      ) {
        return res.status(400).json({
          success: false,
          error: 'Body invalid: așteptat un obiect JSON.',
          code: 'VALIDATION_ERROR',
        });
      }
      const row = await _deps.clientService.updateClient(
        req.user.tenantSlug,
        id,
        req.body
      );
      _deps.logger.info(
        {
          tenantSlug: req.user.tenantSlug,
          actorEmail: req.user.email,
          clientId: id,
        },
        'Client actualizat'
      );
      return res.status(200).json({ success: true, data: row });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/clients/:id  (tenant_admin ONLY)
// ─────────────────────────────────────────────────────────────────────────

router.delete(
  '/:id',
  requireRole(['tenant_admin']),
  async (req, res, next) => {
    try {
      const { id } = IdParamSchema.parse(req.params);
      const row = await _deps.clientService.softDeleteClient(
        req.user.tenantSlug,
        id
      );
      _deps.logger.info(
        {
          tenantSlug: req.user.tenantSlug,
          actorEmail: req.user.email,
          clientId: id,
        },
        'Client soft-deleted via API'
      );
      return res.status(200).json({
        success: true,
        data: { id: row.id, deleted_at: row.deleted_at },
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
module.exports._deps = _deps;
// Expuse pentru reutilizare în integration tests (verificare shape răspuns).
module.exports.ListClientsQuerySchema = ListClientsQuerySchema;
module.exports.LookupCuiBodySchema = LookupCuiBodySchema;
module.exports.IdParamSchema = IdParamSchema;
