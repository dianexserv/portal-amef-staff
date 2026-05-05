// Teste unitare pentru client-service. Mock-uim `_deps.getTenantPool` și
// `_deps.logger` — query-urile pg sunt simulate prin `vi.fn()` cu rezultate
// preparate. Validăm:
//   - parsing-ul Zod (input shape, refines cross-field)
//   - traseul SQL (parametri și forma query-ului)
//   - mapping-ul PG error → AppError (constraint name → cod custom)
//   - logica de business (NotFoundError pe missing/deleted, ConflictError
//     pe deja-activ etc.)
//
// NU testăm aici idempotența la nivel DB — asta e treaba integration tests
// (vin după 5d când avem fluxul end-to-end prin route + DB real).

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

const clientService = require('./client-service');
const {
  ValidationError,
  NotFoundError,
  ConflictError,
} = require('../errors');
const { z } = require('zod');

const realDeps = { ...clientService._deps };

const TENANT = 'dianex';
const CREATED_BY = 42;

let mockPool;

beforeEach(() => {
  mockPool = { query: vi.fn() };
  clientService._deps.getTenantPool = vi.fn().mockResolvedValue(mockPool);
  clientService._deps.logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
});

afterAll(() => {
  Object.assign(clientService._deps, realDeps);
});

// Helper — construiește o eroare PG-shape (același shape ca node-postgres
// pe care îl prinde mapPgError-ul: `code` SQLSTATE + `constraint` numele).
function pgError(code, constraint) {
  const e = new Error(`PG error code=${code} constraint=${constraint}`);
  e.code = code;
  e.constraint = constraint;
  return e;
}

// Shape complet de input pentru createClientFromUi — orice test poate face
// override pe câmpuri specifice via spread.
const validUiInput = {
  fiscal_code_type: 'CUI',
  fiscal_code: 'RO12345678',
  company_name: 'Test SRL',
  is_vat_payer: false,
  county: 'București',
  city: 'București',
  street: 'Str. Exemplu',
  street_number: '12',
  phone: '+40712345678',
  email: 'contact@test.ro',
  representative_role_id: 1,
  representative_name: 'Ion Popescu',
  representative_ci_number: '123456',
  representative_ci_issued_by: 'SPCLEP București',
  representative_ci_issued_at: '2020-01-15',
  representative_county: 'București',
  representative_city: 'București',
  representative_street: 'Str. Reprezentant',
  representative_street_number: '5',
};

