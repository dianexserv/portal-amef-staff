// Teste pentru ProtectedRoute. Mock-uim AuthContext + folosim MemoryRouter
// ca să verificăm redirect-ul.

let mockedAuthState = { user: null, loading: false };
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockedAuthState,
}));

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './ProtectedRoute';

function Protected() {
  return <div data-testid="protected">conținut secret</div>;
}
function LoginStub() {
  return <div data-testid="login">login page</div>;
}

function renderWithRouter(initial = '/') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Protected />
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<LoginStub />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('ProtectedRoute', () => {
  it('loading=true → afișează spinner-ul (rol status), nu randează children', () => {
    mockedAuthState = { user: null, loading: true };
    renderWithRouter();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });

  it('!user și loading=false → redirect la /login', () => {
    mockedAuthState = { user: null, loading: false };
    renderWithRouter();
    expect(screen.getByTestId('login')).toBeInTheDocument();
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });

  it('user prezent → randează children-ul protejat', () => {
    mockedAuthState = { user: { email: 'a@b.ro' }, loading: false };
    renderWithRouter();
    expect(screen.getByTestId('protected')).toHaveTextContent(
      /conținut secret/
    );
  });
});
