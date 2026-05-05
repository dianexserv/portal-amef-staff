// Componenta root. Wire-uim:
//   - AuthProvider la cel mai exterior nivel ca toate paginile să poată
//     citi din useAuth().
//   - react-router-dom cu două rute pentru moment:
//       /login → LoginPage (public)
//       /      → HomePage (protected)
//   - Catch-all (`*`) redirect către `/` ca link-urile nepotrivite să cadă
//     pe ProtectedRoute, care decide dacă merge la /login sau home.
//
// BrowserRouter trăiește în main.jsx ca să putem folosi <MemoryRouter> în
// teste fără conflict cu router-ul real.

import { Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/HomePage';

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <HomePage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
