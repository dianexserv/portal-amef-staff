// Teste end-to-end pentru `createApp` cu Supertest. Verificăm wiring-ul
// (helmet/cors/pino-http/json/rateLimit/health/404/error) fără să pornim
// un server — Supertest acceptă direct app-ul Express.

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'silent');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');
vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_SECRET_NAME', 'firebase-service-account-test');
vi.stubEnv('CORS_ORIGIN', 'https://allowed.example.com');

const request = require('supertest');
const createApp = require('./app');

describe('createApp — montare rute', () => {
  it('GET /health → 200', async () => {
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/v1/nonexistent → 404 cu code NOT_FOUND', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: expect.stringContaining('Resursa nu a fost găsită'),
      code: 'NOT_FOUND',
    });
    expect(res.body.error).toContain('GET');
    expect(res.body.error).toContain('/api/v1/nonexistent');
  });

  it('GET pe rută complet necunoscută → 404', async () => {
    const app = createApp();
    const res = await request(app).get('/totally-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('createApp — securitate (Helmet)', () => {
  it('răspunde cu header-ele de bază Helmet', async () => {
    const app = createApp();
    const res = await request(app).get('/health');
    // Helmet setează aceste header-e implicit; verificăm un subset
    // reprezentativ ca regression check al integrării.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-dns-prefetch-control']).toBeDefined();
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});

describe('createApp — CORS', () => {
  it('permite originea configurată', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://allowed.example.com');
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://allowed.example.com'
    );
  });

  it('NU emite Access-Control-Allow-Origin pentru origini neautorizate', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://attacker.example.com');
    // Cors lib refuză să seteze header-ul → browser-ul blochează request-ul
    expect(res.headers['access-control-allow-origin']).not.toBe(
      'https://attacker.example.com'
    );
  });
});

describe('createApp — rate limit', () => {
  it('returnează 429 după ce s-a depășit limita pe /api/*', async () => {
    // Limit foarte mic ca testul să fie rapid + decuplat de fereastra reală.
    const app = createApp({ rateLimit: { windowMs: 60_000, max: 2 } });

    // Primele 2 cereri trec (404 — endpoint inexistent — dar nu rate-limited)
    const r1 = await request(app).get('/api/v1/x');
    const r2 = await request(app).get('/api/v1/x');
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);

    // A treia depășește max-ul
    const r3 = await request(app).get('/api/v1/x');
    expect(r3.status).toBe(429);
    expect(r3.body).toMatchObject({
      success: false,
      code: 'RATE_LIMITED',
    });
  });

  it('rate limit NU se aplică pe /health (probe-urile trec mereu)', async () => {
    const app = createApp({ rateLimit: { windowMs: 60_000, max: 1 } });
    const r1 = await request(app).get('/health');
    const r2 = await request(app).get('/health');
    const r3 = await request(app).get('/health');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
  });
});

describe('createApp — JSON body', () => {
  it('respinge payload peste 1mb cu 413', async () => {
    const app = createApp();
    // Construim un body JSON mai mare de 1mb
    const big = 'x'.repeat(1024 * 1024 + 100);
    const res = await request(app)
      .post('/api/v1/anything')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ payload: big }));
    expect(res.status).toBe(413);
  });

  it('acceptă JSON valid mic (parser-ul e wired)', async () => {
    const app = createApp();
    // Endpoint inexistent → 404, dar dovedește că body-ul a fost parsat
    // (altfel ar fi fost un alt cod).
    const res = await request(app)
      .post('/api/v1/anything')
      .send({ hello: 'world' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
