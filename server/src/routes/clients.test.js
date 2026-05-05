// Unit tests pentru rutele de clienți. Mock-uim clientService și
// anafLookupService prin _deps; integration tests cu DB real sunt în
// tests/integration/clients.integration.test.js.

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'silent');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');
vi.stubEnv(
  'FIREBASE_SERVICE_ACCOUNT_SECRET_NAME',
  'firebase-service-account-test'
);

const express = require('express');
const request = require('supertest');

const clientsRouter = require('./clients');
const errorHandler = require('../middleware/error-handler');
const {
  ValidationError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError,
} = require('../errors');
const { z } = require('zod');

const { _deps } = clientsRouter;
const realDeps = { ..._deps };

// Mini-app care montează routerul + error handler. Folosim un middleware
// fals de auth înainte ca să simulăm un user autentificat — _deps.authMiddleware
// e mock-uit ca să populeze req.user fără a atinge JWT real.
function makeApp({ role = 'tenant_admin', tenantSlug = 'dianex' } = {}) {
  const app = express();
  app.use(express.json());
  // Mock authMiddleware via _deps — apelat de wrapper-ul din router.
  _deps.authMiddleware = vi.fn(async (req, _res, next) => {
    req.user = {
      firebaseUid: 'fb-1',
      email: 'a@b.ro',
      tenantSlug,
      tenantId: 1,
      id: 7, // tenant_users.id
      role,
      jti: 'j1',
    };
    next();
  });
  app.use('/clients', clientsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  _deps.clientService = {
    listClients: vi.fn(),
    getClientById: vi.fn(),
    createClientFromUi: vi.fn(),
    updateClient: vi.fn(),
    softDeleteClient: vi.fn(),
  };
  _deps.anafLookupService = {
    lookupByCui: vi.fn(),
  };
  _deps.logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
});

afterAll(() => {
  Object.assign(_deps, realDeps);
});

const FAKE_CLIENT_ROW = {
  id: 1,
  fiscal_code: 'RO12345678',
  fiscal_code_type: 'CUI',
  company_name: 'Test SRL',
  deleted_at: null,
  created_at: '2026-05-05T10:00:00Z',
};

// ─────────────────────────────────────────────────────────────────────────
// GET /clients
// ─────────────────────────────────────────────────────────────────────────

