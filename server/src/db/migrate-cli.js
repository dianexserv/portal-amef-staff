#!/usr/bin/env node
// CLI thin wrapper peste migrate.js — rulat manual de admin (Madalin) sau
// din scripturi de deploy. NU e folosit de aplicația HTTP; pentru asta ar
// fi un endpoint protejat care apelează `applyMigrations` direct.
//
// Utilizare:
//   node src/db/migrate-cli.js shared          (pe `amef_shared` curent)
//   node src/db/migrate-cli.js tenant <slug>   (pe `amef_tenant_<slug>`)
//
// Connection string-ul e citit din Secret Manager pe baza convenției:
//   shared → SHARED_DB_CONNECTION_SECRET_NAME (din config)
//   tenant → tenant-<slug>-db-connection
//
// Pe eroare ieșim cu cod 1 ca CI / shell să detecteze; mesajul de eroare
// include numele migrației care a căzut (vezi applyMigrations).

const path = require('node:path');
const { Pool } = require('pg');
const config = require('../config');
const logger = require('../logger');
const { getSecret } = require('../utils/secret-manager');
const { applyMigrations } = require('./migrate');

function usage() {
  // Scris pe stderr ca stdout să rămână rezervat pentru output structurat
  // (dacă mai târziu vrem să consume rezultatul în pipe-uri).
  process.stderr.write(
    'Usage:\n' +
      '  node src/db/migrate-cli.js shared\n' +
      '  node src/db/migrate-cli.js tenant <slug>\n'
  );
}

async function resolveTarget(args) {
  const target = args[0];
  if (target === 'shared') {
    return {
      kind: 'shared',
      secretName: config.SHARED_DB_CONNECTION_SECRET_NAME,
      migrationsDir: path.join(__dirname, 'migrations', 'shared'),
      logBindings: { target: 'shared' },
    };
  }
  if (target === 'tenant') {
    const slug = args[1];
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
      throw new Error(
        'Slug-ul tenantului trebuie specificat și să match-uiască /^[a-z0-9-]+$/'
      );
    }
    return {
      kind: 'tenant',
      secretName: `tenant-${slug}-db-connection`,
      migrationsDir: path.join(__dirname, 'migrations', 'tenant'),
      logBindings: { target: 'tenant', slug },
    };
  }
  throw new Error(`Țintă necunoscută: "${target}". Folosește 'shared' sau 'tenant'.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
    process.exit(2);
  }

  const target = await resolveTarget(args);
  const cliLogger = logger.child(target.logBindings);

  cliLogger.info(
    { secretName: target.secretName },
    'Citesc connection string din Secret Manager'
  );
  const connectionString = await getSecret(target.secretName);

  const pool = new Pool({ connectionString, max: 2 });
  // search_path corect per țintă — runner-ul scrie în `schema_migrations`
  // care va sta în prima schema din path. Pentru shared vrem `amef_shared`,
  // pentru tenant vrem `amef`.
  const searchPath =
    target.kind === 'shared' ? 'amef_shared, public' : 'amef, public';
  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${searchPath}`).catch((err) => {
      cliLogger.error({ err }, 'Eșec la setarea search_path');
    });
  });

  try {
    const result = await applyMigrations(pool, target.migrationsDir, cliLogger);
    cliLogger.info(
      { applied: result.applied, skipped: result.skipped },
      'Migrații finalizate'
    );
    // Output uman pe stdout pentru ergonomie CLI
    process.stdout.write(
      `Applied: ${result.applied.length} | Skipped: ${result.skipped.length}\n`
    );
    if (result.applied.length > 0) {
      process.stdout.write(`  + ${result.applied.join('\n  + ')}\n`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // Logger-ul e deja JSON pe staging/prod; mesajul brut pe stderr e pentru
  // shell-ul interactiv local, unde grepuim după „Migrație eșuată".
  logger.error({ err }, 'migrate-cli a eșuat');
  process.stderr.write(`ERROR: ${err.message}\n`);
  process.exit(1);
});
