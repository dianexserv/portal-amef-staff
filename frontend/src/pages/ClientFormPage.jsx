// Wrapper pentru ClientForm: gestionează create vs edit, fetch-ul clientului
// existent (în edit mode) și submit-ul către API.
//
// Modul:
//   - mode='create' → form gol, submit POST → navigate la /clients/:newId
//   - mode='edit'   → fetch GET /clients/:id, hidratează form, submit PUT
//
// Mesajele de eroare backend sunt mapate prin getBackendErrorMessage. Pentru
// 409 (FISCAL_CODE_DUPLICATE / EMAIL_DUPLICATE) afișăm un banner top-of-form
// (formError) — eroarea NU e per-câmp pentru că DB-ul nu ne spune cu siguranță
// care câmp a creat conflictul (poate fi fiscal_code, poate email).

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useClient } from '../hooks/useClient';
import { createClient, updateClient } from '../utils/clients-api';
import { getBackendErrorMessage } from '../utils/clients-validation';
import ClientForm from '../components/ClientForm';

export default function ClientFormPage({ mode = 'create' }) {
  const navigate = useNavigate();
  const { id: idParam } = useParams();
  const id = mode === 'edit' && idParam ? Number(idParam) : null;

  const { client, loading, error: fetchError } = useClient(id);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  async function handleSubmit(data) {
    setSubmitting(true);
    setFormError(null);
    try {
      if (mode === 'create') {
        const created = await createClient(data);
        navigate(`/clients/${created.id}`, { replace: true });
      } else {
        await updateClient(id, data);
        navigate(`/clients/${id}`, { replace: true });
      }
    } catch (err) {
      setFormError(getBackendErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-slate-800">
            {mode === 'create' ? 'Client nou' : 'Editare client'}
          </h1>
          <button
            type="button"
            onClick={() => navigate('/clients')}
            className="text-sm text-slate-600 hover:text-slate-800"
          >
            ← Înapoi la listă
          </button>
        </header>

        {mode === 'edit' && loading && (
          <div role="status" className="rounded-lg bg-white p-8 text-center text-slate-500">
            Se încarcă clientul...
          </div>
        )}

        {mode === 'edit' && fetchError && !loading && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <p className="font-medium">Nu am putut încărca clientul:</p>
            <p>{getBackendErrorMessage(fetchError)}</p>
          </div>
        )}

        {(mode === 'create' || (!loading && client)) && (
          <div className="rounded-lg bg-white p-6 shadow-sm">
            <ClientForm
              mode={mode}
              initialValues={mode === 'edit' ? client : null}
              onSubmit={handleSubmit}
              submitting={submitting}
              formError={formError}
            />
          </div>
        )}
      </div>
    </main>
  );
}
