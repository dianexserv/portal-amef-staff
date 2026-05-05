// Placeholder pentru pagina home autenticată. În stage-urile următoare aici
// va veni dashboard-ul real (sumar facturi, alerte ANAF, etc.); momentan
// doar confirmă că flow-ul de auth funcționează și permite logout.

import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export default function HomePage() {
  const { user, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      // Indiferent de rezultat, AuthContext.logout() se ocupă de cleanup;
      // butonul iese din state-ul „loggingOut".
      setLoggingOut(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-100">
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-lg p-8">
        <h1 className="text-3xl font-bold text-slate-800">
          Salut, {user.email}!
        </h1>
        <dl className="mt-6 grid grid-cols-1 gap-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Tenant
            </dt>
            <dd className="text-lg text-slate-800">{user.tenantSlug}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Rol
            </dt>
            <dd className="text-lg text-slate-800">{user.role}</dd>
          </div>
        </dl>

        <button
          type="button"
          onClick={handleLogout}
          disabled={loggingOut}
          className="mt-8 rounded-lg bg-slate-800 px-4 py-2 text-white font-medium hover:bg-slate-900 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {loggingOut ? 'Se deconectează...' : 'Logout'}
        </button>

        <p className="mt-6 text-xs text-slate-400">
          Stage 4: autentificare funcțională. Modulul real (clienți, facturi)
          vine începând cu Stage 5.
        </p>
      </div>
    </main>
  );
}
