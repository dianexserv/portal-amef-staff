// Teste pentru api-client. Mock-uim `axios` complet ca să capturăm
// interceptor-ele și să simulăm răspunsuri 200/401 fără rețea.

const { fakeInstance, axiosPostMock } = vi.hoisted(() => {
  const fakeInstance = {
    request: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return { fakeInstance, axiosPostMock: vi.fn() };
});

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => fakeInstance),
    post: axiosPostMock,
  },
}));

import {
  TOKEN_KEY,
  REFRESH_KEY,
  USER_KEY,
  setStoredTokens,
  clearStoredTokens,
  getStoredUser,
  _deps as apiDeps,
} from './api-client';

const realRedirect = apiDeps.redirect;

const requestHandler = fakeInstance.interceptors.request.use.mock.calls[0][0];
const responseErrorHandler =
  fakeInstance.interceptors.response.use.mock.calls[0][1];

beforeEach(() => {
  localStorage.clear();
  fakeInstance.request.mockReset();
  axiosPostMock.mockReset();
  apiDeps.redirect = vi.fn();
});

afterAll(() => {
  apiDeps.redirect = realRedirect;
});

describe('request interceptor', () => {
  it('adaugă Authorization Bearer când există JWT în storage', () => {
    localStorage.setItem(TOKEN_KEY, 'jwt-1');
    const cfg = requestHandler({ headers: {} });
    expect(cfg.headers.Authorization).toBe('Bearer jwt-1');
  });

  it('NU setează header-ul când nu există token', () => {
    const cfg = requestHandler({ headers: {} });
    expect(cfg.headers.Authorization).toBeUndefined();
  });

  it('inițializează headers={} dacă lipsesc', () => {
    localStorage.setItem(TOKEN_KEY, 'jwt-x');
    const cfg = requestHandler({});
    expect(cfg.headers.Authorization).toBe('Bearer jwt-x');
  });
});

describe('response interceptor — 401 retry cu refresh', () => {
  it('pe 401 încearcă refresh + retry cu token nou', async () => {
    localStorage.setItem(REFRESH_KEY, 'old-refresh');

    axiosPostMock.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          jwt: 'new-jwt',
          refreshToken: 'new-refresh',
          user: { email: 'a@b.ro' },
        },
      },
    });
    fakeInstance.request.mockResolvedValueOnce({
      data: { success: true, data: { ok: true } },
    });

    const originalConfig = {
      url: '/api/v1/clients',
      headers: {},
      method: 'get',
    };
    const result = await responseErrorHandler({
      config: originalConfig,
      response: { status: 401 },
    });

    // Refresh a fost apelat cu refresh-token-ul vechi
    expect(axiosPostMock).toHaveBeenCalledTimes(1);
    expect(axiosPostMock.mock.calls[0][1]).toEqual({
      refreshToken: 'old-refresh',
    });

    // Storage-ul a fost actualizat cu token-urile noi
    expect(localStorage.getItem(TOKEN_KEY)).toBe('new-jwt');
    expect(localStorage.getItem(REFRESH_KEY)).toBe('new-refresh');

    // Request-ul original a fost re-trimis cu token-ul nou și _retry=true
    expect(fakeInstance.request).toHaveBeenCalledTimes(1);
    const retried = fakeInstance.request.mock.calls[0][0];
    expect(retried.headers.Authorization).toBe('Bearer new-jwt');
    expect(retried._retry).toBe(true);
    expect(result.data.data.ok).toBe(true);
  });

  it('pe non-401 NU încearcă refresh', async () => {
    const err = {
      config: { url: '/api/v1/x', headers: {}, method: 'get' },
      response: { status: 500 },
    };
    await expect(responseErrorHandler(err)).rejects.toBe(err);
    expect(axiosPostMock).not.toHaveBeenCalled();
    expect(fakeInstance.request).not.toHaveBeenCalled();
  });

  it('pe 401 dar deja _retry=true → fail (anti-loop)', async () => {
    const err = {
      config: { url: '/api/v1/x', headers: {}, _retry: true, method: 'get' },
      response: { status: 401 },
    };
    await expect(responseErrorHandler(err)).rejects.toBe(err);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('eșec la refresh → clear tokens + redirect /login', async () => {
    localStorage.setItem(TOKEN_KEY, 'expired');
    localStorage.setItem(REFRESH_KEY, 'also-expired');
    localStorage.setItem(USER_KEY, JSON.stringify({ email: 'a@b.ro' }));

    axiosPostMock.mockRejectedValueOnce(new Error('refresh-failed'));

    await expect(
      responseErrorHandler({
        config: { url: '/api/v1/clients', headers: {}, method: 'get' },
        response: { status: 401 },
      })
    ).rejects.toThrow('refresh-failed');

    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    expect(apiDeps.redirect).toHaveBeenCalledWith('/login');
  });

  it('refresh deduplicat: două 401 paralele → un singur POST /refresh', async () => {
    localStorage.setItem(REFRESH_KEY, 'r-1');

    axiosPostMock.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          jwt: 'jwt-2',
          refreshToken: 'r-2',
          user: { email: 'a@b.ro' },
        },
      },
    });
    fakeInstance.request.mockResolvedValue({ data: { ok: true } });

    const err1 = {
      config: { url: '/api/v1/a', headers: {}, method: 'get' },
      response: { status: 401 },
    };
    const err2 = {
      config: { url: '/api/v1/b', headers: {}, method: 'get' },
      response: { status: 401 },
    };

    await Promise.all([
      responseErrorHandler(err1),
      responseErrorHandler(err2),
    ]);

    // Refresh ar fi trebuit apelat o singură dată
    expect(axiosPostMock).toHaveBeenCalledTimes(1);
    // Ambele request-uri originale re-trimise
    expect(fakeInstance.request).toHaveBeenCalledTimes(2);
  });

  it('401 chiar pe /auth/refresh → clear tokens, fără retry', async () => {
    localStorage.setItem(TOKEN_KEY, 't');
    localStorage.setItem(REFRESH_KEY, 'r');

    const err = {
      config: { url: '/api/v1/auth/refresh', headers: {}, method: 'post' },
      response: { status: 401 },
    };
    await expect(responseErrorHandler(err)).rejects.toBe(err);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(apiDeps.redirect).toHaveBeenCalledWith('/login');
    // Nu am încercat refresh deloc
    expect(axiosPostMock).not.toHaveBeenCalled();
  });
});

