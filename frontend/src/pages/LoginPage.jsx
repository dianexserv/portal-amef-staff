// Pagina de login. Singura acțiune: butonul „Continuă cu Google".
//
// Fluxul:
//   1. Click → signInWithPopup (Firebase) → user alege contul Google.
//   2. Firebase verifică 2FA (dacă e activ pe contul Google) și returnează
//      `userCredential` cu un `idToken` semnat.
//   3. Trimitem idToken la backend prin AuthContext.login() — backend-ul
//      validează, verifică prezența 2FA, caută user-ul în tenant_users și
//      emite JWT propriu.
//   4. La succes, navigăm la `/` (HomePage).
//
// Erorile cele mai frecvente afișate:
//   - 403 cu „2FA obligatoriu" (din backend)
//   - 403 cu „Contactează un admin" (user-ul nu e în tenant_users)
//   - „popup-closed-by-user" (Firebase) — utilizatorul a închis popup-ul

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithPopup } from 'firebase/auth';

import { auth, googleProvider } from '../firebase';
import { useAuth } from '../contexts/AuthContext';

// Test seam — testele suprascriu signInWithPopup ca să nu deschidă popup real.
export const _deps = {
  signInWithPopup,
};

function extractErrorMessage(err) {
  // Erorile axios au răspunsul în err.response.data.error (vezi backend
  // error-handler). Erorile Firebase au err.code (`auth/popup-closed-by-user`)
  // și err.message.
  if (err && err.response && err.response.data && err.response.data.error) {
    return err.response.data.error;
  }
  if (err && err.code === 'auth/popup-closed-by-user') {
    return 'Ai închis fereastra Google. Apasă din nou butonul ca să încerci.';
  }
  if (err && err.code === 'auth/popup-blocked') {
    return 'Browser-ul a blocat popup-ul. Permite popup-uri pentru această pagină și încearcă din nou.';
  }
  return (err && err.message) || 'A apărut o eroare la login.';
}

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState(null);

  // Dacă user-ul e deja autentificat (ex: a accesat /login direct dintr-un
  // bookmark), redirecționăm imediat la / fără să mai afișăm formularul.
  useEffect(() => {
    if (!loading && user) {
      navigate('/', { replace: true });
    }
  }, [loading, user, navigate]);

  async function handleGoogleSignIn() {
    setError(null);
    setSigningIn(true);
    try {
      const result = await _deps.signInWithPopup(auth, googleProvider);
      const idToken = await result.user.getIdToken();
      await login(idToken);
      navigate('/', { replace: true });
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-100">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-8">
        <h1 className="text-3xl font-bold text-slate-800 text-center">
          Portal AMEF — Login
        </h1>
        <p className="mt-2 text-slate-600 text-center">
          Continuă cu contul tău Google
        </p>

        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={signingIn}
          className="mt-8 w-full flex items-center justify-center gap-3 rounded-lg border border-slate-300 bg-white px-4 py-3 text-slate-700 font-medium shadow-sm hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {/* Logo Google ca SVG inline — evită un asset HTTP suplimentar. */}
          <svg
            aria-hidden="true"
            className="w-5 h-5"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
            />
          </svg>
          {signingIn ? 'Se conectează...' : 'Continuă cu Google'}
        </button>

        {error && (
          <p
            role="alert"
            className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-3"
          >
            {error}
          </p>
        )}

        <p className="mt-6 text-xs text-slate-400 text-center">
          Folosește contul Google al companiei. 2FA e obligatoriu.
        </p>
      </div>
    </main>
  );
}
