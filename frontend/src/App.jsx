// Componenta root. Wire-uim:
//   - AuthProvider la cel mai exterior nivel ca toate paginile să poată
//     citi din useAuth().
//   - react-router-dom cu rute pentru auth + modul Clienți (Stage 5e):
//       /login              → LoginPage (public)
//       /                   → HomePage (protected)
//       /clients            → ClientsListPage (protected)
//       /clients/new        → ClientFormPage create (protected)
//       /clients/:id        → ClientDetailsPage (protected)
//       /clients/:id/edit   → ClientFormPage edit (protected)
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
import ClientsListPage from './pages/ClientsListPage';
import ClientFormPage from './pages/ClientFormPage';
import ClientDetailsPage from './pages/ClientDetailsPage';

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
        <Route
          path="/clients"
          element={
            <ProtectedRoute>
              <ClientsListPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/clients/new"
          element={
            <ProtectedRoute>
              <ClientFormPage mode="create" />
            </ProtectedRoute>
          }
        />
        <Route
          path="/clients/:id"
          element={
            <ProtectedRoute>
              <ClientDetailsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/clients/:id/edit"
          element={
            <ProtectedRoute>
              <ClientFormPage mode="edit" />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
