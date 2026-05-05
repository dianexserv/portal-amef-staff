// Teste pentru anaf-lookup-service.
//
// Filosofie: nu lovim ANAF real — `_deps.httpClient` e suprascris cu vi.fn()
// care returnează răspunsuri prefabricate. `_deps.now` controlează TTL-ul
// cache-ului deterministic. `_deps.logger` e mock pentru a verifica
// log-urile la retry/fallback.
//
// Cache-ul e module-level — golim înainte de fiecare test ca să fie
// independente.

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'silent');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');
vi.stubEnv(
  'FIREBASE_SERVICE_ACCOUNT_SECRET_NAME',
  'firebase-service-account-test'
);

const anafService = require('./anaf-lookup-service');
const {
  ValidationError,
  NotFoundError,
  ServiceUnavailableError,
} = require('../errors');

const realDeps = { ...anafService._deps };

// FIXED_NOW e un timestamp arbitrar (UTC) ca testele să fie deterministe.
// 2026-05-05T10:00:00Z în ms.
const FIXED_NOW = new Date('2026-05-05T10:00:00Z').getTime();

function buildSuccessfulV9Response(overrides = {}) {
  return {
    cod: 200,
    message: 'SUCCES',
    found: [
      {
        date_generale: {
          cui: 1234567,
          data: '2026-05-05',
          denumire: 'EXAMPLE SRL',
          adresa: 'STR. EXAMPLE NR. 1, BUCURESTI',
          nrRegCom: 'J40/123/2020',
          cod_CAEN: '6201',
          data_inregistrare: '2020-01-15',
          ...((overrides && overrides.date_generale) || {}),
        },
        inregistrare_scop_Tva: { scpTVA: true },
        stare_inactiv: { statusInactivi: false },
        inregistrare_SplitTVA: { statusSplitTVA: false },
        adresa_sediu_social: {
          sdenumire_Strada: 'STR. EXAMPLE',
          snumar_Strada: '1',
          sdenumire_Localitate: 'BUCURESTI SECTORUL 1',
          scod_JudetAuto: 'B',
          scod_Postal: '010001',
        },
        adresa_domiciliu_fiscal: {
          ddenumire_Strada: 'STR. EXAMPLE',
          dnumar_Strada: '1',
          ddenumire_Localitate: 'BUCURESTI SECTORUL 1',
          dcod_JudetAuto: 'B',
          dcod_Postal: '010001',
        },
        ...((overrides && overrides.foundExtra) || {}),
      },
    ],
    notFound: [],
  };
}

function buildNotFoundV9Response(cui = 1234567) {
  return {
    cod: 200,
    message: 'SUCCES',
    found: [],
    notFound: [cui],
  };
}

function http5xxError(status = 500) {
  const e = new Error(`HTTP ${status}`);
  e.response = { status, data: 'Internal Server Error' };
  return e;
}

function networkError() {
  const e = new Error('ECONNRESET');
  e.code = 'ECONNRESET';
  // Fără `response` — `shouldRetry` îl tratează ca network error → retry.
  return e;
}

beforeEach(() => {
  anafService._deps.httpClient = vi.fn();
  anafService._deps.logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  anafService._deps.now = vi.fn(() => FIXED_NOW);
  anafService._clearCache();
});

afterAll(() => {
  Object.assign(anafService._deps, realDeps);
  anafService._clearCache();
});

// ─────────────────────────────────────────────────────────────────────────
// _normalizeCui (testat direct)
// ─────────────────────────────────────────────────────────────────────────

