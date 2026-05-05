// Migration runner pentru Portal AMEF.
//
// Folosim migrații numerotate manual (`001_*.sql`, `002_*.sql`, ...) — NU un
// ORM. Decizie deliberată (D6 din portal-amef-overview.md): SQL pur e auditabil,
// reproductibil și nu introduce o dependență grea pentru ceva ce facem rar.
//
// Strategie de aplicare:
//   1. Determinăm SCHEMA țintă pentru `schema_migrations` la pornire — fie din
//      opțiunea `{ schema: ... }` (recomandat), fie via `current_schemas(false)[1]`
//      ca fallback. Numele se sanitizează regex `[a-z0-9_]+` ca să prevenim
//      SQL injection prin interpolare în identificator (NU putem parametriza
//      identificatorii în pg, doar valorile).
//   2. `CREATE SCHEMA IF NOT EXISTS "<schema>"` apoi `CREATE TABLE IF NOT
//      EXISTS "<schema>".schema_migrations (...)` — toate query-urile pe
//      `schema_migrations` referă schema EXPLICIT, ca migrațiile-utilizator
//      să nu poată muta tracking-ul prin `SET search_path` mid-session.
//   3. Acquire `pg_advisory_lock(MIGRATION_ADVISORY_LOCK_ID)` — într-un mediu
//      Cloud Run cu auto-scaling, două instanțe pot porni simultan și amândouă
//      pot încerca să aplice migrațiile. Advisory lock-ul Postgres e per-DB
//      și ne dă mutex în jurul întregului proces, evitând dublarea.
//   4. Pentru fiecare fișier ne-aplicat, BEGIN tranzacție → rulează SQL →
//      INSERT în `schema_migrations` → COMMIT. Dacă SQL-ul eșuează, ROLLBACK
//      lasă DB-ul exact ca înainte și aruncăm cu mesaj clar (filename inclus).
//   5. Lock-ul e eliberat în finally — chiar dacă o migrație eșuează, alte
//      instanțe pot încerca după ce remediem problema, fără reboot manual.
//
// `_deps` (vezi „Testing seam pattern" în CLAUDE.md) ne permite să injectăm
// fs și logger în teste — fs-ul real ar cere fișiere reale pe disc.

const fs = require('node:fs');
const path = require('node:path');
const realLogger = require('../logger');

// _deps object exported strictly for testing. Tests mutate _deps.client/_deps.logger
// to inject mocks. Production code MUST NOT touch _deps directly except in lazy init.
//
// Aici injectăm `fs` (pentru listMigrationFiles + citirea conținutului) și
// `logger`. Tests assign mock fs cu readdirSync/readFileSync controlate.
const _deps = {
  fs,
  logger: realLogger,
};

// Lock ID arbitrar dar fix per proiect — pg_advisory_lock e per-DB și per-key,
// deci două aplicații independente pe aceeași instanță Postgres ar putea avea
// chei diferite. 9182734 e numărul nostru; nu trebuie să se schimbe niciodată.
const MIGRATION_ADVISORY_LOCK_ID = 9182734;

// Sanitizare strictă pentru numele schemei. pg NU permite parametrizarea
// identificatorilor (doar valorilor), deci interpolarea în SQL e necesară —
// regex-ul închide ușa pentru orice caracter care ar putea sparge ghilimelele
// (ex: `amef"; DROP TABLE foo --`).
const SCHEMA_NAME_REGEX = /^[a-z0-9_]+$/;

function validateSchema(schema) {
  if (typeof schema !== 'string' || !SCHEMA_NAME_REGEX.test(schema)) {
    throw new Error(
      `Numele schemei invalid: "${schema}". ` +
        'Permis doar [a-z0-9_]+ (prevenire SQL injection prin interpolare).'
    );
  }
  return schema;
}

async function resolveSchema(client, providedSchema) {
  if (providedSchema !== undefined) {
    return validateSchema(providedSchema);
  }
  // Fallback: prima schema din search_path-ul curent. `current_schemas(false)`
  // exclude pg_catalog implicit — dacă search_path-ul nu conține nimic
  // configurat de noi, vrem să eșuăm explicit, nu să cădem pe pg_catalog/public.
  const result = await client.query(
    'SELECT current_schemas(false)[1] AS schema'
  );
  const fallback = result.rows[0] && result.rows[0].schema;
  if (!fallback) {
    throw new Error(
      'Nu pot determina schema implicită — search_path-ul e gol sau invalid. ' +
        'Pasează explicit { schema: "..." } la applyMigrations.'
    );
  }
  return validateSchema(fallback);
}