function dbRowFor(input) {
  return {
    id: 1,
    ...input,
    deleted_at: null,
    created_at: new Date('2026-05-05T10:00:00Z'),
    updated_at: new Date('2026-05-05T10:00:00Z'),
    created_by_id: CREATED_BY,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// createClientFromUi
// ─────────────────────────────────────────────────────────────────────────

describe('createClientFromUi', () => {
  it('success: full valid data → INSERT cu RETURNING * și logger.info', async () => {
    const expectedRow = dbRowFor(validUiInput);
    mockPool.query.mockResolvedValueOnce({ rows: [expectedRow] });

    const row = await clientService.createClientFromUi(
      TENANT,
      CREATED_BY,
      validUiInput
    );

    expect(row).toEqual(expectedRow);
    expect(clientService._deps.getTenantPool).toHaveBeenCalledWith(TENANT);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO amef\.core_clients/);
    expect(sql).toMatch(/RETURNING \*/);
    // 34 coloane în INSERT_COLUMNS — params.length trebuie să match.
    expect(params).toHaveLength(34);
    // created_by_id e ultimul în INSERT_COLUMNS → ultimul param.
    expect(params[params.length - 1]).toBe(CREATED_BY);
    expect(clientService._deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantSlug: TENANT, clientId: 1 }),
      'Client creat'
    );
  });

  it('success: doar phone (fără email)', async () => {
    const input = { ...validUiInput, email: undefined };
    mockPool.query.mockResolvedValueOnce({ rows: [dbRowFor(input)] });
    await expect(
      clientService.createClientFromUi(TENANT, CREATED_BY, input)
    ).resolves.toBeDefined();
  });

  it('success: doar email (fără phone)', async () => {
    const input = { ...validUiInput, phone: undefined };
    mockPool.query.mockResolvedValueOnce({ rows: [dbRowFor(input)] });
    await expect(
      clientService.createClientFromUi(TENANT, CREATED_BY, input)
    ).resolves.toBeDefined();
  });

  it('Zod: lipsesc AMBELE phone și email → ZodError pe path phone', async () => {
    const input = { ...validUiInput, phone: undefined, email: undefined };
    await expect(
      clientService.createClientFromUi(TENANT, CREATED_BY, input)
    ).rejects.toThrow(z.ZodError);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('Zod: lipsește representative_name', async () => {
    const { representative_name, ...rest } = validUiInput;
    void representative_name;
    await expect(
      clientService.createClientFromUi(TENANT, CREATED_BY, rest)
    ).rejects.toThrow(z.ZodError);
  });

  it('Zod: lipsește representative_role_id', async () => {
    const { representative_role_id, ...rest } = validUiInput;
    void representative_role_id;
    await expect(
      clientService.createClientFromUi(TENANT, CREATED_BY, rest)
    ).rejects.toThrow(z.ZodError);
  });

  it('Zod: lipsește representative_ci_number', async () => {
    const { representative_ci_number, ...rest } = validUiInput;
    void representative_ci_number;
    await expect(
      clientService.createClientFromUi(TENANT, CREATED_BY, rest)
    ).rejects.toThrow(z.ZodError);
  });

  it('Zod: fiscal_code_type invalid (nici CUI nici CNP)', async () => {
    await expect(
      clientService.createClientFromUi(TENANT, CREATED_BY, {
        ...validUiInput,
        fiscal_code_type: 'XXX',
      })
    ).rejects.toThrow(z.ZodError);
  });

  it('Zod: CUI nu e cifre/RO (refine fiscal_code)', async () => {
    await expect(
      clientService.createClientFromUi(TENANT, CREATED_BY, {
        ...validUiInput,
        fiscal_code_type: 'CUI',
        fiscal_code: 'ABC',
      })
    ).rejects.toThrow(z.ZodError);
  });

  it('Zod: CNP nu are 13 cifre (refine fiscal_code)', async () => {
    await expect(
      clientService.createClientFromUi(TENANT, CREATED_BY, {
        ...validUiInput,
        fiscal_code_type: 'CNP',
        fiscal_code: '123',
      })
    ).rejects.toThrow(z.ZodError);
  });

  it('Zod: email format invalid', async () => {
    await expect(
      clientService.createClientFromUi(TENANT, CREATED_BY, {
        ...validUiInput,
        email: 'nu-e-email',
      })
    ).rejects.toThrow(z.ZodError);
  });

  it('Zod: company_name gol', async () => {
    await expect(
      clientService.createClientFromUi(TENANT, CREATED_BY, {
        ...validUiInput,
        company_name: '',
      })
    ).rejects.toThrow(z.ZodError);
  });

  it('Zod: county lipsă', async () => {
    const { county, ...rest } = validUiInput;
    void county;
    await expect(
      clientService.createClientFromUi(TENANT, CREATED_BY, rest)
    ).rejects.toThrow(z.ZodError);
  });

  it('DB: 23505 pe fiscal_code_unique_active → ConflictError(FISCAL_CODE_DUPLICATE)', async () => {
    mockPool.query.mockRejectedValueOnce(
      pgError('23505', 'fiscal_code_unique_active')
    );
    await expect(
      clientService.createClientFromUi(TENANT, CREATED_BY, validUiInput)
    ).rejects.toMatchObject({
      name: 'ConflictError',
      code: 'FISCAL_CODE_DUPLICATE',
      statusCode: 409,
    });
  });

  it('DB: 23505 pe idx_core_clients_email_unique_active → ConflictError(EMAIL_DUPLICATE)', async () => {
    mockPool.query.mockRejectedValueOnce(
      pgError('23505', 'idx_core_clients_email_unique_active')
    );
    await expect(
      clientService.createClientFromUi(TENANT, CREATED_BY, validUiInput)
    ).rejects.toMatchObject({
      name: 'ConflictError',
      code: 'EMAIL_DUPLICATE',
      statusCode: 409,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// createClientFromImport
// ─────────────────────────────────────────────────────────────────────────

describe('createClientFromImport', () => {
  it('success: shape complet (UI-like) → INSERT', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [dbRowFor(validUiInput)] });
    await expect(
      clientService.createClientFromImport(TENANT, CREATED_BY, validUiInput)
    ).resolves.toBeDefined();
  });

  it('success: TOATE câmpurile representative_* lipsesc → DB acceptă NULL', async () => {
    const partial = {
      fiscal_code_type: 'CUI',
      fiscal_code: 'RO99999999',
      company_name: 'Legacy Drive SRL',
      county: 'Cluj',
      city: 'Cluj-Napoca',
      street: 'Str. Veche',
      street_number: '1',
      phone: '+40700000000',
    };
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ...dbRowFor(partial), id: 99 }],
    });
    const row = await clientService.createClientFromImport(
      TENANT,
      CREATED_BY,
      partial
    );
    expect(row.id).toBe(99);
    // Toate slot-urile representative_* trebuie să fie null (sau undefined-mapped-to-null)
    const params = mockPool.query.mock.calls[0][1];
    // representative_role_id e la index 13 în INSERT_COLUMNS.
    expect(params[13]).toBeNull();
    expect(params[14]).toBeNull(); // representative_name
  });

  it('success: doar phone, fără email, fără representative', async () => {
    const partial = {
      fiscal_code_type: 'CNP',
      fiscal_code: '1234567890123',
      company_name: 'Persoana Fizică',
      county: 'Iași',
      city: 'Iași',
      street: 'Str. Test',
      street_number: '7',
      phone: '+40711111111',
    };
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ...dbRowFor(partial), id: 50 }],
    });
    await expect(
      clientService.createClientFromImport(TENANT, CREATED_BY, partial)
    ).resolves.toBeDefined();
  });

  it('Zod: company_name lipsă (rămâne required la import)', async () => {
    await expect(
      clientService.createClientFromImport(TENANT, CREATED_BY, {
        fiscal_code_type: 'CUI',
        fiscal_code: 'RO12345678',
        county: 'București',
        city: 'București',
        street: 'X',
        street_number: '1',
        phone: '+40700000000',
      })
    ).rejects.toThrow(z.ZodError);
  });

  it('Zod: county lipsă (rămâne required la import)', async () => {
    await expect(
      clientService.createClientFromImport(TENANT, CREATED_BY, {
        fiscal_code_type: 'CUI',
        fiscal_code: 'RO12345678',
        company_name: 'X',
        city: 'București',
        street: 'X',
        street_number: '1',
        phone: '+40700000000',
      })
    ).rejects.toThrow(z.ZodError);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// getClientById
// ─────────────────────────────────────────────────────────────────────────

describe('getClientById', () => {
  it('success: id existent activ → row', async () => {
    const row = dbRowFor(validUiInput);
    mockPool.query.mockResolvedValueOnce({ rows: [row] });
    await expect(clientService.getClientById(TENANT, 1)).resolves.toEqual(row);
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/deleted_at IS NULL/);
  });

  it('id inexistent → NotFoundError', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(clientService.getClientById(TENANT, 999)).rejects.toThrow(
      NotFoundError
    );
  });

  it('id soft-deleted → NotFoundError (filtrul WHERE)', async () => {
    // Service-ul aplică `deleted_at IS NULL` în query → DB returnează 0 rânduri.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(clientService.getClientById(TENANT, 1)).rejects.toThrow(
      NotFoundError
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// findClientByFiscalCode
// ─────────────────────────────────────────────────────────────────────────

describe('findClientByFiscalCode', () => {
  it('găsit activ → row', async () => {
    const row = dbRowFor(validUiInput);
    mockPool.query.mockResolvedValueOnce({ rows: [row] });
    await expect(
      clientService.findClientByFiscalCode(TENANT, 'RO12345678')
    ).resolves.toEqual(row);
  });

  it('inexistent → null (NU aruncă)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      clientService.findClientByFiscalCode(TENANT, 'RO00000000')
    ).resolves.toBeNull();
  });

  it('soft-deleted → null (filtrul deleted_at IS NULL)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      clientService.findClientByFiscalCode(TENANT, 'RO12345678')
    ).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// findClientByEmail
// ─────────────────────────────────────────────────────────────────────────

describe('findClientByEmail', () => {
  it('găsit activ → row', async () => {
    const row = dbRowFor(validUiInput);
    mockPool.query.mockResolvedValueOnce({ rows: [row] });
    await expect(
      clientService.findClientByEmail(TENANT, 'contact@test.ro')
    ).resolves.toEqual(row);
  });

  it('inexistent → null', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      clientService.findClientByEmail(TENANT, 'nope@nowhere.ro')
    ).resolves.toBeNull();
  });

  it('soft-deleted → null', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      clientService.findClientByEmail(TENANT, 'contact@test.ro')
    ).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// listClients
// ─────────────────────────────────────────────────────────────────────────

describe('listClients', () => {
  it('paginare default (limit=20, offset=0) → { rows, total }', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ total: 3 }] })
      .mockResolvedValueOnce({ rows: [dbRowFor(validUiInput)] });

    const result = await clientService.listClients(TENANT);
    expect(result.total).toBe(3);
    expect(result.rows).toHaveLength(1);

    // Al doilea query — verifică LIMIT/OFFSET
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(sql).toMatch(/LIMIT \$1 OFFSET \$2/);
    expect(params).toEqual([20, 0]);
  });

  it('limit + offset custom', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ total: 100 }] })
      .mockResolvedValueOnce({ rows: [] });

    await clientService.listClients(TENANT, { limit: 50, offset: 50 });
    expect(mockPool.query.mock.calls[1][1]).toEqual([50, 50]);
  });

  it('search → ILIKE pe company_name', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [dbRowFor(validUiInput)] });

    await clientService.listClients(TENANT, { search: 'Dianex' });
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/company_name ILIKE/);
    expect(params).toEqual(['%Dianex%', 20, 0]);
  });

  it('fiscalCodeType=CUI', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    await clientService.listClients(TENANT, { fiscalCodeType: 'CUI' });
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/fiscal_code_type = \$1/);
    expect(params[0]).toBe('CUI');
  });

  it('anafVerified=true', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    await clientService.listClients(TENANT, { anafVerified: true });
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/anaf_verified = \$1/);
    expect(params[0]).toBe(true);
  });

  it('combinație filtre + paginare', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ total: 5 }] })
      .mockResolvedValueOnce({ rows: [] });

    await clientService.listClients(TENANT, {
      limit: 10,
      offset: 20,
      search: 'test',
      fiscalCodeType: 'CNP',
      anafVerified: false,
    });
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/company_name ILIKE/);
    expect(sql).toMatch(/fiscal_code_type =/);
    expect(sql).toMatch(/anaf_verified =/);
    // Order: search, fiscalCodeType, anafVerified, limit, offset
    expect(params).toEqual(['%test%', 'CNP', false, 10, 20]);
  });

  it('empty → { rows: [], total: 0 }', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await clientService.listClients(TENANT);
    expect(result).toEqual({ rows: [], total: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// updateClient
// ─────────────────────────────────────────────────────────────────────────

describe('updateClient', () => {
  it('partial: doar phone → SET phone + updated_at', async () => {
    const row = { ...dbRowFor(validUiInput), phone: '+40799999999' };
    mockPool.query.mockResolvedValueOnce({ rows: [row] });

    const updated = await clientService.updateClient(TENANT, 1, {
      phone: '+40799999999',
    });
    expect(updated.phone).toBe('+40799999999');
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/SET phone = \$1, updated_at = NOW\(\)/);
    expect(sql).toMatch(/WHERE id = \$2 AND deleted_at IS NULL/);
    expect(params).toEqual(['+40799999999', 1]);
  });

  it('multiple câmpuri (phone + notes + iban)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [dbRowFor(validUiInput)],
    });
    await clientService.updateClient(TENANT, 1, {
      phone: '+40700111222',
      notes: 'Updated notes',
      iban: 'RO49AAAA1234567890123456',
    });
    const [sql, params] = mockPool.query.mock.calls[0];
    // 3 câmpuri + id (updated_at = NOW() e literal, fără param)
    expect(params).toHaveLength(4);
    // Toate cele 3 câmpuri apar în SET (ordinea e dictată de schema Zod
    // după merge — verificăm prezența, nu poziția exactă).
    expect(sql).toMatch(/phone =/);
    expect(sql).toMatch(/notes =/);
    expect(sql).toMatch(/iban =/);
    expect(sql).toMatch(/updated_at = NOW\(\)/);
    expect(sql).toMatch(/WHERE id = \$4/);
  });

  it('id inexistent → NotFoundError', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      clientService.updateClient(TENANT, 999, { phone: '+40700000000' })
    ).rejects.toThrow(NotFoundError);
  });

  it('DB: 23505 pe email unique → ConflictError(EMAIL_DUPLICATE)', async () => {
    mockPool.query.mockRejectedValueOnce(
      pgError('23505', 'idx_core_clients_email_unique_active')
    );
    await expect(
      clientService.updateClient(TENANT, 1, { email: 'taken@test.ro' })
    ).rejects.toMatchObject({
      name: 'ConflictError',
      code: 'EMAIL_DUPLICATE',
    });
  });

  it('Zod: email format invalid → ZodError', async () => {
    await expect(
      clientService.updateClient(TENANT, 1, { email: 'invalid-email' })
    ).rejects.toThrow(z.ZodError);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// softDeleteClient
// ─────────────────────────────────────────────────────────────────────────

describe('softDeleteClient', () => {
  it('success: deleted_at = NOW(), returnează rândul', async () => {
    const row = { ...dbRowFor(validUiInput), deleted_at: new Date() };
    mockPool.query.mockResolvedValueOnce({ rows: [row] });

    const result = await clientService.softDeleteClient(TENANT, 1);
    expect(result.deleted_at).toBeInstanceOf(Date);
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/SET deleted_at = NOW\(\)/);
    expect(sql).toMatch(/WHERE id = \$1 AND deleted_at IS NULL/);
    expect(clientService._deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantSlug: TENANT, clientId: 1 }),
      'Client soft-deleted'
    );
  });

  it('id inexistent → NotFoundError', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(clientService.softDeleteClient(TENANT, 999)).rejects.toThrow(
      NotFoundError
    );
  });

  it('deja șters → NotFoundError (același traseu, 0 rânduri)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(clientService.softDeleteClient(TENANT, 1)).rejects.toThrow(
      NotFoundError
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// restoreClient
// ─────────────────────────────────────────────────────────────────────────

describe('restoreClient', () => {
  it('success: deleted_at NU mai e null, returnează rândul', async () => {
    const restored = { ...dbRowFor(validUiInput), deleted_at: null };
    mockPool.query
      // 1) check — deleted_at non-null (e șters, deci poate fi restored)
      .mockResolvedValueOnce({ rows: [{ deleted_at: new Date() }] })
      // 2) UPDATE
      .mockResolvedValueOnce({ rows: [restored] });

    const result = await clientService.restoreClient(TENANT, 1);
    expect(result.deleted_at).toBeNull();
    expect(mockPool.query).toHaveBeenCalledTimes(2);
    expect(clientService._deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantSlug: TENANT, clientId: 1 }),
      'Client restored'
    );
  });

  it('id inexistent → NotFoundError (check returnează 0 rânduri)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(clientService.restoreClient(TENANT, 999)).rejects.toThrow(
      NotFoundError
    );
    // Update-ul NU trebuie să se execute
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('deja activ (deleted_at IS NULL) → ConflictError', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ deleted_at: null }] });
    await expect(clientService.restoreClient(TENANT, 1)).rejects.toThrow(
      ConflictError
    );
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// _mapPgError — direct testing pentru ramurile rămase neacoperite din mapping
// (cele care nu se reproduc natural prin call-urile publice de mai sus).
// ─────────────────────────────────────────────────────────────────────────