describe('normalizeCui', () => {
  it("'1234567' → '1234567'", () => {
    expect(anafService._normalizeCui('1234567')).toBe('1234567');
  });

  it("'RO1234567' → '1234567'", () => {
    expect(anafService._normalizeCui('RO1234567')).toBe('1234567');
  });

  it("'ro 1234567' → '1234567' (case-insensitive + spațiu)", () => {
    expect(anafService._normalizeCui('ro 1234567')).toBe('1234567');
  });

  it("integer 1234567 → '1234567'", () => {
    expect(anafService._normalizeCui(1234567)).toBe('1234567');
  });

  it('input nevalid → ValidationError(INVALID_CUI)', () => {
    expect(() => anafService._normalizeCui('ABC')).toThrow(ValidationError);
    expect(() => anafService._normalizeCui('')).toThrow(/CUI invalid/);
    expect(() => anafService._normalizeCui(null)).toThrow(ValidationError);
    expect(() => anafService._normalizeCui(undefined)).toThrow(ValidationError);
    // float și negativ — INVALID
    expect(() => anafService._normalizeCui(-5)).toThrow(ValidationError);
    expect(() => anafService._normalizeCui(1.5)).toThrow(ValidationError);
    try {
      anafService._normalizeCui('XYZ');
    } catch (err) {
      expect(err.code).toBe('INVALID_CUI');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// lookupByCui — happy path
// ─────────────────────────────────────────────────────────────────────────

describe('lookupByCui — happy path', () => {
  it('cache miss → call ANAF + map result + cache', async () => {
    anafService._deps.httpClient.mockResolvedValueOnce({
      data: buildSuccessfulV9Response(),
    });

    const result = await anafService.lookupByCui('RO1234567', {
      referenceDate: '2026-05-05',
    });

    expect(anafService._deps.httpClient).toHaveBeenCalledTimes(1);
    const [url, body, opts] = anafService._deps.httpClient.mock.calls[0];
    expect(url).toBe('https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva');
    expect(body).toEqual([{ cui: 1234567, data: '2026-05-05' }]);
    expect(opts.timeout).toBe(15000);
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' });

    expect(result.cui).toBe('1234567');
    expect(result.denumire).toBe('EXAMPLE SRL');
    expect(result.is_vat_payer).toBe(true);
    expect(result.is_inactive).toBe(false);
    expect(result.is_split_tva).toBe(false);
    expect(result.cod_caen).toBe('6201');
    expect(result.nr_reg_com).toBe('J40/123/2020');
    expect(result.adresa_sediu.county).toBe('Bucuresti');
    expect(result.adresa_sediu.city).toBe('Sector 1');
    expect(result.adresa_domiciliu_fiscal.county).toBe('Bucuresti');
    expect(result.stale).toBe(false);
    expect(result.fetched_at).toBe(new Date(FIXED_NOW).toISOString());
    // raw payload păstrat în anaf_data
    expect(result.anaf_data.date_generale.cui).toBe(1234567);
  });

  it('cache hit → NU mai cheamă ANAF', async () => {
    // Prima cerere populează cache-ul
    anafService._deps.httpClient.mockResolvedValueOnce({
      data: buildSuccessfulV9Response(),
    });
    await anafService.lookupByCui('RO1234567', { referenceDate: '2026-05-05' });
    expect(anafService._deps.httpClient).toHaveBeenCalledTimes(1);

    // A doua cerere — cache hit
    const cached = await anafService.lookupByCui('1234567', {
      referenceDate: '2026-05-05',
    });
    expect(anafService._deps.httpClient).toHaveBeenCalledTimes(1);
    expect(cached.denumire).toBe('EXAMPLE SRL');
  });

  it('skipCache=true → bypass cache, call live', async () => {
    anafService._deps.httpClient.mockResolvedValue({
      data: buildSuccessfulV9Response(),
    });
    await anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' });
    await anafService.lookupByCui('1234567', {
      referenceDate: '2026-05-05',
      skipCache: true,
    });
    expect(anafService._deps.httpClient).toHaveBeenCalledTimes(2);
  });

  it('referenceDate diferit → cache miss (cheia include data)', async () => {
    anafService._deps.httpClient.mockResolvedValue({
      data: buildSuccessfulV9Response(),
    });
    await anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' });
    await anafService.lookupByCui('1234567', { referenceDate: '2026-05-06' });
    expect(anafService._deps.httpClient).toHaveBeenCalledTimes(2);
  });

  it('referenceDate ca Date object e formatat la YYYY-MM-DD', async () => {
    anafService._deps.httpClient.mockResolvedValueOnce({
      data: buildSuccessfulV9Response(),
    });
    const refDate = new Date('2026-06-15T14:30:00Z');
    await anafService.lookupByCui('1234567', { referenceDate: refDate });
    const body = anafService._deps.httpClient.mock.calls[0][1];
    expect(body[0].data).toBe('2026-06-15');
  });

  it('fără options.referenceDate → folosește data curentă (UTC)', async () => {
    anafService._deps.httpClient.mockResolvedValueOnce({
      data: buildSuccessfulV9Response(),
    });
    await anafService.lookupByCui('1234567');
    const body = anafService._deps.httpClient.mock.calls[0][1];
    // YYYY-MM-DD valid format
    expect(body[0].data).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// lookupByCui — notFound
// ─────────────────────────────────────────────────────────────────────────

describe('lookupByCui — notFound', () => {
  it('ANAF returnează notFound → NotFoundError(CUI_NOT_FOUND_AT_ANAF)', async () => {
    anafService._deps.httpClient.mockResolvedValueOnce({
      data: buildNotFoundV9Response(1234567),
    });
    await expect(
      anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' })
    ).rejects.toMatchObject({
      name: 'NotFoundError',
      code: 'CUI_NOT_FOUND_AT_ANAF',
      statusCode: 404,
    });
  });

  it('notFound NU e cached — call următor face request nou', async () => {
    anafService._deps.httpClient
      .mockResolvedValueOnce({ data: buildNotFoundV9Response(1234567) })
      .mockResolvedValueOnce({ data: buildSuccessfulV9Response() });

    await expect(
      anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' })
    ).rejects.toThrow(NotFoundError);
    // A doua cerere îl găsește (s-a înregistrat între timp); call live, nu cached.
    const result = await anafService.lookupByCui('1234567', {
      referenceDate: '2026-05-05',
    });
    expect(result.denumire).toBe('EXAMPLE SRL');
    expect(anafService._deps.httpClient).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// lookupByCui — retry
// ─────────────────────────────────────────────────────────────────────────

describe('lookupByCui — retry', () => {
  it('500 → retry → success', async () => {
    anafService._deps.httpClient
      .mockRejectedValueOnce(http5xxError(500))
      .mockResolvedValueOnce({ data: buildSuccessfulV9Response() });

    const result = await anafService.lookupByCui('1234567', {
      referenceDate: '2026-05-05',
    });
    expect(result.denumire).toBe('EXAMPLE SRL');
    expect(anafService._deps.httpClient).toHaveBeenCalledTimes(2);
    expect(anafService._deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1 }),
      expect.stringMatching(/retrying/i)
    );
  });

  it('network error → retry → success', async () => {
    anafService._deps.httpClient
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce({ data: buildSuccessfulV9Response() });

    await anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' });
    expect(anafService._deps.httpClient).toHaveBeenCalledTimes(2);
  });

  it('toate 3 încercări 5xx, fără cache → ServiceUnavailableError(ANAF_UNAVAILABLE)', async () => {
    anafService._deps.httpClient
      .mockRejectedValueOnce(http5xxError(500))
      .mockRejectedValueOnce(http5xxError(502))
      .mockRejectedValueOnce(http5xxError(503));

    await expect(
      anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' })
    ).rejects.toMatchObject({
      name: 'ServiceUnavailableError',
      code: 'ANAF_UNAVAILABLE',
      statusCode: 503,
    });
    expect(anafService._deps.httpClient).toHaveBeenCalledTimes(3);
    expect(anafService._deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ cui: '1234567' }),
      expect.stringMatching(/no cache fallback/i)
    );
  });

  it('toate încercările eșuează DAR cache disponibil → returnează cached cu stale=true', async () => {
    // Pas 1: populăm cache-ul cu o cerere reușită
    anafService._deps.httpClient.mockResolvedValueOnce({
      data: buildSuccessfulV9Response(),
    });
    const fresh = await anafService.lookupByCui('1234567', {
      referenceDate: '2026-05-05',
    });
    expect(fresh.stale).toBe(false);

    // Pas 2: forțăm expirarea (now() = +25h) ca să iasă din TTL → ANAF
    // re-call, care va eșua → fallback la cache stale.
    anafService._deps.now = vi.fn(() => FIXED_NOW + 25 * 60 * 60 * 1000);
    anafService._deps.httpClient
      .mockRejectedValueOnce(http5xxError(500))
      .mockRejectedValueOnce(http5xxError(500))
      .mockRejectedValueOnce(http5xxError(500));

    const stale = await anafService.lookupByCui('1234567', {
      referenceDate: '2026-05-05',
    });
    expect(stale.stale).toBe(true);
    expect(stale.denumire).toBe('EXAMPLE SRL');
    expect(anafService._deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cui: '1234567' }),
      expect.stringMatching(/stale cache/i)
    );
  });

  it('HTTP 4xx (alta decât 429) — NU retry, throws direct', async () => {
    const err400 = new Error('Bad Request');
    err400.response = { status: 400, data: 'invalid payload' };
    anafService._deps.httpClient.mockRejectedValueOnce(err400);

    await expect(
      anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' })
    ).rejects.toThrow(ServiceUnavailableError);
    // Doar un singur call — NU s-a făcut retry pe 400.
    expect(anafService._deps.httpClient).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// lookupByCui — Zod validation
// ─────────────────────────────────────────────────────────────────────────

describe('lookupByCui — răspuns malformat', () => {
  it('lipsește found în răspuns → ServiceUnavailableError(ANAF_RESPONSE_INVALID)', async () => {
    anafService._deps.httpClient.mockResolvedValueOnce({
      data: { cod: 200, message: 'SUCCES', notFound: [] },
    });
    await expect(
      anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' })
    ).rejects.toMatchObject({
      name: 'ServiceUnavailableError',
      code: 'ANAF_RESPONSE_INVALID',
    });
    expect(anafService._deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ cui: '1234567' }),
      expect.stringMatching(/shape invalid/i)
    );
  });

  it('date_generale fără denumire → ServiceUnavailableError', async () => {
    const malformed = buildSuccessfulV9Response();
    delete malformed.found[0].date_generale.denumire;
    anafService._deps.httpClient.mockResolvedValueOnce({ data: malformed });

    await expect(
      anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' })
    ).rejects.toMatchObject({ code: 'ANAF_RESPONSE_INVALID' });
  });

  it('found gol și notFound gol → ServiceUnavailableError (status anormal)', async () => {
    anafService._deps.httpClient.mockResolvedValueOnce({
      data: { cod: 200, message: 'SUCCES', found: [], notFound: [] },
    });
    await expect(
      anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' })
    ).rejects.toMatchObject({ code: 'ANAF_RESPONSE_INVALID' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cache management
// ─────────────────────────────────────────────────────────────────────────

describe('cache management', () => {
  it('entry e stocat cu cachedAt timestamp', async () => {
    anafService._deps.httpClient.mockResolvedValueOnce({
      data: buildSuccessfulV9Response(),
    });
    await anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' });

    // Hit imediat = cache fresh; verificăm prin lipsa unui al doilea call la ANAF.
    await anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' });
    expect(anafService._deps.httpClient).toHaveBeenCalledTimes(1);
  });

  it('entry expiră după 24h — call ANAF din nou', async () => {
    anafService._deps.httpClient.mockResolvedValueOnce({
      data: buildSuccessfulV9Response(),
    });
    await anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' });
    expect(anafService._deps.httpClient).toHaveBeenCalledTimes(1);

    // Avansăm timpul cu 25h ca entry-ul să fie expirat.
    anafService._deps.now = vi.fn(() => FIXED_NOW + 25 * 60 * 60 * 1000);
    anafService._deps.httpClient.mockResolvedValueOnce({
      data: buildSuccessfulV9Response(),
    });
    await anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' });
    expect(anafService._deps.httpClient).toHaveBeenCalledTimes(2);
  });

  it('_clearCache() șterge toate entries-urile', async () => {
    anafService._deps.httpClient.mockResolvedValue({
      data: buildSuccessfulV9Response(),
    });
    await anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' });
    anafService._clearCache();
    await anafService.lookupByCui('1234567', { referenceDate: '2026-05-05' });
    expect(anafService._deps.httpClient).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Mapping adresa pentru județe non-București
// ─────────────────────────────────────────────────────────────────────────

describe('mapping adresa — non-București', () => {
  it('Cluj — city = nume localitate (NU sector)', async () => {
    const response = buildSuccessfulV9Response({
      foundExtra: {
        adresa_sediu_social: {
          sdenumire_Strada: 'STR. MOTILOR',
          snumar_Strada: '12',
          sdenumire_Localitate: 'CLUJ-NAPOCA',
          scod_JudetAuto: 'CJ',
          scod_Postal: '400001',
        },
        adresa_domiciliu_fiscal: {
          ddenumire_Strada: 'STR. MOTILOR',
          dnumar_Strada: '12',
          ddenumire_Localitate: 'CLUJ-NAPOCA',
          dcod_JudetAuto: 'CJ',
          dcod_Postal: '400001',
        },
      },
    });
    anafService._deps.httpClient.mockResolvedValueOnce({ data: response });

    const result = await anafService.lookupByCui('1234567', {
      referenceDate: '2026-05-05',
    });
    expect(result.adresa_sediu.county).toBe('Cluj');
    expect(result.adresa_sediu.city).toBe('CLUJ-NAPOCA');
    expect(result.adresa_sediu.street).toBe('STR. MOTILOR');
    expect(result.adresa_sediu.street_number).toBe('12');
    expect(result.adresa_sediu.postal_code).toBe('400001');
  });

  it('judet cod necunoscut → county trece prin (defensive)', async () => {
    const response = buildSuccessfulV9Response();
    response.found[0].adresa_sediu_social.scod_JudetAuto = 'XX';
    anafService._deps.httpClient.mockResolvedValueOnce({ data: response });

    const result = await anafService.lookupByCui('1234567', {
      referenceDate: '2026-05-05',
    });
    // 'XX' nu e mapat → normalizeJudetCod returnează '' → county gol.
    expect(result.adresa_sediu.county).toBe('');
  });

  it('adresa lipsește complet → toate câmpurile string gol', () => {
    const result = anafService._mapAnafResponseToResult(
      {
        date_generale: {
          cui: 1234567,
          data: '2026-05-05',
          denumire: 'TEST',
          adresa: '',
          nrRegCom: '',
          cod_CAEN: '',
          data_inregistrare: '',
        },
      },
      FIXED_NOW
    );
    expect(result.adresa_sediu).toEqual({
      county: '',
      city: '',
      street: '',
      street_number: '',
      postal_code: '',
    });
    expect(result.is_vat_payer).toBe(false);
    expect(result.is_inactive).toBe(false);
    expect(result.is_split_tva).toBe(false);
  });
});
