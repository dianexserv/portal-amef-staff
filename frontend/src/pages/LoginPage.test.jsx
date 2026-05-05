// Teste pentru LoginPage. Mock-uim Firebase + AuthContext + react-router.

vi.mock('../firebase', () => ({
  auth: { __mock: 'auth' },
  googleProvider: { __mock: 'provider' },
  app: { __mock: 'app' },
}));

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const { loginMock } = vi.hoisted(() => ({ loginMock: vi.fn() }));
let mockedAuthState = { user: null, loading: false, login: loginMock };
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockedAuthState,
}));

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LoginPage, { _deps as loginDeps } from './LoginPage';

const realDeps = { ...loginDeps };

function renderPage() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  navigateMock.mockReset();
  loginMock.mockReset();
  loginDeps.signInWithPopup = vi.fn();
  mockedAuthState = { user: null, loading: false, login: loginMock };
});

afterAll(() => {
  Object.assign(loginDeps, realDeps);
});

describe('LoginPage — randare', () => {
  it('afișează titlul și butonul Google', () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Portal AMEF — Login/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Continuă cu Google/i })
    ).toBeInTheDocument();
  });

  it('afișează subtitlul cu instrucțiunea', () => {
    renderPage();
    expect(screen.getByText(/contul tău Google/i)).toBeInTheDocument();
  });
});

describe('LoginPage — flow login', () => {
  it('click pe buton apelează signInWithPopup și apoi useAuth().login(idToken)', async () => {
    loginDeps.signInWithPopup.mockResolvedValue({
      user: { getIdToken: vi.fn().mockResolvedValue('firebase-id-token') },
    });
    loginMock.mockResolvedValue({ email: 'a@b.ro' });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Continuă cu Google/i }));

    await waitFor(() => {
      expect(loginMock).toHaveBeenCalledWith('firebase-id-token');
    });
    expect(loginDeps.signInWithPopup).toHaveBeenCalledTimes(1);
  });

  it('login reușit redirecționează la /', async () => {
    loginDeps.signInWithPopup.mockResolvedValue({
      user: { getIdToken: vi.fn().mockResolvedValue('firebase-id-token') },
    });
    loginMock.mockResolvedValue({ email: 'a@b.ro' });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Continuă cu Google/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  it('eroare 403 de la backend → afișează mesajul în clar (rol)', async () => {
    loginDeps.signInWithPopup.mockResolvedValue({
      user: { getIdToken: vi.fn().mockResolvedValue('id') },
    });
    const apiError = new Error('Request failed');
    apiError.response = {
      status: 403,
      data: {
        error: '2FA obligatoriu pe contul Google. Activează-l și reîncearcă.',
        code: 'FORBIDDEN',
      },
    };
    loginMock.mockRejectedValue(apiError);

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Continuă cu Google/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/2FA obligatoriu/);
    // NU am navigat la /
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('popup închis de user → mesaj de eroare specific', async () => {
    const fbErr = Object.assign(new Error('popup closed'), {
      code: 'auth/popup-closed-by-user',
    });
    loginDeps.signInWithPopup.mockRejectedValue(fbErr);

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Continuă cu Google/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/închis fereastra Google/i);
  });

  it('popup blocked → mesaj despre permisiuni browser', async () => {
    const fbErr = Object.assign(new Error('blocked'), {
      code: 'auth/popup-blocked',
    });
    loginDeps.signInWithPopup.mockRejectedValue(fbErr);

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Continuă cu Google/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/blocat popup/i);
  });

  it('în timpul sign-in-ului, butonul e disabled și textul se schimbă', async () => {
    let resolvePopup;
    loginDeps.signInWithPopup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePopup = resolve;
        })
    );

    renderPage();
    const btn = screen.getByRole('button', { name: /Continuă cu Google/i });
    fireEvent.click(btn);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Se conectează/i })
      ).toBeDisabled()
    );

    // Eliberăm promise-ul ca testul să nu rămână în-flight
    resolvePopup({
      user: { getIdToken: vi.fn().mockResolvedValue('id') },
    });
    loginMock.mockResolvedValue({});
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Continuă cu Google/i })
      ).not.toBeDisabled()
    );
  });
});

describe('LoginPage — redirect dacă deja autentificat', () => {
  it('user prezent + loading=false → navigate(/)', async () => {
    mockedAuthState = {
      user: { email: 'a@b.ro' },
      loading: false,
      login: loginMock,
    };
    renderPage();
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/', { replace: true })
    );
  });

  it('loading=true → NU redirecționăm (așteptăm hydratarea)', () => {
    mockedAuthState = { user: null, loading: true, login: loginMock };
    renderPage();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
