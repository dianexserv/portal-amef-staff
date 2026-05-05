// Teste pentru HomePage. Mock-uim AuthContext.

const { logoutMock } = vi.hoisted(() => ({ logoutMock: vi.fn() }));
let mockedAuthState = {
  user: { email: 'a@b.ro', role: 'tenant_admin', tenantSlug: 'dianex' },
  logout: logoutMock,
};
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockedAuthState,
}));

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import HomePage from './HomePage';

beforeEach(() => {
  logoutMock.mockReset();
  mockedAuthState = {
    user: { email: 'a@b.ro', role: 'tenant_admin', tenantSlug: 'dianex' },
    logout: logoutMock,
  };
});

describe('HomePage', () => {
  it('afișează email-ul, rolul și tenant_slug-ul', () => {
    render(<HomePage />);
    expect(screen.getByText(/Salut, a@b\.ro/)).toBeInTheDocument();
    expect(screen.getByText('dianex')).toBeInTheDocument();
    expect(screen.getByText('tenant_admin')).toBeInTheDocument();
  });

  it('butonul Logout apelează useAuth().logout', async () => {
    logoutMock.mockResolvedValue();
    render(<HomePage />);
    fireEvent.click(screen.getByRole('button', { name: /Logout/i }));
    await waitFor(() => expect(logoutMock).toHaveBeenCalledTimes(1));
  });

  it('în timpul logout-ului, butonul e disabled și textul se schimbă', async () => {
    let resolveLogout;
    logoutMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLogout = resolve;
        })
    );
    render(<HomePage />);
    fireEvent.click(screen.getByRole('button', { name: /Logout/i }));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Se deconectează/i })
      ).toBeDisabled()
    );

    resolveLogout();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Logout/i })).not.toBeDisabled()
    );
  });

  it('rolurile diferite sunt afișate fidel', () => {
    mockedAuthState = {
      user: { email: 'op@dianex.ro', role: 'platform_operator', tenantSlug: 'acme' },
      logout: logoutMock,
    };
    render(<HomePage />);
    expect(screen.getByText('acme')).toBeInTheDocument();
    expect(screen.getByText('platform_operator')).toBeInTheDocument();
  });
});
