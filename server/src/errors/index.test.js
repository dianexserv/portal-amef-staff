// Teste pentru clasele de eroare custom. Modulul e pur (no I/O), nu necesită
// stubEnv pentru config — îl testăm direct.

const {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError,
} = require('./index');

describe('clase de eroare — proprietăți comune', () => {
  it('toate moștenesc Error și AppError (instanceof)', () => {
    const cases = [
      new ValidationError('x'),
      new UnauthorizedError('x'),
      new ForbiddenError('x'),
      new NotFoundError('x'),
      new ConflictError('x'),
      new ServiceUnavailableError('x'),
    ];
    for (const err of cases) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(AppError);
    }
  });

  it('păstrează mesajul transmis', () => {
    expect(new ValidationError('CUI invalid').message).toBe('CUI invalid');
    expect(new NotFoundError('client lipsește').message).toBe(
      'client lipsește'
    );
  });

  it('numele clasei e setat corect (pentru log-uri structurate)', () => {
    expect(new ValidationError('x').name).toBe('ValidationError');
    expect(new UnauthorizedError('x').name).toBe('UnauthorizedError');
    expect(new ForbiddenError('x').name).toBe('ForbiddenError');
    expect(new NotFoundError('x').name).toBe('NotFoundError');
    expect(new ConflictError('x').name).toBe('ConflictError');
  });

  it('au stack trace (Error.captureStackTrace)', () => {
    const err = new ValidationError('x');
    expect(typeof err.stack).toBe('string');
    expect(err.stack.length).toBeGreaterThan(0);
  });
});

describe('ValidationError', () => {
  it('statusCode=400, code=VALIDATION_ERROR', () => {
    const err = new ValidationError('CUI invalid');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('acceptă details opțional (lista de field-uri invalide)', () => {
    const err = new ValidationError('Date invalide', [
      { field: 'cui', message: 'min 2 char' },
    ]);
    expect(err.details).toEqual([{ field: 'cui', message: 'min 2 char' }]);
  });

  it('fără details, proprietatea NU există pe instanță', () => {
    const err = new ValidationError('x');
    expect('details' in err).toBe(false);
  });
});

describe('UnauthorizedError', () => {
  it('statusCode=401, code=UNAUTHORIZED', () => {
    const err = new UnauthorizedError('JWT lipsește');
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  });
});

describe('ForbiddenError', () => {
  it('statusCode=403, code=FORBIDDEN', () => {
    const err = new ForbiddenError('Rol insuficient');
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
  });
});

describe('NotFoundError', () => {
  it('statusCode=404, code=NOT_FOUND', () => {
    const err = new NotFoundError('Client #42 nu există');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('ConflictError', () => {
  it('statusCode=409, code=CONFLICT', () => {
    const err = new ConflictError('CUI deja folosit');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CONFLICT');
  });

  it('details pot fi orice tip serializabil JSON', () => {
    const err = new ConflictError('conflict', { existingId: 7 });
    expect(err.details).toEqual({ existingId: 7 });
  });
});

describe('ServiceUnavailableError', () => {
  it('statusCode=503, code=SERVICE_UNAVAILABLE (default)', () => {
    const err = new ServiceUnavailableError('ANAF e jos');
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('cod custom setabil pe instanță (mutație post-construcție, ca în client-service)', () => {
    const err = new ServiceUnavailableError('ANAF unavailable');
    err.code = 'ANAF_UNAVAILABLE';
    expect(err.code).toBe('ANAF_UNAVAILABLE');
    expect(err.statusCode).toBe(503);
  });
});
