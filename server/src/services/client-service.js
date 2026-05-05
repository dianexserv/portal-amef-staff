// Service layer pentru modulul Clienți (sub-stage 5b).
//
// Responsabilități:
//   - Validare input cu Zod (schema partajată între UI și Drive import).
//   - CRUD pe `amef.core_clients` cu maparea erorilor PG → AppError.
//   - Soft-delete + restore (deleted_at).
//
// NU sunt în scope (vin în 5c+):
//   - Apel ANAF webservice (5c — `anaf-lookup-service.js`).
//   - Routes / Express handlers (5d).
//   - UI (5e).
//
// Decizii cheie:
//   - Două „moduri" de creare: `createClientFromUi` cu reprezentant complet
//     (validare strictă pentru clienți noi din UI) și `createClientFromImport`
//     cu reprezentant parțial (date legacy din Drive — Stage 13). Schemele
//     împart secțiunile comune via `.merge()` ca să fie un singur loc unde
//     se modifică regula pentru un câmp.
//   - Erorile PG sunt mapate explicit pe constraint name (NU pe mesaj —
//     mesajele sunt locale). Pentru fiecare constraint cunoscut un cod
//     stabil pentru frontend (`FISCAL_CODE_DUPLICATE`, `EMAIL_DUPLICATE`
//     etc.); orice altă eroare PG e re-aruncată ca-i, urmând să cadă pe
//     INTERNAL_ERROR în error-handler-ul central.
//   - Codul „custom" pe AppError (ex: FISCAL_CODE_DUPLICATE) e setat pe
//     instanță (mutație post-construcție) — clasele din `errors/` au
//     coduri default fixe; mutația permite codarea precisă fără a sparge
//     contractul claselor. `setErrorCode` izolează acest pattern.
//   - SQL parametrizat ($1, $2, …) la fiecare query — nicio interpolare
//     de string-uri. Coloanele sunt enumerate într-un tablou constant
//     (`INSERT_COLUMNS`) — single source of truth pentru INSERT.
//
// Test seam `_deps`: testele rescriu `_deps.getTenantPool` și `_deps.logger`
// cu mock-uri. Producția nu atinge `_deps` decât pentru a citi.

const { z } = require('zod');
const realPool = require('../db/pool');
const realLogger = require('../logger');
const {
  ValidationError,
  NotFoundError,
  ConflictError,
} = require('../errors');

// _deps object exported strictly for testing. Tests mutate _deps.getTenantPool
// /_deps.logger to inject mocks. Production code MUST NOT touch _deps directly
// except in lazy init.
const _deps = {
  getTenantPool: realPool.getTenantPool,
  logger: realLogger,
};

// ─────────────────────────────────────────────────────────────────────────
// Zod helpers — fiecare secțiune ca ZodObject curat, mergeable.
// Refines cross-field se aplică la nivel de schemă compusă (mergeable
// dispar după `.refine()`/`.superRefine()` — Zod returnează ZodEffects
// care nu mai expune `.merge()`).
// ─────────────────────────────────────────────────────────────────────────

const FiscalSchema = z.object({
  fiscal_code_type: z.enum(['CUI', 'CNP']),
  fiscal_code: z.string().min(2).max(20),
});

const CompanyAddressSchema = z.object({
  county: z.string().min(1).max(50),
  city: z.string().min(1).max(100),
  street: z.string().min(1).max(255),
  street_number: z.string().min(1).max(20),
  address_full: z.string().max(2000).optional(),
  address_extra: z.string().max(255).optional(),
  postal_code: z.string().max(10).optional(),
});

const ContactSchema = z.object({
  phone: z.string().min(5).max(50).optional(),
  email: z.string().email().max(255).optional(),
});

const RepresentativeFullSchema = z.object({
  representative_name: z.string().min(1).max(255),
  representative_role_id: z.number().int().positive(),
  representative_ci_number: z.string().min(1).max(20),
  representative_ci_issued_by: z.string().min(1).max(255),
  representative_ci_issued_at: z.coerce.date(),
  representative_county: z.string().min(1).max(50),
  representative_city: z.string().min(1).max(100),
  representative_street: z.string().min(1).max(255),
  representative_street_number: z.string().min(1).max(20),
  // Optionale chiar și în modul UI strict — datele de pașaport / adresă
  // suplimentară sunt nice-to-have, nu obligatorii.
  representative_ci_series: z.string().max(5).optional(),
  representative_address_full: z.string().max(2000).optional(),
  representative_address_extra: z.string().max(255).optional(),
  representative_postal_code: z.string().max(10).optional(),
});

// `.partial()` face TOATE câmpurile opționale — folosit pentru import-ul
// Drive (Stage 13) unde clienții vechi au date incomplete despre reprezentant.
const RepresentativePartialSchema = RepresentativeFullSchema.partial();