function listMigrationFiles(dir) {
  const entries = _deps.fs.readdirSync(dir);
  // Filtrăm la `.sql` ca să ignorăm README/.gitkeep/orice alt artifact;
  // sortarea e crucială — numele 001_, 002_ sunt singura noastră ordine.
  return entries
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

async function listAppliedMigrations(pool, schema) {
  const safe = validateSchema(schema);
  // Helper public pentru introspecție; presupune că tabela există deja
  // (creată de applyMigrations la prima rulare).
  const result = await pool.query(
    `SELECT filename FROM "${safe}".schema_migrations ORDER BY filename ASC`
  );
  return result.rows.map((r) => r.filename);
}

function readMigrationSql(dir, filename) {
  const fullPath = path.join(dir, filename);
  return _deps.fs.readFileSync(fullPath, 'utf8');
}

async function applyMigrations(pool, migrationsDir, options = {}) {
  const { schema: providedSchema, logger: loggerOverride } = options;
  const log = loggerOverride || _deps.logger;

  // Validăm schema-ul EARLY (sync) când e furnizat — eșuăm rapid fără să
  // ținem o conexiune ocupată dacă inputul e invalid.
  if (providedSchema !== undefined) {
    validateSchema(providedSchema);
  }

  // Folosim un singur client (nu pool.query) ca să garantăm același conex
  // pe tot parcursul: advisory lock + tranzacții + release trebuie pe aceeași
  // sesiune Postgres.
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    const schema = await resolveSchema(client, providedSchema);

    // Asigurăm existența schemei ÎNAINTE de table — `CREATE SCHEMA IF NOT
    // EXISTS` e idempotent. Necesar mai ales pentru DB-urile tenant unde
    // prima migrație de utilizator încă nu a rulat și schema `amef` lipsește.
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${schema}".schema_migrations (
         filename VARCHAR(255) PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );

    await client.query('SELECT pg_advisory_lock($1)', [
      MIGRATION_ADVISORY_LOCK_ID,
    ]);
    lockAcquired = true;

    // Re-citim fișierele aplicate DUPĂ acquisition lock — altă instanță
    // putea aplica între timp, vrem să vedem starea curentă.
    const appliedRes = await client.query(
      `SELECT filename FROM "${schema}".schema_migrations ORDER BY filename ASC`
    );
    const appliedSet = new Set(appliedRes.rows.map((r) => r.filename));

    const files = listMigrationFiles(migrationsDir);
    const applied = [];
    const skipped = [];

    for (const filename of files) {
      if (appliedSet.has(filename)) {
        skipped.push(filename);
        continue;
      }
      const sql = readMigrationSql(migrationsDir, filename);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          `INSERT INTO "${schema}".schema_migrations (filename) VALUES ($1)`,
          [filename]
        );
        await client.query('COMMIT');
        applied.push(filename);
        log.info({ filename, schema }, 'Migrație aplicată');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        log.error(
          { err, filename, schema },
          'Migrație eșuată — ROLLBACK efectuat'
        );
        // Wrap explicit cu numele fișierului — mesajul brut din pg
        // („syntax error at or near...") nu spune CARE migrație a căzut.
        throw new Error(
          `Migrație eșuată "${filename}": ${err.message}`
        );
      }
    }

    return { applied, skipped };
  } finally {
    if (lockAcquired) {
      // Eliberăm chiar dacă procesul a aruncat — altfel lock-ul rămâne
      // până la închiderea conexiunii și blochează retries pe alte instanțe.
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_ID])
        .catch((err) => {
          log.warn(
            { err },
            'Eșec la eliberarea advisory lock — se eliberează la close'
          );
        });
    }
    client.release();
  }
}

module.exports = {
  applyMigrations,
  listAppliedMigrations,
  listMigrationFiles,
  MIGRATION_ADVISORY_LOCK_ID,
  // Test seam — vezi „Testing seam pattern" în CLAUDE.md.
  _deps,
};
