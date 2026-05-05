#!/usr/bin/env node
// CLI thin wrapper peste migrate.js — rulat manual de admin (Madalin) sau
// din scripturi de deploy. NU e folosit de aplicația HTTP; pentru asta ar
// fi un endpoint protejat care apelează `applyMigrations` direct.
//
// Utilizare:
//   node src/db/migrate-cli.js shared
//   node src/db/migrate-cli.js shared --env staging
//   node src/db/migrate-cli.js tenant <slug>
//   node src/db/migrate-cli.js tenant <slug> --env staging
//
// `--env` poate apărea în orice poziție; default e `production`.
// Numele secretelor sunt derivate din convenție (vezi utils/secret-naming.js):
//   shared,  production → shared-db-connection
//   shared,  staging    → shared-staging-db-connection
//   tenant,  production → tenant-<slug>-db-connection
//   tenant,  staging    → tenant-<slug>-staging-db-connection
//
// Pe eroare ieșim cu cod 1 ca CI / shell să detecteze; mesajul de eroare
// include numele migrației care a căzut (vezi applyMigrations).

const path = require('node:path');
const { Pool } = require('pg');
const logger = require('../logger');
const { getSecret } = require('../utils/secret-manager');
const { applyMigrations } = require('./migrate');
const { deriveSecretName } = require('../utils/secret-naming');

function usage() {
  // Scris pe stderr ca stdout să rămână rezervat pentru output structurat
  // (dacă mai târziu vrem să consume rezultatul în pipe-uri).
  process.stderr.write(
    'Usage:\n' +
      '  node src/db/migrate-cli.js shared [--env production|staging]\n' +
      '  node src/db/migrate-cli.js tenant <slug> [--env production|staging]\n' +
      '\n' +
      'Default --env: production\n'
  );
}

const VALID_ENVS = new Set(['production', 'staging']);
const SLUG_REGEX = /^[a-z0-9-]+$/;

function parseArgs(argv) {
  let env = 'production';
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') {
      const v = argv[i + 1];
      if (!VALID_ENVS.has(v)) {
        throw new Error(
          `--env value invalid: "${v ?? ''}". Permis: production, staging.`
        );
      }
      env = v;
      i++; // consume valoarea
    } else if (typeof a === 'string' && a.startsWith('--env=')) {
      const v = a.slice('--env='.length);
      if (!VALID_ENVS.has(v)) {
        throw new Error(
          `--env value invalid: "${v}". Permis: production, staging.`
        );
      }
      env = v;
    } else {
      positional.push(a);
    }
  }

  if (positional.length === 0) {
    throw new Error(
      'Lipsește comanda țintă: folosește "shared" sau "tenant <slug>".'
    );
  }
  const kind = positional[0];
  if (kind === 'shared') {
    return { kind: 'shared', env };
  }
  if (kind === 'tenant') {
    const slug = positional[1];
    if (!slug || !SLUG_REGEX.test(slug)) {
      throw new Error(
        'Slug-ul tenantului trebuie specificat și să match-uiască /^[a-z0-9-]+$/.'
      );
    }
    return { kind: 'tenant', slug, env };
  }
  throw new Error(`Țintă necunoscută: "${kind}". Folosește 'shared' sau 'tenant'.`);
}

// Variadic ca să se citească natural: resolveTarget('shared', env) sau
// resolveTarget('tenant', slug, env). Validările sunt delegate către
// `deriveSecretName` (single source of truth).
function resolveTarget(kind, ...rest) {
  if (kind === 'shared') {
    const [env = 'production'] = rest;
    return {
      kind: 'shared',
      env,
      secretName: deriveSecretName('shared', env),
      // Schema explicit pentru `schema_migrations` — vezi „search_path race"
      // în CLAUDE.md / Stage 2 notes. Migrațiile-utilizator pot muta
      // search_path mid-session; tracking-ul rămâne stabil aici.
      schema: 'amef_shared',
      migrationsDir: path.join(__dirname, 'migrations', 'shared'),
      logBindings: { target: 'shared', env },
    };
  }
  if (kind === 'tenant') {
    const [slug, env = 'production'] = rest;
    return {
      kind: 'tenant',
      slug,
      env,
      secretName: deriveSecretName('tenant', env, slug),
      schema: 'amef',
      migrationsDir: path.join(__dirname, 'migrations', 'tenant'),
      logBindings: { target: 'tenant', slug, env },
    };
  }
  throw new Error(`Țintă necunoscută: "${kind}". Folosește 'shared' sau 'tenant'.`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    usage();
    process.exit(2);
  }

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    usage();
    process.exit(2);
  }

  const target =
    parsed.kind === 'shared'
      ? resolveTarget('shared', parsed.env)
      : resolveTarget('tenant', parsed.slug, parsed.env);

  const cliLogger = logger.child(target.logBindings);

  cliLogger.info(
    { secretName: target.secretName },
    'Citesc connection string din Secret Manager'
  );
  const connectionString = await getSecret(target.secretName);

  // Setăm search_path via parametrul `options` al connection string-ului
  // (vezi pool.js + Stage 2 notes). Atomic la handshake, fără SET asincron.
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${target.schema},public`);
  const pool = new Pool({ connectionString: url.toString(), max: 2 });

  try {
    const result = await applyMigrations(pool, target.migrationsDir, {
      schema: target.schema,
      logger: cliLogger,
    });
    cliLogger.info(
      {
        applied: result.applied,
        skipped: result.skipped,
        schema: target.schema,
      },
      'Migrații finalizate'
    );
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

// Auto-execută main() doar când fișierul e rulat direct (`node migrate-cli.js`).
// Când e importat din teste (`require('./migrate-cli')`), exporturile pure
// sunt accesibile fără side-effects.
if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'migrate-cli a eșuat');
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  resolveTarget,
  usage,
};