const BankingSchema = z.object({
  // IBAN românesc: prefix RO + 2 cifre check + 4 litere bancă + 16 alfanumerice.
  // Regex case-insensitive ca să acceptăm input-ul user-ului fără normalizare.
  iban: z
    .string()
    .regex(
      /^RO\d{2}[A-Z]{4}\d{16}$/i,
      'IBAN invalid (format așteptat: RO + 2 cifre + 4 litere + 16 cifre/litere)'
    )
    .optional(),
  bank_name: z.string().max(100).optional(),
});

const AnafStatusSchema = z.object({
  is_vat_payer: z.boolean().default(false),
  anaf_verified: z.boolean().default(false),
  anaf_verified_at: z.coerce.date().optional(),
  anaf_status: z.string().max(20).optional(),
  // `anaf_data` — payload arbitrar de la ANAF webservice; structura e validată
  // în service-ul ANAF (5c). Aici acceptăm orice JSON.
  anaf_data: z.unknown().optional(),
});

const CommonClientFields = z.object({
  company_name: z.string().min(1).max(255),
  notes: z.string().max(5000).optional(),
});

// ─────────────────────────────────────────────────────────────────────────
// Refines cross-field — funcții reutilizabile între UI și Import.
// ─────────────────────────────────────────────────────────────────────────

function refineFiscalCode(data, ctx) {
  if (
    data.fiscal_code_type === 'CUI' &&
    !/^(RO\s?)?\d{2,10}$/i.test(data.fiscal_code)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fiscal_code'],
      message:
        'CUI invalid: format corect este 2-10 cifre, opțional prefix RO',
    });
  }
  if (data.fiscal_code_type === 'CNP' && !/^\d{13}$/.test(data.fiscal_code)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fiscal_code'],
      message: 'CNP invalid: format corect este exact 13 cifre',
    });
  }
}

