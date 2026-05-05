// Convenția centrală pentru numele secretelor din GCP Secret Manager.
//
// Singura sursă de adevăr — toate consumatorii (pool.js, migrate-cli.js,
// orice script de provisionare) trebuie să folosească `deriveSecretName`,
// nu să construiască numele inline. Asta previne drift-ul când adăugăm o
// nouă regulă (ex: o a treia variantă "preview" pentru deploy-uri PR).
//
// Convenția:
//   shared,  production → shared-db-connection
//   shared,  staging    → shared-staging-db-connection
//   tenant,  production → tenant-<slug>-db-connection
//   tenant,  staging    → tenant-<slug>-staging-db-connection

const SLUG_REGEX = /^[a-z0-9-]+$/;
const VALID_KINDS = new Set(['shared', 'tenant']);
const VALID_ENVS = new Set(['production', 'staging']);

function deriveSecretName(kind, env, slug) {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(
      `kind invalid: "${kind}". Permis: shared, tenant.`
    );
  }
  if (!VALID_ENVS.has(env)) {
    throw new Error(
      `env invalid: "${env}". Permis: production, staging.`
    );
  }
  const suffix = env === 'production' ? '' : '-staging';
  if (kind === 'shared') {
    return `shared${suffix}-db-connection`;
  }
  // kind === 'tenant'
  if (typeof slug !== 'string' || !SLUG_REGEX.test(slug)) {
    throw new Error(
      `slug invalid: "${slug}". Permis: /^[a-z0-9-]+$/ (litere mici, cifre, cratimă).`
    );
  }
  return `tenant-${slug}${suffix}-db-connection`;
}

// Mapping NODE_ENV → env de Secret Manager. În development folosim DB-ul de
// staging — nu vrem ca dev local să atingă production accidental, iar
// provisionarea unei a treia DB pentru dev ar fi over-engineering (nu există
// date "dev" reale, doar testare manuală cu seed staging).
function envFromNodeEnv(nodeEnv) {
  return nodeEnv === 'production' ? 'production' : 'staging';
}

module.exports = {
  deriveSecretName,
  envFromNodeEnv,
};