describe('thin HTTP wrappers (get/post/put/del)', () => {
  it('forwardează corect către clientul axios mock', async () => {
    const apiClientModule = await import('./api-client');
    fakeInstance.get.mockResolvedValue({ data: { ok: 1 } });
    fakeInstance.post.mockResolvedValue({ data: { ok: 2 } });
    fakeInstance.put.mockResolvedValue({ data: { ok: 3 } });
    fakeInstance.delete.mockResolvedValue({ data: { ok: 4 } });

    await apiClientModule.get('/x', { params: { a: 1 } });
    await apiClientModule.post('/y', { body: 1 });
    await apiClientModule.put('/z', { body: 2 });
    await apiClientModule.del('/w');

    expect(fakeInstance.get).toHaveBeenCalledWith('/x', { params: { a: 1 } });
    expect(fakeInstance.post).toHaveBeenCalledWith('/y', { body: 1 }, undefined);
    expect(fakeInstance.put).toHaveBeenCalledWith('/z', { body: 2 }, undefined);
    expect(fakeInstance.delete).toHaveBeenCalledWith('/w', undefined);
  });
});

describe('refreshTokens — căi de eroare', () => {
  it('fără refresh token în storage → respinge la /login (după 401)', async () => {
    // Nu setăm REFRESH_KEY → refreshTokens aruncă; handleRefreshFailure
    // curăță și redirect-ează.
    await expect(
      responseErrorHandler({
        config: { url: '/api/v1/x', headers: {}, method: 'get' },
        response: { status: 401 },
      })
    ).rejects.toThrow(/Niciun refresh token/);
    expect(apiDeps.redirect).toHaveBeenCalledWith('/login');
  });

  it('răspuns refresh invalid (lipsă jwt) → respinge la /login', async () => {
    localStorage.setItem(REFRESH_KEY, 'r');
    axiosPostMock.mockResolvedValueOnce({ data: { success: true, data: {} } });

    await expect(
      responseErrorHandler({
        config: { url: '/api/v1/x', headers: {}, method: 'get' },
        response: { status: 401 },
      })
    ).rejects.toThrow(/Răspuns refresh invalid/);
    expect(apiDeps.redirect).toHaveBeenCalledWith('/login');
  });
});

describe('default _deps.redirect (production path)', () => {
  it('apelează window.location.assign cu path-ul transmis', () => {
    // jsdom face `window.location.assign` non-configurable + nu permite
    // reasignarea proprietății `location`. Înlocuim întreg obiectul
    // `window.location` (e configurable la nivelul lui window) cu un stub
    // ce expune doar `assign`. Restaurăm la final.
    const originalLocation = window.location;
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { assign: assignSpy },
    });
    try {
      realRedirect('/test-path');
      expect(assignSpy).toHaveBeenCalledWith('/test-path');
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    }
  });
});

describe('storage helpers', () => {
  it('setStoredTokens persistă jwt + refresh + user', () => {
    setStoredTokens({
      jwt: 'j1',
      refreshToken: 'r1',
      user: { email: 'a@b.ro', role: 'tenant_admin' },
    });
    expect(localStorage.getItem(TOKEN_KEY)).toBe('j1');
    expect(localStorage.getItem(REFRESH_KEY)).toBe('r1');
    expect(JSON.parse(localStorage.getItem(USER_KEY))).toEqual({
      email: 'a@b.ro',
      role: 'tenant_admin',
    });
  });

  it('getStoredUser returnează null când nu există', () => {
    expect(getStoredUser()).toBeNull();
  });

  it('getStoredUser returnează null pe JSON corupt (nu aruncă)', () => {
    localStorage.setItem(USER_KEY, 'not-json{{');
    expect(getStoredUser()).toBeNull();
  });

  it('clearStoredTokens șterge toate trei chei', () => {
    setStoredTokens({ jwt: 'j', refreshToken: 'r', user: { x: 1 } });
    clearStoredTokens();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
  });
});
