// Teste pentru AuthContext. Mock-uim firebase + api-client la nivel de modul.

vi.mock('../firebase', () => ({
  auth: { __mock: 'auth-instance' },
  googleProvider: { __mock: 'provider' },
  app: { __mock: 'app' },
}));

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));
vi.mock('../utils/api-client', () => ({
  post: postMock,
  setStoredTokens: vi.fn(),
  clearStoredTokens: vi.fn(),
  getStoredUser: vi.fn(),
  getStoredToken: vi.fn(),
}));

import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth, _deps as authDeps } from './AuthContext';
import {
  setStoredTokens,
  clearStoredTokens,
  getStoredUser,
  getStoredToken,
} from '../utils/api-client';

const realDeps = { ...authDeps };

beforeEach(() => {
  postMock.mockReset();
  setStoredTokens.mockReset();
  clearStoredTokens.mockReset();
  getStoredUser.mockReset();
  getStoredToken.mockReset();
  authDeps.signOut = vi.fn().mockResolvedValue();
});

afterAll(() => {
  Object.assign(authDeps, realDeps);
});

function wrapper({ children }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe('useAuth — guard pe Provider', () => {
  it('aruncă dacă e folosit în afara <AuthProvider>', () => {
    // Suprimăm noise-ul de error în consolă (React warning despre throw în render)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => renderHook(() => useAuth())).toThrow(
        /trebuie folosit în interiorul unui <AuthProvider>/
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('AuthProvider — restaurare sesiune la mount', () => {
  it('fără storage: loading se face false, user rămâne null', async () => {
    getStoredUser.mockReturnValue(null);
    getStoredToken.mockReturnValue(null);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('cu user și token în storage: hydratează state-ul din localStorage', async () => {
    const stored = {
      email: 'a@b.ro',
      role: 'tenant_admin',
      tenantSlug: 'dianex',
    };
    getStoredUser.mockReturnValue(stored);
    getStoredToken.mockReturnValue('jwt-1');

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toEqual(stored);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('cu user în storage dar fără token → NU hydratează (sesiune incompletă)', async () => {
    getStoredUser.mockReturnValue({ email: 'a@b.ro' });
    getStoredToken.mockReturnValue(null);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
  });
});

describe('login(idToken)', () => {
  it('apelează backend, persistă tokens și actualizează state', async () => {
    getStoredUser.mockReturnValue(null);
    getStoredToken.mockReturnValue(null);
    postMock.mockResolvedValue({
      data: {
        success: true,
        data: {
          jwt: 'access-1',
          refreshToken: 'refresh-1',
          expiresAt: 1234,
          user: { email: 'a@b.ro', role: 'tenant_admin', tenantSlug: 'dianex' },
        },
      },
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.login('firebase-id-token');
    });

    expect(postMock).toHaveBeenCalledWith('/api/v1/auth/firebase-login', {
      idToken: 'firebase-id-token',
    });
    expect(setStoredTokens).toHaveBeenCalledWith({
      jwt: 'access-1',
      refreshToken: 'refresh-1',
      user: { email: 'a@b.ro', role: 'tenant_admin', tenantSlug: 'dianex' },
    });
    expect(result.current.user.email).toBe('a@b.ro');
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('răspuns invalid (fără jwt) → aruncă, NU setează user', async () => {
    getStoredUser.mockReturnValue(null);
    getStoredToken.mockReturnValue(null);
    postMock.mockResolvedValue({ data: { success: true, data: {} } });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(async () => {
        await result.current.login('id');
      })
    ).rejects.toThrow(/Răspuns login invalid/);

    expect(setStoredTokens).not.toHaveBeenCalled();
    expect(result.current.user).toBeNull();
  });

  it('eroare de la backend (403 mfa) → propagă eroarea spre caller', async () => {
    getStoredUser.mockReturnValue(null);
    getStoredToken.mockReturnValue(null);
    const apiError = new Error('Request failed with status 403');
    apiError.response = {
      status: 403,
      data: { error: '2FA obligatoriu pe contul Google.', code: 'FORBIDDEN' },
    };
    postMock.mockRejectedValue(apiError);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(async () => {
        await result.current.login('id');
      })
    ).rejects.toThrow();

    expect(result.current.user).toBeNull();
  });
});

describe('logout()', () => {
  it('apelează backend, signOut Firebase, șterge storage și state', async () => {
    getStoredUser.mockReturnValue({
      email: 'a@b.ro',
      role: 'tenant_admin',
      tenantSlug: 'dianex',
    });
    getStoredToken.mockReturnValue('jwt-1');
    postMock.mockResolvedValue({ data: { success: true } });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await result.current.logout();
    });

    expect(postMock).toHaveBeenCalledWith('/api/v1/auth/logout');
    expect(authDeps.signOut).toHaveBeenCalled();
    expect(clearStoredTokens).toHaveBeenCalled();
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('eșec al backend-ului NU împiedică curățarea locală', async () => {
    getStoredUser.mockReturnValue({ email: 'a@b.ro' });
    getStoredToken.mockReturnValue('jwt-1');
    postMock.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await result.current.logout();
    });

    // Cleanup local s-a întâmplat oricum
    expect(clearStoredTokens).toHaveBeenCalled();
    expect(result.current.user).toBeNull();
  });

  it('eșec Firebase signOut NU împiedică curățarea locală', async () => {
    getStoredUser.mockReturnValue({ email: 'a@b.ro' });
    getStoredToken.mockReturnValue('jwt-1');
    postMock.mockResolvedValue({ data: {} });
    authDeps.signOut = vi.fn().mockRejectedValue(new Error('firebase-error'));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await result.current.logout();
    });

    expect(clearStoredTokens).toHaveBeenCalled();
    expect(result.current.user).toBeNull();
  });
});

describe('AuthProvider — DOM rendering', () => {
  it('randează children-ul transmis', () => {
    getStoredUser.mockReturnValue(null);
    getStoredToken.mockReturnValue(null);
    render(
      <AuthProvider>
        <p data-testid="child">salut</p>
      </AuthProvider>
    );
    expect(screen.getByTestId('child')).toHaveTextContent('salut');
  });
});
