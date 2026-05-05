// Teste pentru logger.js. Setăm env la nivel de fișier înainte de require —
// caching-ul CJS face dificilă re-evaluarea modulului per test, deci testăm
// în schimb factory-ul `buildPinoOptions(cfg)` cu config-uri custom pentru
// scenariile cu NODE_ENV / LOG_LEVEL diferite.
//
// Setăm NODE_ENV=production pentru a evita worker thread-ul pino-pretty în
// vitest worker (rulăm deja sub un worker — un al doilea nivel ar fi inutil).

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'warn');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');

const logger = require('./logger');
const { buildPinoOptions, createChildLogger } = logger;

describe('logger (instanță root)', () => {
  it('expune metodele Pino fără erori la load', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.fatal).toBe('function');
    expect(typeof logger.child).toBe('function');
  });

  it('citește nivelul din config.LOG_LEVEL la load (warn)', () => {
    expect(logger.level).toBe('warn');
  });

  it('include base bindings (env=production) la nivel root', () => {
    expect(logger.bindings()).toMatchObject({ env: 'production' });
  });

  it('expune și createChildLogger și buildPinoOptions', () => {
    expect(typeof createChildLogger).toBe('function');
    expect(typeof buildPinoOptions).toBe('function');
  });
});

describe('createChildLogger', () => {
  it('child logger moștenește bindings prin createChildLogger', () => {
    const child = createChildLogger({
      tenant_slug: 'dianex',
      request_id: 'req-123',
    });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe('function');
    // Pino expune bindings-urile curente ale child-ului via .bindings()
    expect(child.bindings()).toMatchObject({
      tenant_slug: 'dianex',
      request_id: 'req-123',
    });
  });

  it('fără argumente nu aruncă (folosește bindings gol)', () => {
    const child = createChildLogger();
    expect(child).toBeDefined();
    expect(typeof child.info).toBe('function');
  });

  it('apelează logger.child cu bindings (verificat prin spy)', () => {
    const spy = vi.spyOn(logger, 'child');
    createChildLogger({ tenant_slug: 'dianex' });
    expect(spy).toHaveBeenCalledWith({ tenant_slug: 'dianex' });
    spy.mockRestore();
  });
});

describe('buildPinoOptions (factory testabil)', () => {
  it('în production NU configurează transport pino-pretty (JSON pur)', () => {
    const opts = buildPinoOptions({
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
    });
    expect(opts.transport).toBeUndefined();
    expect(opts.level).toBe('info');
    expect(opts.base).toMatchObject({ env: 'production' });
  });

  it('în staging NU configurează transport (tot JSON pur, ca production)', () => {
    const opts = buildPinoOptions({
      NODE_ENV: 'staging',
      LOG_LEVEL: 'info',
    });
    expect(opts.transport).toBeUndefined();
    expect(opts.base).toMatchObject({ env: 'staging' });
  });

  it('în development configurează transport pino-pretty', () => {
    const opts = buildPinoOptions({
      NODE_ENV: 'development',
      LOG_LEVEL: 'debug',
    });
    expect(opts.transport).toBeDefined();
    expect(opts.transport.target).toBe('pino-pretty');
    expect(opts.transport.options.colorize).toBe(true);
    expect(opts.transport.options.translateTime).toBe('SYS:standard');
    expect(opts.transport.options.ignore).toBe('pid,hostname');
    expect(opts.base).toMatchObject({ env: 'development' });
    expect(opts.level).toBe('debug');
  });

  it('reflectă LOG_LEVEL în opțiuni', () => {
    expect(
      buildPinoOptions({ NODE_ENV: 'production', LOG_LEVEL: 'silent' }).level
    ).toBe('silent');
    expect(
      buildPinoOptions({ NODE_ENV: 'production', LOG_LEVEL: 'trace' }).level
    ).toBe('trace');
    expect(
      buildPinoOptions({ NODE_ENV: 'production', LOG_LEVEL: 'fatal' }).level
    ).toBe('fatal');
  });

  it('include funcție de timestamp ISO', () => {
    const opts = buildPinoOptions({
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
    });
    expect(typeof opts.timestamp).toBe('function');
  });

  it('fără argument folosește config-ul default (modulul)', () => {
    const opts = buildPinoOptions();
    expect(opts.level).toBe('warn'); // LOG_LEVEL setat în vi.stubEnv
    expect(opts.base).toMatchObject({ env: 'production' });
  });
});
