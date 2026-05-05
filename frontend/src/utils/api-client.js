// Axios client cu refresh-on-401 transparent.
//
// Pe orice request adăugăm `Authorization: Bearer <jwt>` (din localStorage).
// Pe 401 încercăm să rotim perechea (jwt, refreshToken) prin /auth/refresh,
// apoi re-trimitem request-ul original. Dacă refresh-ul eșuează, ștergem
// token-urile din storage și redirecționăm la /login (sesiune complet
// expirată).
//
// CACHEUIM promisiunea de refresh în-flight ca să nu lansăm 5 refresh-uri
// paralele când 5 request-uri eșuează simultan cu 401 (ex: pagina de
// dashboard care face 5 GET-uri în paralel).

import axios from 'axios';

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

export const TOKEN_KEY = 'amef.jwt';
export const REFRESH_KEY = 'amef.refresh';
export const USER_KEY = 'amef.user';

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function getStoredRefresh() {
  return localStorage.getItem(REFRESH_KEY);
}
export function setStoredTokens({ jwt, refreshToken, user }) {
  if (jwt) localStorage.setItem(TOKEN_KEY, jwt);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
}
export function clearStoredTokens() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}
export function getStoredUser() {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

apiClient.interceptors.request.use((requestConfig) => {
  const token = getStoredToken();
  if (token) {
    requestConfig.headers = requestConfig.headers || {};
    requestConfig.headers.Authorization = `Bearer ${token}`;
  }
  return requestConfig;
});

let refreshInFlight = null;

async function refreshTokens() {
  // Folosim axios brut (NU `apiClient`) ca să sărim peste interceptor-ul de
  // request — altfel am trimite Authorization cu token-ul vechi care tocmai
  // a expirat și am intra în recursie pe 401.
  const refreshToken = getStoredRefresh();
  if (!refreshToken) {
    throw new Error('Niciun refresh token în storage.');
  }
  const response = await axios.post(
    `${API_BASE_URL}/api/v1/auth/refresh`,
    { refreshToken },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const data = response.data && response.data.data;
  if (!data || !data.jwt || !data.refreshToken) {
    throw new Error('Răspuns refresh invalid.');
  }
  setStoredTokens({
    jwt: data.jwt,
    refreshToken: data.refreshToken,
    user: data.user,
  });
  return data.jwt;
}

// Test seam: în jsdom, `window.location.assign` e read-only / non-configurable,
// deci redirect-ul nu poate fi spy-uit direct. Expunem fabrica via `_deps`
// ca testele să poată injecta un mock fără hack-uri pe `window.location`.
export const _deps = {
  redirect: (path) => {
    if (typeof window !== 'undefined' && window.location) {
      window.location.assign(path);
    }
  },
};

function handleRefreshFailure() {
  clearStoredTokens();
  _deps.redirect('/login');
}

apiClient.interceptors.response.use(
  (resp) => resp,
  async (error) => {
    const original = error.config;
    if (
      !original ||
      original._retry ||
      !error.response ||
      error.response.status !== 401
    ) {
      return Promise.reject(error);
    }
    // Cererea care a eșuat era chiar pe /refresh — nu reîncerca, deconectează.
    if (
      typeof original.url === 'string' &&
      original.url.includes('/auth/refresh')
    ) {
      handleRefreshFailure();
      return Promise.reject(error);
    }
    original._retry = true;
    try {
      if (!refreshInFlight) {
        refreshInFlight = refreshTokens().finally(() => {
          refreshInFlight = null;
        });
      }
      const newToken = await refreshInFlight;
      original.headers = original.headers || {};
      original.headers.Authorization = `Bearer ${newToken}`;
      return apiClient.request(original);
    } catch (refreshErr) {
      handleRefreshFailure();
      return Promise.reject(refreshErr);
    }
  }
);

export const get = (url, config) => apiClient.get(url, config);
export const post = (url, body, config) => apiClient.post(url, body, config);
export const put = (url, body, config) => apiClient.put(url, body, config);
export const del = (url, config) => apiClient.delete(url, config);

export default apiClient;
