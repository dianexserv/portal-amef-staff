// Teste pentru secret-manager.js. În CJS, vi.mock NU interceptează require(),
// deci injectăm clientul mock prin `_deps.ClientClass` (test seam exportat
// explicit din modul). Această abordare e deterministă și nu depinde de
// ordinea de hoisting a vi.mock.

vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('PORT', '3001');
vi.stubEnv('LOG_LEVEL', 'silent');
vi.stubEnv('GCP_PROJECT_ID', 'portal-amef');
vi.stubEnv('JWT_SECRET_NAME', 'jwt-secret-test');
vi.stubEnv('JWT_EXPIRY_HOURS', '1');
vi.stubEnv('REFRESH_TOKEN_EXPIRY_DAYS', '7');
vi.stubEnv('FIREBASE_PROJECT_ID', 'portal-amef-test');

const sm = require('./secret-manager');
const { getSecret, clearCache, ValidationError } = sm;

const accessMock = vi.fn();
// Salvăm clientul real ca să-l restaurăm la final (deși după teste oricum
// procesul moare — e o disciplină de igienă a testului).
const realClientClass = sm._deps.ClientClass;

function fakePayload(value) {
  return [{ payload: { data: Buffer.from(value, 'utf8') } }];
}

beforeEach(() => {
  accessMock.mockReset();
  // Înlocuim clasa clientului cu o factory care produce un client cu
  // accessSecretVersion mockat. `clearCache` resetează și clientInstance,
  // forțând o re-instantiere prin _deps.ClientClass la următorul apel.
  sm._deps.ClientClass = function MockClient() {
    return { accessSecretVersion: accessMock };
  };
  clearCache();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  sm._deps.ClientClass = realClientClass;
});

describe('secret-manager', () => {
  it('returnează payload-ul secretului ca string utf8', async () => {
    accessMock.mockResolvedValueOnce(fakePayload('valoare-secret'));
    const value = await getSecret('jwt-secret-test');
    expect(value).toBe('valoare-secret');
  });

  it('construiește numele complet al resursei cu GCP_PROJECT_ID', async () => {
    accessMock.mockResolvedValueOnce(fakePayload('x'));
    await getSecret('my-secret');
    expect(accessMock).toHaveBeenCalledWith({
      name: 'projects/portal-amef/secrets/my-secret/versions/latest',
    });
  });

  it('cachează rezultatul (al doilea apel nu lovește GCP)', async () => {
    accessMock.mockResolvedValueOnce(fakePayload('cached-value'));
    const a = await getSecret('s1');
    const b = await getSecret('s1');
    expect(a).toBe('cached-value');
    expect(b).toBe('cached-value');
    expect(accessMock).toHaveBeenCalledTimes(1);
  });

  it('cache-ul expiră după 5 minute (TTL)', async () => {
    vi.useFakeTimers();
    accessMock.mockResolvedValue(fakePayload('v1'));
    await getSecret('s2');
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await getSecret('s2');
    expect(accessMock).toHaveBeenCalledTimes(2);
  });

  it('cache-ul rămâne valid cu un milisecund înainte de expirare', async () => {
    vi.useFakeTimers();
    accessMock.mockResolvedValue(fakePayload('v1'));
    await getSecret('s3');
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    await getSecret('s3');
    expect(accessMock).toHaveBeenCalledTimes(1);
  });

  it('clearCache forțează re-citirea de la GCP', async () => {
    accessMock.mockResolvedValue(fakePayload('v'));
    await getSecret('s4');
    clearCache();
    // după clearCache, clientul e re-instantiat — re-injectăm mock-ul
    sm._deps.ClientClass = function MockClient() {
      return { accessSecretVersion: accessMock };
    };
    await getSecret('s4');
    expect(accessMock).toHaveBeenCalledTimes(2);
  });

  it('aruncă ValidationError pentru nume gol', async () => {
    await expect(getSecret('')).rejects.toBeInstanceOf(ValidationError);
    await expect(getSecret('   ')).rejects.toBeInstanceOf(ValidationError);
  });

  it('aruncă ValidationError pentru tip non-string', async () => {
    await expect(getSecret(null)).rejects.toBeInstanceOf(ValidationError);
    await expect(getSecret(undefined)).rejects.toBeInstanceOf(ValidationError);
    await expect(getSecret(123)).rejects.toBeInstanceOf(ValidationError);
  });

  it('ValidationError are name și code setate', async () => {
    try {
      await getSecret('');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.name).toBe('ValidationError');
      expect(err.code).toBe('INVALID_SECRET_NAME');
    }
  });

  it('aruncă eroare clară când GCP eșuează (cu numele secretului)', async () => {
    accessMock.mockRejectedValue(new Error('PERMISSION_DENIED on x'));
    await expect(getSecret('s5')).rejects.toThrow(
      /Eșec la citirea secretului "s5"/
    );
    await expect(getSecret('s5')).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('aruncă eroare când payload-ul lipsește din răspuns', async () => {
    accessMock.mockResolvedValueOnce([{ payload: null }]);
    await expect(getSecret('s6')).rejects.toThrow(/payload gol/);
  });

  it('aruncă eroare când payload.data lipsește', async () => {
    accessMock.mockResolvedValueOnce([{ payload: { data: null } }]);
    await expect(getSecret('s7')).rejects.toThrow(/payload gol/);
  });

  it('cache-uri diferite per nume de secret', async () => {
    accessMock.mockResolvedValueOnce(fakePayload('a-value'));
    accessMock.mockResolvedValueOnce(fakePayload('b-value'));
    const a = await getSecret('secret-a');
    const b = await getSecret('secret-b');
    expect(a).toBe('a-value');
    expect(b).toBe('b-value');
    expect(accessMock).toHaveBeenCalledTimes(2);
    // Re-citirile lovesc cache-ul, nu GCP
    await getSecret('secret-a');
    await getSecret('secret-b');
    expect(accessMock).toHaveBeenCalledTimes(2);
  });

  it('decodează corect payload-uri non-Buffer (string brut)', async () => {
    // GCP poate uneori returna data ca string în loc de Buffer (sub
    // anumite versiuni ale clientului). Acoperim ambele căi.
    accessMock.mockResolvedValueOnce([{ payload: { data: 'raw-string' } }]);
    const value = await getSecret('s8');
    expect(value).toBe('raw-string');
  });

  it('CACHE_TTL_MS exportat e 5 minute', () => {
    expect(sm.CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });
});
