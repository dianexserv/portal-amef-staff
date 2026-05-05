// Migration runner pentru Portal AMEF.
//
// Folosim migrații numerotate manual (`001_*.sql`, `002_*.sql`, ...) — NU un
// ORM. Decizie deliberată (D6 din portal-amef-overview.md): SQL pur e auditabil,
// reproductibil și nu introduce o dependență grea pentru ceva ce facem rar.
//
// Strategie de aplicare:
//   1. Acquire `pg_advisory_lock(MIGRATION_ADVISORY_LOCK_ID)` — într-un mediu
//      Cloud Run cu auto-scaling, două instanțe pot porni simultan și amândouă
//      pot încerca să aplice migrațiile. Advisory lock-ul Postgres e per-DB
//      și ne dă mutex în jurul întregului proces, evitând dublarea.
//   2. Pentru fiecare fișier ne-aplicat, BEGIN tranzacție → rulează SQL →
//      INSERT în `schema_migrations` → COMMIT. Dacă SQL-ul eșuează, ROLLBACK
//      lasă DB-ul exact ca înainte și aruncăm cu mesaj clar (filename inclus).
//   3. Lock-ul e eliberat în finally — chiar dacă o migrație eșuează, alte
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

// SQL pentru tabela de tracking. CREATE IF NOT EXISTS îl face idempotent —
// poate rula de oricâte ori fără efecte secundare.
const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

function listMigrationFiles(dir) {
  const entries = _deps.fs.readdirSync(dir);
  // Filtrăm la `.sql` ca să ignorăm README/.gitkeep/orice alt artifact;
  // sortarea e crucială — numele 001_, 002_ sunt singura noastră ordine.
  return entries
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

async function listAppliedMigrations(pool) {
  // Dacă tabela încă nu există (prima rulare), interogarea ar arunca —
  // creăm tabela mai întâi în applyMigrations, deci aici presupunem că
  // există. Helper-ul e public pentru introspecție din alte module.
  const result = await pool.query(
    'SELECT filename FROM schema_migrations ORDER BY filename ASC'
  );
  return result.rows.map((r) => r.filename);
}

function readMigrationSql(dir, filename) {
  const fullPath = path.join(dir, filename);
  return _deps.fs.readFileSync(fullPath, 'utf8');
}

async function applyMigrations(pool, migrationsDir, loggerOverride) {
  const log = loggerOverride || _deps.logger;

  // Folosim un singur client (nu pool.query) ca să garantăm același conex
  // pe tot parcursul: advisory lock + tranzacții + release trebuie pe aceeași
  // sesiune Postgres.
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query(SCHEMA_MIGRATIONS_DDL);

    await client.query('SELECT pg_advisory_lock($1)', [
      MIGRATION_ADVISORY_LOCK_ID,
    ]);
    lockAcquired = true;

    // Re-citim fișierele aplicate DUPĂ acquisition lock — altă instanță
    // putea aplica între timp, vrem să vedem starea curentă.
    const appliedRes = await client.query(
      'SELECT filename FROM schema_migrations ORDER BY filename ASC'
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
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [filename]
        );
        await client.query('COMMIT');
        applied.push(filename);
        log.info({ filename }, 'Migrație aplicată');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        log.error({ err, filename }, 'Migrație eșuată — ROLLBACK efectuat');
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