describe('_mapPgError (direct)', () => {
  it('23514 phone_or_email_required → ValidationError(PHONE_OR_EMAIL_REQUIRED)', () => {
    const mapped = clientService._mapPgError(
      pgError('23514', 'phone_or_email_required')
    );
    expect(mapped).toBeInstanceOf(ValidationError);
    expect(mapped.code).toBe('PHONE_OR_EMAIL_REQUIRED');
  });

  it('23514 core_clients_fiscal_code_type_check → ValidationError(INVALID_FISCAL_CODE_TYPE)', () => {
    const mapped = clientService._mapPgError(
      pgError('23514', 'core_clients_fiscal_code_type_check')
    );
    expect(mapped).toBeInstanceOf(ValidationError);
    expect(mapped.code).toBe('INVALID_FISCAL_CODE_TYPE');
  });

  it('23503 representative_role FK → ValidationError(REPRESENTATIVE_ROLE_INVALID)', () => {
    const mapped = clientService._mapPgError(
      pgError('23503', 'core_clients_representative_role_id_fkey')
    );
    expect(mapped).toBeInstanceOf(ValidationError);
    expect(mapped.code).toBe('REPRESENTATIVE_ROLE_INVALID');
  });

  it('PG error necunoscut → re-throw original', () => {
    const orig = pgError('42P01', 'undefined_table');
    expect(clientService._mapPgError(orig)).toBe(orig);
  });

  it('23505 cu constraint necunoscut → re-throw (nu match niciun branch)', () => {
    const orig = pgError('23505', 'unknown_constraint');
    expect(clientService._mapPgError(orig)).toBe(orig);
  });

  it('23514 cu constraint necunoscut → re-throw', () => {
    const orig = pgError('23514', 'unknown_check');
    expect(clientService._mapPgError(orig)).toBe(orig);
  });

  it('null/undefined input → returnează ca-i (defensive)', () => {
    expect(clientService._mapPgError(null)).toBeNull();
    expect(clientService._mapPgError(undefined)).toBeUndefined();
  });
});
