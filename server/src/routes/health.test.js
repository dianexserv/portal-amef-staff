// Teste pentru routes/health. Folosim Supertest cu o aplicație Express
// minimală care montează router-ul — păstrăm testul izolat de createApp.

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'silent');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');
vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_SECRET_NAME', 'firebase-service-account-test');

const express = require('express');
const request = require('supertest');
const healthRouter = require('./health');
const { _deps } = healthRouter;

const realDeps = { ..._deps };

function makeApp() {
  const app = express();
  app.use('/health', healthRouter);
  return app;
}

afterAll(() => {
  Object.assign(_deps, realDeps);
});

describe('GET /health', () => {
  it('răspunde 200 cu shape-ul așteptat', async () => {
    const app = makeApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(typeof res.body.data.uptime).toBe('number');
    expect(res.body.data.uptime).toBeGreaterThanOrEqual(0);
    // Timestamp ISO 8601 valid
    expect(typeof res.body.data.timestamp).toBe('string');
    expect(new Date(res.body.data.timestamp).toISOString()).toBe(
      res.body.data.timestamp
    );
  });

  it('NU atinge DB fără ?check=db', async () => {
    const getSharedPool = vi.fn();
    _deps.pool = { getSharedPool };
    await request(makeApp()).get('/health').expect(200);
    expect(getSharedPool).not.toHaveBeenCalled();
  });
});

describe('GET /health?check=db', () => {
  it('cu pool sănătos → 200 și db: ok', async () => {
    _deps.pool = {
      getSharedPool: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
      }),
    };
    const res = await request(makeApp()).get('/health?check=db');
    expect(res.status).toBe(200);
    expect(res.body.data.db).toBe('ok');
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.uptime).toBe('number');
  });

  it('cu pool stricat → 503 și db: down', async () => {
    _deps.pool = {
      getSharedPool: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    const res = await request(makeApp()).get('/health?check=db');
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('DB_UNAVAILABLE');
    expect(res.body.data.db).toBe('down');
    expect(res.body.data.status).toBe('degraded');
  });

  it('cu query care eșuează la SELECT → 503', async () => {
    _deps.pool = {
      getSharedPool: vi.fn().mockResolvedValue({
        query: vi.fn().mockRejectedValue(new Error('relation does not exist')),
      }),
    };
    const res = await request(makeApp()).get('/health?check=db');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('DB_UNAVAILABLE');
  });
});
