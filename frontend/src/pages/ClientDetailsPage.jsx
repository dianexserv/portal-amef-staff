// Pagina de detalii client (read-only) cu tab-uri.
//
// Tab-uri:
//   - General (default): toate câmpurile organizate în 5 secțiuni (oglindă cu
//     ClientForm)
//   - Parc case (placeholder Stage 8)
//   - Documente (placeholder Stage 11)
//
// Acțiuni: „Editează" → /clients/:id/edit, „Înapoi la listă" → /clients.

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useClient } from '../hooks/useClient';
import { getBackendErrorMessage } from '../utils/clients-validation';
import { getRepresentativeRoleName } from '../utils/representative-roles';
import AnafLookupBadge from '../components/AnafLookupBadge';

function Field({ label, value }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="text-sm text-slate-800">{value || '—'}</dd>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="rounded-lg border border-slate-200 p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-700">{title}</h2>
      <dl className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</dl>
    </section>
  );
}

export default function ClientDetailsPage() {
  const { id: idParam } = useParams();
  const id = idParam ? Number(idParam) : null;
  const navigate = useNavigate();
  const { client, loading, error } = useClient(id);
  const [tab, setTab] = useState('general');

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-100 p-6">
        <div className="mx-auto max-w-5xl rounded-lg bg-white p-8 text-center text-slate-500" role="status">
          Se încarcă clientul...
        </div>
      </main>
    );
  }

  if (error || !client) {
    return (
      <main className="min-h-screen bg-slate-100 p-6">
        <div className="mx-auto max-w-5xl rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
          <p className="font-medium">Nu am putut încărca clientul:</p>
          <p>{error ? getBackendErrorMessage(error) : 'Necunoscut'}</p>
          <button
            type="button"
            onClick={() => navigate('/clients')}
            className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1"
          >
            Înapoi la listă
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-800">{client.company_name}</h1>
            <div className="mt-2 flex items-center gap-3 text-sm text-slate-600">
              <span>{client.fiscal_code}</span>
              <AnafLookupBadge client={client} />
            </div>
          </div>
          <div className="flex gap-2">
            <Link
              to="/clients"
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              Înapoi la listă
            </Link>
            <Link
              to={`/clients/${client.id}/edit`}
              className="rounded-md bg-slate-800 px-3 py-2 text-sm text-white font-medium hover:bg-slate-900"
            >
              Editează
            </Link>
          </div>
        </header>

        <nav className="flex gap-2 border-b border-slate-200">
          {[
            { key: 'general', label: 'General' },
            { key: 'parc', label: 'Parc case' },
            { key: 'docs', label: 'Documente' },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium ${tab === t.key ? 'border-b-2 border-slate-800 text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {tab === 'general' && (
          <div className="space-y-4">
            <Section title="Identificare fiscală">
              <Field label="Tip cod fiscal" value={client.fiscal_code_type} />
              <Field label="Cod fiscal" value={client.fiscal_code} />
            </Section>
            <Section title="Date companie">
              <Field label="Denumire" value={client.company_name} />
              <Field label="Județ" value={client.county} />
              <Field label="Oraș" value={client.city} />
              <Field label="Stradă" value={client.street} />
              <Field label="Număr" value={client.street_number} />
              <Field label="Cod poștal" value={client.postal_code} />
              <Field label="Adresă suplimentară" value={client.address_extra} />
              <Field label="Plătitor TVA" value={client.is_vat_payer ? 'Da' : 'Nu'} />
            </Section>
            <Section title="Contact">
              <Field label="Telefon" value={client.phone} />
              <Field label="Email" value={client.email} />
              <Field label="Note" value={client.notes} />
            </Section>
            <Section title="Reprezentant legal">
              <Field label="Nume" value={client.representative_name} />
              <Field
                label="Rol"
                value={getRepresentativeRoleName(client.representative_role_id)}
              />
              <Field label="Serie CI" value={client.representative_ci_series} />
              <Field label="Număr CI" value={client.representative_ci_number} />
              <Field label="Eliberat de" value={client.representative_ci_issued_by} />
              <Field
                label="Data eliberării"
                value={
                  client.representative_ci_issued_at
                    ? String(client.representative_ci_issued_at).slice(0, 10)
                    : null
                }
              />
              <Field label="Județ" value={client.representative_county} />
              <Field label="Oraș" value={client.representative_city} />
              <Field label="Stradă" value={client.representative_street} />
              <Field label="Număr" value={client.representative_street_number} />
            </Section>
            <Section title="Banking">
              <Field label="IBAN" value={client.iban} />
              <Field label="Bancă" value={client.bank_name} />
            </Section>
          </div>
        )}

        {tab === 'parc' && (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
            Parcul de case de marcat va fi disponibil în Stage 8.
          </div>
        )}

        {tab === 'docs' && (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
            Documentele clientului vor fi disponibile în Stage 11.
          </div>
        )}
      </div>
    </main>
  );
}