function refinePhoneOrEmail(data, ctx) {
  if (!data.phone && !data.email) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['phone'],
      message: 'Telefon sau email obligatoriu',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Scheme compuse exportate (consumate de funcțiile publice de mai jos).
// ─────────────────────────────────────────────────────────────────────────

const CreateClientFromUiSchema = FiscalSchema
  .merge(CompanyAddressSchema)
  .merge(ContactSchema)
  .merge(RepresentativeFullSchema)
  .merge(BankingSchema)
  .merge(AnafStatusSchema)
  .merge(CommonClientFields)
  .superRefine(refineFiscalCode)
  .superRefine(refinePhoneOrEmail);

const CreateClientFromImportSchema = FiscalSchema
  .merge(CompanyAddressSchema)
  .merge(ContactSchema)
  .merge(RepresentativePartialSchema)
  .merge(BankingSchema)
  .merge(AnafStatusSchema)
  .merge(CommonClientFields)
  .superRefine(refineFiscalCode)
  .superRefine(refinePhoneOrEmail);

// Update — partial peste TOATE câmpurile non-fiscale (fiscal_code_type și
// fiscal_code NU sunt updateable după creare; orice schimbare ar fi de fapt
// un client nou). Refine-ul pentru phone||email NU se aplică la update —
// patch-ul e parțial, iar regula e enforce-ată de DB CHECK pe row-ul final.
const UpdateClientSchema = CompanyAddressSchema
  .merge(ContactSchema)
  .merge(RepresentativeFullSchema)
  .merge(BankingSchema)
  .merge(AnafStatusSchema)
  .merge(CommonClientFields)
  .partial();

// ─────────────────────────────────────────────────────────────────────────
// PG error → AppError mapping.
//
// Codurile SQLSTATE folosite:
//   - 23505 unique_violation
//   - 23514 check_violation
//   - 23503 foreign_key_violation
// `err.constraint` conține numele constrângerii din DB (vezi migrațiile
// 001 + 002). Match exact pe nume — dacă cineva renumește o constrângere,
// codul aici trebuie actualizat (intenționat fragil → semnal clar).
// ─────────────────────────────────────────────────────────────────────────

function setErrorCode(err, code) {
  err.code = code;
  return err;
}

function mapPgError(err) {
  if (!err || typeof err !== 'object') return err;

  if (err.code === '23505') {
    if (err.constraint === 'fiscal_code_unique_active') {
      return setErrorCode(
        new ConflictError('Există deja un client cu acest cod fiscal'),
        'FISCAL_CODE_DUPLICATE'
      );
    }
    if (err.constraint === 'idx_core_clients_email_unique_active') {
      return setErrorCode(
        new ConflictError('Există deja un client cu acest email'),
        'EMAIL_DUPLICATE'
      );
    }
  }

  if (err.code === '23514') {
    if (err.constraint === 'phone_or_email_required') {
      return setErrorCode(
        new ValidationError('Telefon sau email obligatoriu'),
        'PHONE_OR_EMAIL_REQUIRED'
      );
    }
    if (err.constraint === 'core_clients_fiscal_code_type_check') {
      return setErrorCode(
        new ValidationError(
          'Tipul codului fiscal e invalid (acceptat: CUI sau CNP)'
        ),
        'INVALID_FISCAL_CODE_TYPE'
      );
    }
  }

  if (
    err.code === '23503' &&
    err.constraint === 'core_clients_representative_role_id_fkey'
  ) {
    return setErrorCode(
      new ValidationError('Rolul reprezentantului nu există'),
      'REPRESENTATIVE_ROLE_INVALID'
    );
  }

  // Unmapped → re-throw original. Error-handler-ul central va răspunde 500.
  return err;
}

async function runQuery(pool, sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    throw mapPgError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Coloanele pe care le setează service-ul la INSERT. Single source of truth —
// orice coloană nouă în `core_clients` care e setabilă din service trebuie
// adăugată aici (și migrația corespunzătoare să facă DDL-ul).
// `id`, `created_at`, `updated_at`, `deleted_at` sunt managed de DB / soft-delete.
// ─────────────────────────────────────────────────────────────────────────

const INSERT_COLUMNS = [
  'fiscal_code',
  'fiscal_code_type',
  'company_name',
  'is_vat_payer',
  'address_full',
  'county',
  'city',
  'street',
  'street_number',
  'address_extra',
  'postal_code',
  'phone',
  'email',
  'representative_role_id',
  'representative_name',
  'representative_ci_series',
  'representative_ci_number',
  'representative_ci_issued_by',
  'representative_ci_issued_at',
  'representative_address_full',
  'representative_county',
  'representative_city',
  'representative_street',
  'representative_street_number',
  'representative_address_extra',
  'representative_postal_code',
  'iban',
  'bank_name',
  'anaf_verified',
  'anaf_verified_at',
  'anaf_status',
  'anaf_data',
  'notes',
  'created_by_id',
];

async function insertClient(tenantSlug, data, createdByUserId) {
  const pool = await _deps.getTenantPool(tenantSlug);
  const placeholders = INSERT_COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
  const values = INSERT_COLUMNS.map((col) => {
    if (col === 'created_by_id') return createdByUserId;
    const v = data[col];
    return v === undefined ? null : v;
  });
  const sql = `INSERT INTO amef.core_clients (${INSERT_COLUMNS.join(', ')})
               VALUES (${placeholders})
               RETURNING *`;
  const result = await runQuery(pool, sql, values);
  const row = result.rows[0];
  _deps.logger.info(
    { tenantSlug, clientId: row.id, createdByUserId },
    'Client creat'
  );
  return row;
}

// ─────────────────────────────────────────────────────────────────────────
// API public — 9 funcții.
// ─────────────────────────────────────────────────────────────────────────

async function createClientFromUi(tenantSlug, createdByUserId, data) {
  const validated = CreateClientFromUiSchema.parse(data);
  return insertClient(tenantSlug, validated, createdByUserId);
}

async function createClientFromImport(tenantSlug, createdByUserId, data) {
  const validated = CreateClientFromImportSchema.parse(data);
  return insertClient(tenantSlug, validated, createdByUserId);
}

async function getClientById(tenantSlug, id) {
  const pool = await _deps.getTenantPool(tenantSlug);
  const result = await runQuery(
    pool,
    `SELECT * FROM amef.core_clients
      WHERE id = $1 AND deleted_at IS NULL
      LIMIT 1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError(`Clientul cu id=${id} nu există`);
  }
  return row;
}

async function findClientByFiscalCode(tenantSlug, fiscalCode) {
  const pool = await _deps.getTenantPool(tenantSlug);
  const result = await runQuery(
    pool,
    `SELECT * FROM amef.core_clients
      WHERE fiscal_code = $1 AND deleted_at IS NULL
      LIMIT 1`,
    [fiscalCode]
  );
  return result.rows[0] || null;
}

async function findClientByEmail(tenantSlug, email) {
  const pool = await _deps.getTenantPool(tenantSlug);
  const result = await runQuery(
    pool,
    `SELECT * FROM amef.core_clients
      WHERE email = $1 AND deleted_at IS NULL
      LIMIT 1`,
    [email]
  );
  return result.rows[0] || null;
}

async function listClients(tenantSlug, opts = {}) {
  const {
    limit = 20,
    offset = 0,
    search,
    fiscalCodeType,
    anafVerified,
  } = opts;
  const pool = await _deps.getTenantPool(tenantSlug);

  // Construim WHERE dinamic — un push în `conditions` per filtru activ.
  // Indexul de placeholder se incrementează doar când chiar adăugăm un parametru.
  const conditions = ['deleted_at IS NULL'];
  const values = [];
  let paramIdx = 1;

  if (search) {
    conditions.push(`company_name ILIKE $${paramIdx++}`);
    values.push(`%${search}%`);
  }
  if (fiscalCodeType) {
    conditions.push(`fiscal_code_type = $${paramIdx++}`);
    values.push(fiscalCodeType);
  }
  if (anafVerified !== undefined) {
    conditions.push(`anaf_verified = $${paramIdx++}`);
    values.push(anafVerified);
  }

  const where = conditions.join(' AND ');

  // Două query-uri (count + page). O alternativă cu `COUNT(*) OVER ()` ar
  // încărca count-ul în fiecare rând — pentru limit=20 + total=10000 e
  // acceptabil, dar la limit=1000 dublarea costului devine vizibilă. Mai
  // curat în două run-uri, planner-ul Postgres tratează count-ul independent.
  const countResult = await runQuery(
    pool,
    `SELECT COUNT(*)::int AS total FROM amef.core_clients WHERE ${where}`,
    values
  );
  const total = countResult.rows[0].total;

  const rowsResult = await runQuery(
    pool,
    `SELECT * FROM amef.core_clients
       WHERE ${where}
    ORDER BY created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...values, limit, offset]
  );

  return { rows: rowsResult.rows, total };
}

async function updateClient(tenantSlug, id, data) {
  const validated = UpdateClientSchema.parse(data);
  const keys = Object.keys(validated);
  // No-op update: dacă nu sunt câmpuri de schimbat, returnăm rândul actual.
  // Util pentru endpoint-uri PATCH care primesc body gol din clienți buggy.
  if (keys.length === 0) {
    return getClientById(tenantSlug, id);
  }
  const pool = await _deps.getTenantPool(tenantSlug);
  const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
  setClauses.push('updated_at = NOW()');
  const values = keys.map((k) => (validated[k] === undefined ? null : validated[k]));
  values.push(id);
  const sql = `UPDATE amef.core_clients
                  SET ${setClauses.join(', ')}
                WHERE id = $${keys.length + 1} AND deleted_at IS NULL
            RETURNING *`;
  const result = await runQuery(pool, sql, values);
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError(`Clientul cu id=${id} nu există`);
  }
  return row;
}

