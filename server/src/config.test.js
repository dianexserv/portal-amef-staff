// Teste pentru config.js. Folosim factory-ul `loadConfig(env)` cu obiecte env
// custom — abordare deterministă care evită caching-ul `require()` în CJS
// (vi.resetModules nu curăță cache-ul native Node CJS).
//
// Pentru ca `require('./config')` la nivel de modul să nu arunce, setăm un
// env valid prin `vi.stubEnv` înainte de primul require.

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'info');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');

const config = require('./config');
const { loadConfig } = config;

const VALID_ENV = {
  NODE_ENV: 'production',
  PORT: '3001',
  LOG_LEVEL: 'info',
  GCP_PROJECT_ID: 'portal-amef',
  JWT_SECRET_NAME: 'jwt-secret-test',
  JWT_EXPIRY_HOURS: '1',
  REFRESH_TOKEN_EXPIRY_DAYS: '7',
  FIREBASE_PROJECT_ID: 'portal-amef-test',
};

describe('config (module-level export)', () => {
  it('expune valorile parsate din process.env la load', () => {
    expect(config.NODE_ENV).toBe('production');
    expect(config.PORT).toBe(3001);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.GCP_PROJECT_ID).toBe('portal-amef');
    expect(config.JWT_SECRET_NAME).toBe('jwt-secret-test');
    expect(config.JWT_EXPIRY_HOURS).toBe(1);
    expect(config.REFRESH_TOKEN_EXPIRY_DAYS).toBe(7);
    expect(config.FIREBASE_PROJECT_ID).toBe('portal-amef-test');
  });

  it('exportă obiect înghețat (nu se poate modifica la runtime)', () => {
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      'use strict';
      config.PORT = 9999;
    }).toThrow();
  });

  it('expune și factory-ul loadConfig', () => {
    expect(typeof loadConfig).toBe('function');
  });
});

describe('config.loadConfig (factory)', () => {
  it('parsează env valid și tipizează corect', () => {
    const cfg = loadConfig(VALID_ENV);
    expect(cfg.NODE_ENV).toBe('production');
    expect(cfg.PORT).toBe(3001);
    expect(typeof cfg.PORT).toBe('number');
    expect(cfg.JWT_EXPIRY_HOURS).toBe(1);
    expect(typeof cfg.JWT_EXPIRY_HOURS).toBe('number');
    expect(cfg.REFRESH_TOKEN_EXPIRY_DAYS).toBe(7);
  });

  it('returnează obiect înghețat', () => {
    const cfg = loadConfig(VALID_ENV);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('aplică default-urile când valorile opționale sunt goale', () => {
    const cfg = loadConfig({
      NODE_ENV: '',
      PORT: '',
      LOG_LEVEL: '',
      GCP_PROJECT_ID: 'p',
      JWT_SECRET_NAME: 'j',
      JWT_EXPIRY_HOURS: '',
      REFRESH_TOKEN_EXPIRY_DAYS: '',
      FIREBASE_PROJECT_ID: 'f',
      SHARED_DB_CONNECTION_SECRET_NAME: 's',
    });
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.PORT).toBe(3001);
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.JWT_EXPIRY_HOURS).toBe(1);
    expect(cfg.REFRESH_TOKEN_EXPIRY_DAYS).toBe(7);
  });

  it('aplică default-urile și când câmpurile opționale lipsesc complet', () => {
    const cfg = loadConfig({
      GCP_PROJECT_ID: 'p',
      JWT_SECRET_NAME: 'j',
      FIREBASE_PROJECT_ID: 'f',
      SHARED_DB_CONNECTION_SECRET_NAME: 's',
    });
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.PORT).toBe(3001);
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.JWT_EXPIRY_HOURS).toBe(1);
    expect(cfg.REFRESH_TOKEN_EXPIRY_DAYS).toBe(7);
  });

  it('aruncă eroare clară când GCP_PROJECT_ID lipsește', () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, GCP_PROJECT_ID: '' })
    ).toThrow(/GCP_PROJECT_ID/);
    expect(() =>
      loadConfig({ ...VALID_ENV, GCP_PROJECT_ID: '' })
    ).toThrow(/Configurație invalidă/);
  });

  it('aruncă eroare clară când JWT_SECRET_NAME lipsește', () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, JWT_SECRET_NAME: '' })
    ).toThrow(/JWT_SECRET_NAME/);
  });

  it('aruncă eroare clară când FIREBASE_PROJECT_ID lipsește', () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, FIREBASE_PROJECT_ID: '' })
    ).toThrow(/FIREBASE_PROJECT_ID/);
  });

  it('aruncă pe env complet gol (toate câmpurile required lipsesc)', () => {
    expect(() => loadConfig({})).toThrow(/Configurație invalidă/);
  });

  it('respinge PORT non-numeric (Zod coerce error)', () => {
    expect(() => loadConfig({ ...VALID_ENV, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('respinge PORT negativ', () => {
    expect(() => loadConfig({ ...VALID_ENV, PORT: '-1' })).toThrow(/PORT/);
  });

  it('respinge PORT zero', () => {
    expect(() => loadConfig({ ...VALID_ENV, PORT: '0' })).toThrow(/PORT/);
  });

  it('respinge NODE_ENV invalid', () => {
    expect(() => loadConfig({ ...VALID_ENV, NODE_ENV: 'foo' })).toThrow(/NODE_ENV/);
  });

  it('respinge LOG_LEVEL invalid', () => {
    expect(() => loadConfig({ ...VALID_ENV, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('respinge JWT_EXPIRY_HOURS non-numeric', () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, JWT_EXPIRY_HOURS: 'forever' })
    ).toThrow(/JWT_EXPIRY_HOURS/);
  });

  it('mesajul de eroare include numele câmpului problematic', () => {
    try {
      loadConfig({ ...VALID_ENV, GCP_PROJECT_ID: '' });
    } catch (err) {
      expect(err.message).toContain('Configurație invalidă');
      expect(err.message).toContain('GCP_PROJECT_ID');
    }
  });

  it('acceptă NODE_ENV=staging', () => {
    expect(loadConfig({ ...VALID_ENV, NODE_ENV: 'staging' }).NODE_ENV).toBe(
      'staging'
    );
  });

  it('acceptă NODE_ENV=development', () => {
    expect(loadConfig({ ...VALID_ENV, NODE_ENV: 'development' }).NODE_ENV).toBe(
      'development'
    );
  });
});
