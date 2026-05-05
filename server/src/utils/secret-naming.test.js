// Teste pentru convenția de numire a secretelor. Modulul e pur (no I/O),
// deci nu e nevoie de stubEnv pentru config — îl putem testa direct.

const { deriveSecretName, envFromNodeEnv } = require('./secret-naming');

describe('deriveSecretName — combinații valide', () => {
  it('shared + production → shared-db-connection', () => {
    expect(deriveSecretName('shared', 'production')).toBe('shared-db-connection');
  });

  it('shared + staging → shared-staging-db-connection', () => {
    expect(deriveSecretName('shared', 'staging')).toBe(
      'shared-staging-db-connection'
    );
  });

  it('tenant + dianex + production → tenant-dianex-db-connection', () => {
    expect(deriveSecretName('tenant', 'production', 'dianex')).toBe(
      'tenant-dianex-db-connection'
    );
  });

  it('tenant + dianex + staging → tenant-dianex-staging-db-connection', () => {
    expect(deriveSecretName('tenant', 'staging', 'dianex')).toBe(
      'tenant-dianex-staging-db-connection'
    );
  });

  it('tenant cu slug compus (cratimă, cifre)', () => {
    expect(deriveSecretName('tenant', 'production', 'client-x-2')).toBe(
      'tenant-client-x-2-db-connection'
    );
  });
});

describe('deriveSecretName — input invalid', () => {
  it('aruncă pe kind necunoscut', () => {
    expect(() => deriveSecretName('admin', 'production')).toThrow(
      /kind invalid.*admin/
    );
  });

  it('aruncă pe env necunoscut', () => {
    expect(() => deriveSecretName('shared', 'preview')).toThrow(
      /env invalid.*preview/
    );
  });

  it('aruncă pe slug lipsă pentru tenant', () => {
    expect(() => deriveSecretName('tenant', 'production')).toThrow(
      /slug invalid/
    );
    expect(() => deriveSecretName('tenant', 'production', '')).toThrow(
      /slug invalid/
    );
    expect(() => deriveSecretName('tenant', 'production', null)).toThrow(
      /slug invalid/
    );
  });

  it('aruncă pe slug cu caractere invalide', () => {
    expect(() =>
      deriveSecretName('tenant', 'production', 'Dianex')
    ).toThrow(/slug invalid/);
    expect(() =>
      deriveSecretName('tenant', 'production', 'di_anex')
    ).toThrow(/slug invalid/);
    expect(() =>
      deriveSecretName('tenant', 'production', 'di anex')
    ).toThrow(/slug invalid/);
  });

  it('shared NU validează slug (e ignorat)', () => {
    // Slug-ul nu e folosit pentru shared; funcția returnează numele fără
    // să se uite la al treilea argument.
    expect(deriveSecretName('shared', 'production', 'orice')).toBe(
      'shared-db-connection'
    );
  });
});

describe('envFromNodeEnv', () => {
  it('production → production', () => {
    expect(envFromNodeEnv('production')).toBe('production');
  });

  it('staging → staging', () => {
    expect(envFromNodeEnv('staging')).toBe('staging');
  });

  it('development → staging (dev folosește DB de staging)', () => {
    expect(envFromNodeEnv('development')).toBe('staging');
  });

  it('orice valoare necunoscută → staging (default safe, NU production)', () => {
    expect(envFromNodeEnv('test')).toBe('staging');
    expect(envFromNodeEnv(undefined)).toBe('staging');
    expect(envFromNodeEnv('')).toBe('staging');
  });
});