async function softDeleteClient(tenantSlug, id) {
  const pool = await _deps.getTenantPool(tenantSlug);
  const result = await runQuery(
    pool,
    `UPDATE amef.core_clients
        SET deleted_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    // Nu distingem între „nu există" și „e deja șters" — în ambele cazuri
    // rezultatul UI-ului e identic (mesaj „client inexistent"). Mesajul
    // include ambele variante ca să fie clar la triage.
    throw new NotFoundError(
      `Clientul cu id=${id} nu există sau e deja șters`
    );
  }
  _deps.logger.info({ tenantSlug, clientId: id }, 'Client soft-deleted');
  return row;
}

async function restoreClient(tenantSlug, id) {
  const pool = await _deps.getTenantPool(tenantSlug);
  // Două pași ca să distingem clar între „nu există" (404) și „e deja activ"
  // (409). Un UPDATE simplu cu WHERE deleted_at IS NOT NULL nu poate
  // diferenția cele două (în ambele cazuri 0 rânduri afectate).
  const check = await runQuery(
    pool,
    `SELECT deleted_at FROM amef.core_clients WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (check.rows.length === 0) {
    throw new NotFoundError(`Clientul cu id=${id} nu există`);
  }
  if (check.rows[0].deleted_at === null) {
    throw new ConflictError(`Clientul cu id=${id} e deja activ`);
  }
  const result = await runQuery(
    pool,
    `UPDATE amef.core_clients
        SET deleted_at = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id]
  );
  _deps.logger.info({ tenantSlug, clientId: id }, 'Client restored');
  return result.rows[0];
}

module.exports = {
  // API public
  createClientFromUi,
  createClientFromImport,
  getClientById,
  findClientByFiscalCode,
  findClientByEmail,
  listClients,
  updateClient,
  softDeleteClient,
  restoreClient,
  // Schemele Zod sunt exportate pentru reutilizare în routes (5d) — adapter-ul
  // route validează tot acolo, înainte de a chema service-ul, ca erorile să
  // fie ZodError formatate uniform de error-handler.
  CreateClientFromUiSchema,
  CreateClientFromImportSchema,
  UpdateClientSchema,
  // Test seam — vezi „Testing seam pattern" în CLAUDE.md.
  _deps,
  // Expuse pentru teste izolate ale mapping-ului PG → AppError; nu folosi
  // direct din cod de producție (toate query-urile trec deja prin runQuery).
  _mapPgError: mapPgError,
};
