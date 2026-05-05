// React context pentru sesiunea utilizatorului.
//
// State-ul:
//   - user: { email, role, tenantSlug } | null
//   - loading: true cât timp citim din localStorage la mount
//   - isAuthenticated: shorthand, derived
//
// Acțiuni:
//   - login(idToken): trimite Firebase idToken la backend, primește JWT-urile
//     proprii + payload-ul user, le persistă în localStorage și actualizează
//     state-ul React.
//   - logout(): șterge tokens, sign out din Firebase (ca popup-ul să întrebe
//     din nou la următorul login), notifică backend-ul (audit), redirect /login.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { signOut } from 'firebase/auth';

import { auth } from '../firebase';
import {
  post,
  setStoredTokens,
  clearStoredTokens,
  getStoredUser,
  getStoredToken,
} from '../utils/api-client';

const AuthContext = createContext(null);

// Test seam — modulul poate fi încărcat fără firebase real în teste; tests
// suprascriu `_deps.signOut` ca să evite call-uri către Firebase efective.
export const _deps = {
  signOut,
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // La mount, restaurăm sesiunea din localStorage (dacă există). Notă:
  // NU validăm aici expirarea JWT-ului — la primul request 401, axios
  // interceptor-ul va încerca refresh; dacă și acela eșuează, redirect /login.
  useEffect(() => {
    const stored = getStoredUser();
    const token = getStoredToken();
    if (stored && token) {
      setUser(stored);
    }
    setLoading(false);
  }, []);

  const login = useCallback(async (idToken) => {
    const response = await post('/api/v1/auth/firebase-login', { idToken });
    const data = response.data && response.data.data;
    if (!data || !data.jwt || !data.refreshToken || !data.user) {
      throw new Error('Răspuns login invalid de la server.');
    }
    setStoredTokens({
      jwt: data.jwt,
      refreshToken: data.refreshToken,
      user: data.user,
    });
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    // Best-effort: notify backend pentru audit log. Dacă pică (network /
    // token expirat), ștergem oricum local — utilizatorul vrea să iasă.
    try {
      await post('/api/v1/auth/logout');
    } catch {
      /* ignorăm — local cleanup contează mai mult decât audit-ul */
    }
    try {
      await _deps.signOut(auth);
    } catch {
      /* idem */
    }
    clearStoredTokens();
    setUser(null);
  }, []);

  const value = {
    user,
    loading,
    isAuthenticated: Boolean(user),
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error(
      'useAuth() trebuie folosit în interiorul unui <AuthProvider>.'
    );
  }
  return ctx;
}
