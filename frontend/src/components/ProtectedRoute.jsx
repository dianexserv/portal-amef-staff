// Wrapper de rută care impune autentificare.
//
// Stări:
//   - loading: afișăm un spinner (AuthProvider e încă în mount → restaurare
//     din localStorage). NU redirecționăm imediat ca să nu trimitem
//     utilizatorul autentificat la /login pe primul render.
//   - !user: redirect la /login. `replace` ca să nu intre în history (back
//     din browser nu trebuie să întoarcă utilizatorul la pagina protejată
//     de care tocmai a fost respins).
//   - user prezent: randăm children-ul.

import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="min-h-screen flex items-center justify-center bg-slate-100"
      >
        <div className="text-slate-500 text-sm">Se încarcă sesiunea...</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return children;
}
