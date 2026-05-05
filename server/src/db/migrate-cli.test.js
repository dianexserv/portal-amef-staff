// Teste pentru funcțiile pure din migrate-cli.js (`parseArgs`, `resolveTarget`).
// Nu rulăm `main()` — fișierul folosește `if (require.main === module)` ca să
// nu execute side-effects la import. Acoperirea producției e excluse din
// vitest.config.js (CLI entry point), dar testăm logica de parsare aici.

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'silent');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');
vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_SECRET_NAME', 'firebase-service-account-test');

const { parseArgs, resolveTarget } = require('./migrate-cli');

describe('parseArgs', () => {
  it('shared fără --env → env=production (default)', () => {
    expect(parseArgs(['shared'])).toEqual({ kind: 'shared', env: 'production' });
  });

  it('shared cu --env staging', () => {
    expect(parseArgs(['shared', '--env', 'staging'])).toEqual({
      kind: 'shared',
      env: 'staging',
    });
  });

  it('shared cu --env=staging (forma cu egal)', () => {
    expect(parseArgs(['shared', '--env=staging'])).toEqual({
      kind: 'shared',
      env: 'staging',
    });
  });

  it('shared cu --env în prima poziție (înainte de comandă)', () => {
    expect(parseArgs(['--env', 'staging', 'shared'])).toEqual({
      kind: 'shared',
      env: 'staging',
    });
  });

  it('tenant + slug + --env staging', () => {
    expect(parseArgs(['tenant', 'dianex', '--env', 'staging'])).toEqual({
      kind: 'tenant',
      slug: 'dianex',
      env: 'staging',
    });
  });

  it('tenant + slug fără --env → production', () => {
    expect(parseArgs(['tenant', 'dianex'])).toEqual({
      kind: 'tenant',
      slug: 'dianex',
      env: 'production',
    });
  });

  it('tenant cu --env între tip și slug (orice poziție)', () => {
    expect(parseArgs(['tenant', '--env', 'staging', 'dianex'])).toEqual({
      kind: 'tenant',
      slug: 'dianex',
      env: 'staging',
    });
  });

  it('respinge --env cu valoare invalidă', () => {
    expect(() => parseArgs(['shared', '--env', 'preview'])).toThrow(
      /--env value invalid.*preview/
    );
  });

  it('respinge --env=invalid', () => {
    expect(() => parseArgs(['shared', '--env=preview'])).toThrow(
      /--env value invalid.*preview/
    );
  });

  it('respinge --env fără valoare', () => {
    expect(() => parseArgs(['shared', '--env'])).toThrow(
      /--env value invalid/
    );
  });

  it('respinge tenant fără slug', () => {
    expect(() => parseArgs(['tenant'])).toThrow(/Slug-ul tenantului/);
    expect(() => parseArgs(['tenant', '--env', 'staging'])).toThrow(
      /Slug-ul tenantului/
    );
  });

  it('respinge slug invalid (majuscule, underscore, spațiu)', () => {
    expect(() => parseArgs(['tenant', 'Dianex'])).toThrow(
      /Slug-ul tenantului/
    );
    expect(() => parseArgs(['tenant', 'di_anex'])).toThrow(
      /Slug-ul tenantului/
    );
    expect(() => parseArgs(['tenant', ''])).toThrow(/Slug-ul tenantului/);
  });

  it('respinge comandă necunoscută', () => {
    expect(() => parseArgs(['admin'])).toThrow(/Țintă necunoscută.*admin/);
  });

  it('respinge argv gol', () => {
    expect(() => parseArgs([])).toThrow(/Lipsește comanda/);
  });
});

describe('resolveTarget', () => {
  it("'shared', 'production' → secret 'shared-db-connection'", () => {
    const t = resolveTarget('shared', 'production');
    expect(t.secretName).toBe('shared-db-connection');
    expect(t.kind).toBe('shared');
    expect(t.env).toBe('production');
    expect(t.schema).toBe('amef_shared');
    expect(t.migrationsDir).toMatch(/migrations[\\/]shared$/);
  });

  it("'shared', 'staging' → secret 'shared-staging-db-connection'", () => {
    const t = resolveTarget('shared', 'staging');
    expect(t.secretName).toBe('shared-staging-db-connection');
    expect(t.env).toBe('staging');
  });

  it("'tenant', 'dianex', 'production' → 'tenant-dianex-db-connection'", () => {
    const t = resolveTarget('tenant', 'dianex', 'production');
    expect(t.secretName).toBe('tenant-dianex-db-connection');
    expect(t.kind).toBe('tenant');
    expect(t.slug).toBe('dianex');
    expect(t.env).toBe('production');
    expect(t.schema).toBe('amef');
    expect(t.migrationsDir).toMatch(/migrations[\\/]tenant$/);
  });

  it("'tenant', 'dianex', 'staging' → 'tenant-dianex-staging-db-connection'", () => {
    const t = resolveTarget('tenant', 'dianex', 'staging');
    expect(t.secretName).toBe('tenant-dianex-staging-db-connection');
    expect(t.env).toBe('staging');
  });

  it('shared default env → production', () => {
    const t = resolveTarget('shared');
    expect(t.env).toBe('production');
    expect(t.secretName).toBe('shared-db-connection');
  });

  it('tenant default env → production', () => {
    const t = resolveTarget('tenant', 'dianex');
    expect(t.env).toBe('production');
    expect(t.secretName).toBe('tenant-dianex-db-connection');
  });

  it('logBindings includ env-ul (pentru log structurat)', () => {
    expect(resolveTarget('shared', 'staging').logBindings).toEqual({
      target: 'shared',
      env: 'staging',
    });
    expect(resolveTarget('tenant', 'dianex', 'staging').logBindings).toEqual({
      target: 'tenant',
      slug: 'dianex',
      env: 'staging',
    });
  });

  it('aruncă pe kind necunoscut', () => {
    expect(() => resolveTarget('admin', 'production')).toThrow(
      /Țintă necunoscută.*admin/
    );
  });

  it('propagă eroarea de la deriveSecretName pentru slug invalid', () => {
    // Validarea finală cade la deriveSecretName (single source of truth);
    // resolveTarget nu re-validează ca să nu dublăm regulile.
    expect(() => resolveTarget('tenant', 'BAD_SLUG', 'production')).toThrow(
      /slug invalid/
    );
  });

  it('propagă eroarea de la deriveSecretName pentru env invalid', () => {
    expect(() => resolveTarget('shared', 'preview')).toThrow(
      /env invalid.*preview/
    );
  });
});
