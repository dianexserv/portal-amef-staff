// Teste pentru error-handler middleware. Folosim un res fake (status/json
// chained) ca să verificăm payload-ul fără a porni Express.

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'silent');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');
vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_SECRET_NAME', 'firebase-service-account-test');

const { z } = require('zod');
const errorHandlerMod = require('./error-handler');
const { errorHandler, _deps } = errorHandlerMod;
const config = require('../config');
const {
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} = require('../errors');

const realDeps = { ..._deps };

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function makeReq() {
  return { id: 'req-test-1', method: 'GET', originalUrl: '/test' };
}

beforeEach(() => {
  _deps.logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  _deps.getNodeEnv = () => 'production';
});

afterAll(() => {
  Object.assign(_deps, realDeps);
});

describe('errorHandler — erori AppError', () => {
  it('ValidationError → 400 cu code și details', () => {
    const res = makeRes();
    errorHandler(
      new ValidationError('CUI invalid', [{ field: 'cui' }]),
      makeReq(),
      res,
      vi.fn()
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'CUI invalid',
      code: 'VALIDATION_ERROR',
      details: [{ field: 'cui' }],
    });
  });

  it('ValidationError fără details → fără cheia details în body', () => {
    const res = makeRes();
    errorHandler(new ValidationError('x'), makeReq(), res, vi.fn());
    expect(res.body).toEqual({
      success: false,
      error: 'x',
      code: 'VALIDATION_ERROR',
    });
    expect('details' in res.body).toBe(false);
  });

  it('UnauthorizedError → 401', () => {
    const res = makeRes();
    errorHandler(
      new UnauthorizedError('JWT lipsește'),
      makeReq(),
      res,
      vi.fn()
    );
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('ForbiddenError → 403', () => {
    const res = makeRes();
    errorHandler(new ForbiddenError('Rol insuficient'), makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('NotFoundError → 404', () => {
    const res = makeRes();
    errorHandler(new NotFoundError('Client #42'), makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('ConflictError → 409', () => {
    const res = makeRes();
    errorHandler(new ConflictError('CUI duplicat'), makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });
});

describe('errorHandler — ZodError', () => {
  it('ZodError → 400 cu lista de issues în details', () => {
    const schema = z.object({
      cui: z.string().min(2),
      name: z.string().min(1),
    });
    const result = schema.safeParse({ cui: 'X', name: '' });
    expect(result.success).toBe(false);

    const res = makeRes();
    errorHandler(result.error, makeReq(), res, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.error).toBe('Date invalide');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details).toHaveLength(2);
    expect(res.body.details[0]).toMatchObject({ path: 'cui' });
    expect(res.body.details[1]).toMatchObject({ path: 'name' });
  });
});

describe('errorHandler — erori HTTP din middleware-uri externe', () => {
  it('eroare cu statusCode=413 (PayloadTooLargeError din body-parser) → 413', () => {
    const err = Object.assign(new Error('request entity too large'), {
      statusCode: 413,
      type: 'entity.too.large',
    });
    const res = makeRes();
    errorHandler(err, makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({
      success: false,
      error: 'request entity too large',
      code: 'entity.too.large',
    });
  });

  it('eroare 4xx fără code/type → cade pe CLIENT_ERROR', () => {
    const err = Object.assign(new Error('bad request'), { statusCode: 400 });
    const res = makeRes();
    errorHandler(err, makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('CLIENT_ERROR');
  });

  it('eroare cu statusCode=500 NU e expusă direct (cade pe ramura generic)', () => {
    const err = Object.assign(new Error('database down'), { statusCode: 500 });
    const res = makeRes();
    errorHandler(err, makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toBe('A apărut o eroare internă');
  });
});

describe('errorHandler — eroare generică', () => {
  it('Eroare necunoscută → 500 cu code INTERNAL_ERROR', () => {
    const res = makeRes();
    errorHandler(new Error('boom DB'), makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });

  it('în production: NU leak-uiește mesajul brut', () => {
    // NODE_ENV=production via stubEnv; default _deps.getNodeEnv returnează 'production'.
    expect(config.NODE_ENV).toBe('production');
    const res = makeRes();
    errorHandler(
      new Error('SECRET_LEAK: connection string ...'),
      makeReq(),
      res,
      vi.fn()
    );
    expect(res.body.error).toBe('A apărut o eroare internă');
    expect(res.body.stack).toBeUndefined();
  });

  it('în development: include err.message și stack pentru triage', () => {
    // Suprascriem _deps.getNodeEnv ca să simulăm dev fără re-import
    // (config e frozen la load time, nu putem muta NODE_ENV pe el direct).
    _deps.getNodeEnv = () => 'development';
    const err = new Error('detaliu de debug');
    const res = makeRes();
    errorHandler(err, makeReq(), res, vi.fn());
    expect(res.body.error).toBe('detaliu de debug');
    expect(typeof res.body.stack).toBe('string');
    expect(res.body.stack).toContain('Error: detaliu de debug');
  });
});

describe('errorHandler — branches edge', () => {
  it('default _deps.getNodeEnv() returnează config.NODE_ENV', () => {
    // Restaurăm fabrica originală (suprascrisă în beforeEach pentru control).
    _deps.getNodeEnv = realDeps.getNodeEnv;
    expect(_deps.getNodeEnv()).toBe(config.NODE_ENV);
    expect(_deps.getNodeEnv()).toBe('production');
  });

  it('ZodError cu issue.path = [] → "<root>" în details', () => {
    const err = new z.ZodError([
      { path: [], message: 'Required', code: 'custom' },
    ]);
    const res = makeRes();
    errorHandler(err, makeReq(), res, vi.fn());
    expect(res.body.details[0].path).toBe('<root>');
  });

  it('4xx error fără mesaj → fallback "Cerere invalidă"', () => {
    const err = Object.assign(new Error(), { statusCode: 400 });
    err.message = '';
    const res = makeRes();
    errorHandler(err, makeReq(), res, vi.fn());
    expect(res.body.error).toBe('Cerere invalidă');
    expect(res.body.code).toBe('CLIENT_ERROR');
  });

  it('4xx error cu err.code custom → propagă code-ul', () => {
    const err = Object.assign(new Error('rate limited'), {
      statusCode: 429,
      code: 'CUSTOM_RATE_LIMIT',
    });
    const res = makeRes();
    errorHandler(err, makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('CUSTOM_RATE_LIMIT');
  });

  it('în development cu err.message gol → menține mesajul generic', () => {
    _deps.getNodeEnv = () => 'development';
    const err = new Error('');
    const res = makeRes();
    errorHandler(err, makeReq(), res, vi.fn());
    expect(res.body.error).toBe('A apărut o eroare internă');
  });

  it('în development cu err.stack absent → fără stack în body', () => {
    _deps.getNodeEnv = () => 'development';
    const err = new Error('msg');
    delete err.stack;
    const res = makeRes();
    errorHandler(err, makeReq(), res, vi.fn());
    expect(res.body.stack).toBeUndefined();
    expect(res.body.error).toBe('msg');
  });
});

describe('errorHandler — logging', () => {
  it('apelează logger.error cu err + requestId + method + url', () => {
    errorHandler(new ValidationError('x'), makeReq(), makeRes(), vi.fn());
    expect(_deps.logger.error).toHaveBeenCalledTimes(1);
    const [bindings, msg] = _deps.logger.error.mock.calls[0];
    expect(bindings).toMatchObject({
      requestId: 'req-test-1',
      method: 'GET',
      url: '/test',
    });
    expect(bindings.err).toBeInstanceOf(Error);
    expect(typeof msg).toBe('string');
  });

  it('tolerează lipsa req (utility apel direct fără Express)', () => {
    const res = makeRes();
    expect(() =>
      errorHandler(new ValidationError('x'), undefined, res, vi.fn())
    ).not.toThrow();
    expect(res.statusCode).toBe(400);
  });
});