describe('GET /clients', () => {
  it('default params → 200 + service called cu defaults (limit=20, offset=0)', async () => {
    _deps.clientService.listClients.mockResolvedValue({
      rows: [FAKE_CLIENT_ROW],
      total: 1,
    });
    const app = makeApp();
    const res = await request(app).get('/clients');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.rows).toHaveLength(1);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.limit).toBe(20);
    expect(res.body.data.offset).toBe(0);
    expect(_deps.clientService.listClients).toHaveBeenCalledWith(
      'dianex',
      expect.objectContaining({ limit: 20, offset: 0 })
    );
  });

  it('limit + offset custom → service primește integer-uri parsate', async () => {
    _deps.clientService.listClients.mockResolvedValue({ rows: [], total: 0 });
    const app = makeApp();
    await request(app).get('/clients?limit=50&offset=100');
    expect(_deps.clientService.listClients).toHaveBeenCalledWith(
      'dianex',
      expect.objectContaining({ limit: 50, offset: 100 })
    );
  });

  it('search filter → forward-at la service', async () => {
    _deps.clientService.listClients.mockResolvedValue({ rows: [], total: 0 });
    const app = makeApp();
    await request(app).get('/clients?search=Dianex&fiscalCodeType=CUI&anafVerified=true');
    expect(_deps.clientService.listClients).toHaveBeenCalledWith(
      'dianex',
      expect.objectContaining({
        search: 'Dianex',
        fiscalCodeType: 'CUI',
        anafVerified: true,
      })
    );
  });

  it('limit invalid (abc) → 400 ZodError', async () => {
    const app = makeApp();
    const res = await request(app).get('/clients?limit=abc');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('fără auth (authMiddleware mock care aruncă) → 401', async () => {
    const app = express();
    app.use(express.json());
    _deps.authMiddleware = vi.fn(async (req, _res, next) => {
      const { UnauthorizedError } = require('../errors');
      next(new UnauthorizedError('No token'));
    });
    app.use('/clients', clientsRouter);
    app.use(errorHandler);
    const res = await request(app).get('/clients');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /clients/:id
// ─────────────────────────────────────────────────────────────────────────

describe('GET /clients/:id', () => {
  it('id valid → 200 cu rândul', async () => {
    _deps.clientService.getClientById.mockResolvedValue(FAKE_CLIENT_ROW);
    const app = makeApp();
    const res = await request(app).get('/clients/1');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(1);
    expect(_deps.clientService.getClientById).toHaveBeenCalledWith('dianex', 1);
  });

  it("id='abc' → 400 ZodError", async () => {
    const app = makeApp();
    const res = await request(app).get('/clients/abc');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('service aruncă NotFoundError → 404', async () => {
    _deps.clientService.getClientById.mockRejectedValue(
      new NotFoundError('Clientul cu id=1 nu există')
    );
    const app = makeApp();
    const res = await request(app).get('/clients/1');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /clients
// ─────────────────────────────────────────────────────────────────────────

describe('POST /clients', () => {
  const validBody = {
    fiscal_code_type: 'CUI',
    fiscal_code: 'RO12345678',
    company_name: 'Test SRL',
    county: 'București',
    city: 'București',
    street: 'X',
    street_number: '1',
    phone: '+40700000000',
    representative_role_id: 1,
    representative_name: 'Ion',
    representative_ci_number: '123',
    representative_ci_issued_by: 'SPCLEP',
    representative_ci_issued_at: '2020-01-01',
    representative_county: 'București',
    representative_city: 'București',
    representative_street: 'Y',
    representative_street_number: '2',
  };

  it('body valid → 201 cu rândul nou', async () => {
    _deps.clientService.createClientFromUi.mockResolvedValue(FAKE_CLIENT_ROW);
    const app = makeApp();
    const res = await request(app).post('/clients').send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(1);
    expect(_deps.clientService.createClientFromUi).toHaveBeenCalledWith(
      'dianex',
      7, // req.user.id
      validBody
    );
  });

  it('service aruncă ZodError → 400', async () => {
    _deps.clientService.createClientFromUi.mockRejectedValue(
      new z.ZodError([
        { code: 'invalid_type', path: ['fiscal_code'], message: 'Required' },
      ])
    );
    const app = makeApp();
    const res = await request(app).post('/clients').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('service aruncă ConflictError(FISCAL_CODE_DUPLICATE) → 409', async () => {
    const err = new ConflictError('Există deja un client cu acest cod fiscal');
    err.code = 'FISCAL_CODE_DUPLICATE';
    _deps.clientService.createClientFromUi.mockRejectedValue(err);
    const app = makeApp();
    const res = await request(app).post('/clients').send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FISCAL_CODE_DUPLICATE');
  });

  it('service aruncă ConflictError(EMAIL_DUPLICATE) → 409', async () => {
    const err = new ConflictError('Există deja un client cu acest email');
    err.code = 'EMAIL_DUPLICATE';
    _deps.clientService.createClientFromUi.mockRejectedValue(err);
    const app = makeApp();
    const res = await request(app).post('/clients').send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_DUPLICATE');
  });

  it('body null → 400 cu cod VALIDATION_ERROR', async () => {
    const app = makeApp();
    // Trimitem un array în loc de obiect — defensive check pentru body shape.
    const res = await request(app).post('/clients').send([]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /clients/:id
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /clients/:id', () => {
  it('valid → 200 + service primit body parțial', async () => {
    _deps.clientService.updateClient.mockResolvedValue({
      ...FAKE_CLIENT_ROW,
      phone: '+40712345678',
    });
    const app = makeApp();
    const res = await request(app)
      .put('/clients/1')
      .send({ phone: '+40712345678' });
    expect(res.status).toBe(200);
    expect(res.body.data.phone).toBe('+40712345678');
    expect(_deps.clientService.updateClient).toHaveBeenCalledWith(
      'dianex',
      1,
      { phone: '+40712345678' }
    );
  });

  it('service aruncă NotFoundError → 404', async () => {
    _deps.clientService.updateClient.mockRejectedValue(
      new NotFoundError('Clientul cu id=99 nu există')
    );
    const app = makeApp();
    const res = await request(app).put('/clients/99').send({ phone: 'x' });
    expect(res.status).toBe(404);
  });

  it('service aruncă ConflictError(EMAIL_DUPLICATE) → 409', async () => {
    const err = new ConflictError('Email deja folosit');
    err.code = 'EMAIL_DUPLICATE';
    _deps.clientService.updateClient.mockRejectedValue(err);
    const app = makeApp();
    const res = await request(app).put('/clients/1').send({ email: 'a@b.ro' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_DUPLICATE');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /clients/:id
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /clients/:id', () => {
  it('tenant_admin → 200 cu { id, deleted_at }', async () => {
    const deletedAt = '2026-05-05T12:00:00Z';
    _deps.clientService.softDeleteClient.mockResolvedValue({
      ...FAKE_CLIENT_ROW,
      deleted_at: deletedAt,
    });
    const app = makeApp({ role: 'tenant_admin' });
    const res = await request(app).delete('/clients/1');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 1, deleted_at: deletedAt });
  });

  it('tenant_user → 403 (requireRole îl respinge)', async () => {
    const app = makeApp({ role: 'tenant_user' });
    const res = await request(app).delete('/clients/1');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    // Service NU a fost apelat — gardul rolului a oprit înainte
    expect(_deps.clientService.softDeleteClient).not.toHaveBeenCalled();
  });

  it('service aruncă NotFoundError → 404', async () => {
    _deps.clientService.softDeleteClient.mockRejectedValue(
      new NotFoundError('not found')
    );
    const app = makeApp({ role: 'tenant_admin' });
    const res = await request(app).delete('/clients/1');
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /clients/lookup-by-cui
// ─────────────────────────────────────────────────────────────────────────

describe('POST /clients/lookup-by-cui', () => {
  const lookupResult = {
    cui: '1234567',
    denumire: 'EXAMPLE SRL',
    is_vat_payer: true,
    stale: false,
  };

  it('cui valid → 200 + service.lookupByCui apelat', async () => {
    _deps.anafLookupService.lookupByCui.mockResolvedValue(lookupResult);
    const app = makeApp();
    const res = await request(app)
      .post('/clients/lookup-by-cui')
      .send({ cui: 'RO1234567', referenceDate: '2026-05-05' });
    expect(res.status).toBe(200);
    expect(res.body.data.denumire).toBe('EXAMPLE SRL');
    expect(_deps.anafLookupService.lookupByCui).toHaveBeenCalledWith(
      'RO1234567',
      { referenceDate: '2026-05-05' }
    );
  });

  it('body invalid (cui lipsă) → 400 ZodError', async () => {
    const app = makeApp();
    const res = await request(app).post('/clients/lookup-by-cui').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('referenceDate format greșit → 400', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/clients/lookup-by-cui')
      .send({ cui: '1234567', referenceDate: '5 mai 2026' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('service aruncă NotFoundError → 404', async () => {
    const err = new NotFoundError('CUI nu există la ANAF');
    err.code = 'CUI_NOT_FOUND_AT_ANAF';
    _deps.anafLookupService.lookupByCui.mockRejectedValue(err);
    const app = makeApp();
    const res = await request(app)
      .post('/clients/lookup-by-cui')
      .send({ cui: '1234567' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUI_NOT_FOUND_AT_ANAF');
  });

  it('service aruncă ServiceUnavailableError → 503', async () => {
    const err = new ServiceUnavailableError('ANAF e jos');
    err.code = 'ANAF_UNAVAILABLE';
    _deps.anafLookupService.lookupByCui.mockRejectedValue(err);
    const app = makeApp();
    const res = await request(app)
      .post('/clients/lookup-by-cui')
      .send({ cui: '1234567' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ANAF_UNAVAILABLE');
  });

  it('service aruncă ValidationError(INVALID_CUI) → 400', async () => {
    const err = new ValidationError('CUI invalid');
    err.code = 'INVALID_CUI';
    _deps.anafLookupService.lookupByCui.mockRejectedValue(err);
    const app = makeApp();
    const res = await request(app)
      .post('/clients/lookup-by-cui')
      .send({ cui: 'XYZ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CUI');
  });
});
