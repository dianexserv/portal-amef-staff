// Smoke test pentru App — verifică doar că routing-ul e wire-uit corect.
// Nu mock-uim AuthContext; folosim provider-ul real cu localStorage gol,
// ceea ce înseamnă că ProtectedRoute va redirecționa la /login.

vi.mock('./firebase', () => ({
  auth: { __mock: 'auth' },
  googleProvider: { __mock: 'provider' },
  app: { __mock: 'app' },
}));

vi.mock('./utils/api-client', () => ({
  post: vi.fn(),
  setStoredTokens: vi.fn(),
  clearStoredTokens: vi.fn(),
  getStoredUser: vi.fn(() => null),
  getStoredToken: vi.fn(() => null),
}));

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe('App routing', () => {
  it('user neautenticat pe / → redirect la /login', async () => {
    renderAt('/');
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /Portal AMEF — Login/i })
      ).toBeInTheDocument()
    );
  });

  it('/login direct → randează LoginPage', async () => {
    renderAt('/login');
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /Portal AMEF — Login/i })
      ).toBeInTheDocument()
    );
  });

  it('rută necunoscută → redirect la /, care apoi merge la /login', async () => {
    renderAt('/some/unknown/path');
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /Portal AMEF — Login/i })
      ).toBeInTheDocument()
    );
  });
});
