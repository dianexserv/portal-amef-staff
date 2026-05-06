// Pagina-listă pentru clienți: tabel paginat + filtre + buton „Client nou".
//
// Filtre:
//   - search: text liber pe denumire (server-side ILIKE prin GIN trigram)
//   - fiscalCodeType: select CUI/CNP/(toate)
//   - anafVerified: select da/nu/(toate)
//
// Comportament:
//   - Search-ul nu e debounced — utilizatorul tastează încet, useClients
//     abort-ează request-urile în zbor pe schimbare. Dacă devine deranjant
//     pe DB-uri mari, adăugăm debounce la 300ms.
//   - Click pe rând → navigează la detaliile clientului.
//   - Buton „Șterge" e vizibil doar pentru `tenant_admin` (decizia 4b — soft
//     delete restorabil dintr-un endpoint admin viitor; tenant_user-ul nu are
//     dreptul nici măcar să încerce).

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useClients } from '../hooks/useClients';
import { deleteClient } from '../utils/clients-api';
import { getBackendErrorMessage } from '../utils/clients-validation';
import AnafLookupBadge from '../components/AnafLookupBadge';

const PAGE_SIZE = 20;

export default function ClientsListPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user && user.role === 'tenant_admin';

  const [search, setSearch] = useState('');
  const [fiscalCodeType, setFiscalCodeType] = useState('');
  const [anafFilter, setAnafFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [deleteError, setDeleteError] = useState(null);

  const filters = {
    limit: PAGE_SIZE,
    offset,
    search: search.trim() || undefined,
    fiscalCodeType: fiscalCodeType || undefined,
    anafVerified:
      anafFilter === '' ? undefined : anafFilter === 'true',
  };

  const { data, loading, error, refetch } = useClients(filters);

  function handleSearchChange(e) {
    setSearch(e.target.value);
    setOffset(0);
  }

  function handleFiscalChange(e) {
    setFiscalCodeType(e.target.value);
    setOffset(0);
  }

  function handleAnafChange(e) {
    setAnafFilter(e.target.value);
    setOffset(0);
  }

  async function handleDelete(client) {
    setDeleteError(null);
    const ok = window.confirm(
      `Confirmi soft-delete pentru ${client.company_name}? Va putea fi restaurat ulterior din admin.`
    );
    if (!ok) return;
    try {
      await deleteClient(client.id);
      refetch();
    } catch (err) {
      setDeleteError(getBackendErrorMessage(err));
    }
  }

  const rows = data ? data.rows : [];
  const total = data ? data.total : 0;
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <main className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-slate-800">Clienți</h1>
          <Link
            to="/clients/new"
            className="rounded-md bg-slate-800 px-4 py-2 text-white font-medium hover:bg-slate-900"
          >
            Client nou
          </Link>
        </header>

        <div className="mb-4 flex flex-wrap gap-3 rounded-lg bg-white p-4 shadow-sm">
          <input
            type="text"
            placeholder="Caută după denumire..."
            value={search}
            onChange={handleSearchChange}
            aria-label="Caută clienți"
            className="flex-1 min-w-[200px] rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <select
            value={fiscalCodeType}
            onChange={handleFiscalChange}
            aria-label="Filtrează după tip cod fiscal"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">Toate tipurile</option>
            <option value="CUI">CUI</option>
            <option value="CNP">CNP</option>
          </select>
          <select
            value={anafFilter}
            onChange={handleAnafChange}
            aria-label="Filtrează după verificare ANAF"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">Toți (ANAF)</option>
            <option value="true">Verificat ANAF</option>
            <option value="false">Neverificat</option>
          </select>
        </div>

        {deleteError && (
          <div role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {deleteError}
          </div>
        )}

        {loading && (
          <div role="status" className="rounded-lg bg-white p-8 text-center text-slate-500">
            Se încarcă...
          </div>
        )}

        {error && !loading && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <p className="font-medium">Eroare la încărcare:</p>
            <p>{getBackendErrorMessage(error)}</p>
            <button
              type="button"
              onClick={refetch}
              className="mt-2 rounded-md bg-red-600 px-3 py-1 text-white"
            >
              Reîncearcă
            </button>
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div className="rounded-lg bg-white p-8 text-center text-slate-500">
            Nu există clienți încă. Apasă „Client nou" ca să adaugi primul.
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="overflow-hidden rounded-lg bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Denumire</th>
                  <th className="px-4 py-3">CUI/CNP</th>
                  <th className="px-4 py-3">Județ</th>
                  <th className="px-4 py-3">Oraș</th>
                  <th className="px-4 py-3">Telefon</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Status ANAF</th>
                  <th className="px-4 py-3 text-right">Acțiuni</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((client) => (
                  <tr
                    key={client.id}
                    onClick={() => navigate(`/clients/${client.id}`)}
                    className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-4 py-3 font-medium text-slate-800">
                      {client.company_name}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{client.fiscal_code}</td>
                    <td className="px-4 py-3 text-slate-600">{client.county}</td>
                    <td className="px-4 py-3 text-slate-600">{client.city}</td>
                    <td className="px-4 py-3 text-slate-600">{client.phone || '—'}</td>
                    <td className="px-4 py-3 text-slate-600">{client.email || '—'}</td>
                    <td className="px-4 py-3">
                      <AnafLookupBadge client={client} />
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-2">
                        <Link
                          to={`/clients/${client.id}/edit`}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                        >
                          Editează
                        </Link>
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => handleDelete(client)}
                            className="rounded-md border border-red-300 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                          >
                            Șterge
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
              <span>
                {total === 0
                  ? '0 rezultate'
                  : `${offset + 1}-${Math.min(offset + PAGE_SIZE, total)} din ${total}`}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  disabled={!hasPrev}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1 disabled:opacity-50"
                >
                  Anterior
                </button>
                <button
                  type="button"
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  disabled={!hasNext}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1 disabled:opacity-50"
                >
                  Următor
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
