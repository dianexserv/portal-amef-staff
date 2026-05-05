// Teste pentru anaf-rate-limit. Folosim `buildAnafRateLimit({ max: 3 })` ca
// testele să atingă 429 după 3 cereri, fără să așteptăm 30 sau o oră.
// Construim o mini-app Express care apelează direct middleware-ul cu
// `req.user` populat (în prod authMiddleware face asta).

const express = require('express');
const request = require('supertest');

const {
  buildAnafRateLimit,
  ANAF_RATE_LIMIT_MAX,
  ANAF_RATE_LIMIT_WINDOW_MS,
} = require('./anaf-rate-limit');

function makeApp({ user, max = 3 }) {
  const app = express();
  // Middleware care simulează authMiddleware: populează req.user.
  // Testul controlează cine e user-ul ca să verificăm cota per-user.
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use(buildAnafRateLimit({ max }));
  app.get('/x', (_req, res) => res.json({ ok: true }));
  return app;
}

const USER_A = {
  firebaseUid: 'fb-a',
  tenantSlug: 'dianex',
  email: 'a@b.ro',
};
const USER_B = {
  firebaseUid: 'fb-b',
  tenantSlug: 'dianex',
  email: 'b@b.ro',
};

describe('anafRateLimit — defaults', () => {
  it('exportă constantele așteptate (30/h)', () => {
    expect(ANAF_RATE_LIMIT_MAX).toBe(30);
    expect(ANAF_RATE_LIMIT_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});

describe('anafRateLimit — comportament', () => {
  it('prima cerere trece (sub limit)', async () => {
    const app = makeApp({ user: USER_A, max: 3 });
    const res = await request(app).get('/x');
    expect(res.status).toBe(200);
  });

  it('cererile sub limită trec; cererea peste limită → 429 cu code ANAF_RATE_LIMIT', async () => {
    const app = makeApp({ user: USER_A, max: 3 });
    // 3 cereri în limită, a 4-a peste
    for (let i = 0; i < 3; i++) {
      const ok = await request(app).get('/x');
      expect(ok.status).toBe(200);
    }
    const blocked = await request(app).get('/x');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      success: false,
      error: expect.stringMatching(/ANAF/i),
      code: 'ANAF_RATE_LIMIT',
    });
  });

  it('cota e per-user: user A blocat, user B trece', async () => {
    // Cele două app-uri share aceeași instanță rateLimit din modul? NU —
    // facem două instanțe distincte ca să nu existe state cross-test.
    // Aici testul e pe o singură instanță middleware partajată între
    // requests-urile pentru cei doi useri (același app).
    const userHolder = { current: USER_A };
    const app = express();
    app.use((req, _res, next) => {
      req.user = userHolder.current;
      next();
    });
    app.use(buildAnafRateLimit({ max: 2 }));
    app.get('/x', (_req, res) => res.json({ ok: true }));

    // User A consumă cota.
    userHolder.current = USER_A;
    await request(app).get('/x');
    await request(app).get('/x');
    const aBlocked = await request(app).get('/x');
    expect(aBlocked.status).toBe(429);

    // User B intră acum — cota lui e separată.
    userHolder.current = USER_B;
    const bOk = await request(app).get('/x');
    expect(bOk.status).toBe(200);
  });

  it('header-ele RateLimit-* sunt prezente (standardHeaders draft-7)', async () => {
    const app = makeApp({ user: USER_A, max: 3 });
    const res = await request(app).get('/x');
    expect(res.headers['ratelimit']).toBeDefined();
    // draft-7 unifică totul în header-ul `RateLimit`; verificăm că include
    // limita și remaining-ul în formatul standard.
    expect(res.headers['ratelimit']).toMatch(/limit=3/);
  });

  it('lipsa req.user → fallback pe IP (defense-in-depth)', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = undefined;
      next();
    });
    app.use(buildAnafRateLimit({ max: 1 }));
    app.get('/x', (_req, res) => res.json({ ok: true }));

    const ok = await request(app).get('/x');
    expect(ok.status).toBe(200);
    const blocked = await request(app).get('/x');
    expect(blocked.status).toBe(429);
  });

  it('req.user există dar fără tenantSlug → fallback pe IP', async () => {
    const app = express();
    app.use((req, _res, next) => {
      // user setat dar fără tenantSlug — ramură de defense-in-depth pentru
      // bug-uri în authMiddleware sau token-uri vechi fără claim-uri complete.
      req.user = { firebaseUid: 'fb-x' };
      next();
    });
    app.use(buildAnafRateLimit({ max: 1 }));
    app.get('/x', (_req, res) => res.json({ ok: true }));

    const ok = await request(app).get('/x');
    expect(ok.status).toBe(200);
    const blocked = await request(app).get('/x');
    expect(blocked.status).toBe(429);
  });

  it('req.user cu tenantSlug dar fără firebaseUid → fallback pe IP', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = { tenantSlug: 'dianex' };
      next();
    });
    app.use(buildAnafRateLimit({ max: 1 }));
    app.get('/x', (_req, res) => res.json({ ok: true }));

    const ok = await request(app).get('/x');
    expect(ok.status).toBe(200);
    const blocked = await request(app).get('/x');
    expect(blocked.status).toBe(429);
  });
});
