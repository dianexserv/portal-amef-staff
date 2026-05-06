// Teste pentru ClientsListPage. Mock-uim useClients + useAuth + react-router-dom.

const { listClientsMock, deleteClientMock } = vi.hoisted(() => ({
  listClientsMock: vi.fn(),
  deleteClientMock: vi.fn(),
}));

vi.mock('../utils/clients-api', () => ({
  listClients: listClientsMock,
  deleteClient: deleteClientMock,
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

let mockAuthState = { user: { role: 'tenant_admin', email: 'a@b.ro' } };
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ClientsListPage from './ClientsListPage';

beforeEach(() => {
  listClientsMock.mockReset();
  deleteClientMock.mockReset();
  navigateMock.mockReset();
  mockAuthState = { user: { role: 'tenant_admin', email: 'a@b.ro' } };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <ClientsListPage />
    </MemoryRouter>
  );
}

describe('ClientsListPage', () => {
  it('randează titlul și butonul „Client nou"', async () => {
    listClientsMock.mockResolvedValue({ rows: [], total: 0, limit: 20, offset: 0 });
    renderPage();
    expect(screen.getByRole('heading', { name: /Clienți/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Client nou/i })).toBeInTheDocument();
  });

  it('afișează loading state inițial', () => {
    listClientsMock.mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent(/Se încarcă/i);
  });

  it('afișează empty state când 0 rezultate', async () => {
    listClientsMock.mockResolvedValue({ rows: [], total: 0, limit: 20, offset: 0 });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Nu există clienți încă/i)).toBeInTheDocument()
    );
  });

  it('afișează tabelul cu rânduri când există date', async () => {
    listClientsMock.mockResolvedValue({
      rows: [
        {
          id: 1,
          company_name: 'Acme SRL',
          fiscal_code: 'RO1234567',
          fiscal_code_type: 'CUI',
          county: 'Cluj',
          city: 'Cluj-Napoca',
          phone: '0721000000',
          email: 'acme@x.ro',
          anaf_verified: true,
          anaf_verified_at: new Date().toISOString(),
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Acme SRL')).toBeInTheDocument());
    expect(screen.getByText('RO1234567')).toBeInTheDocument();
    expect(screen.getByText('Cluj')).toBeInTheDocument();
  });

  it('search input declanșează refetch cu noul query', async () => {
    listClientsMock.mockResolvedValue({ rows: [], total: 0, limit: 20, offset: 0 });
    renderPage();

    await waitFor(() => expect(listClientsMock).toHaveBeenCalledTimes(1));

    const searchInput = screen.getByLabelText(/Caută clienți/i);
    fireEvent.change(searchInput, { target: { value: 'Acme' } });

    await waitFor(() => {
      const lastCall = listClientsMock.mock.calls[listClientsMock.mock.calls.length - 1];
      expect(lastCall[0].search).toBe('Acme');
    });
  });

  it('filtrele select (fiscalCodeType / anaf) declanșează refetch', async () => {
    listClientsMock.mockResolvedValue({ rows: [], total: 0, limit: 20, offset: 0 });
    renderPage();
    await waitFor(() => expect(listClientsMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/Filtrează după tip cod fiscal/i), {
      target: { value: 'CUI' },
    });
    await waitFor(() => {
      const last = listClientsMock.mock.calls[listClientsMock.mock.calls.length - 1];
      expect(last[0].fiscalCodeType).toBe('CUI');
    });

    fireEvent.change(screen.getByLabelText(/Filtrează după verificare ANAF/i), {
      target: { value: 'true' },
    });
    await waitFor(() => {
      const last = listClientsMock.mock.calls[listClientsMock.mock.calls.length - 1];
      expect(last[0].anafVerified).toBe(true);
    });
  });

  it('click pe rând navighează la detaliile clientului', async () => {
    listClientsMock.mockResolvedValue({
      rows: [{ id: 7, company_name: 'Clickable SRL', fiscal_code: 'RO7', county: 'X', city: 'Y' }],
      total: 1,
      limit: 20,
      offset: 0,
    });
    renderPage();
    await waitFor(() => screen.getByText('Clickable SRL'));
    fireEvent.click(screen.getByText('Clickable SRL'));
    expect(navigateMock).toHaveBeenCalledWith('/clients/7');
  });

  it('admin: butonul „Șterge" cu confirm true apelează deleteClient și refetch', async () => {
    listClientsMock.mockResolvedValue({
      rows: [{ id: 9, company_name: 'Doomed SRL', fiscal_code: 'RO9', county: 'X', city: 'Y' }],
      total: 1,
      limit: 20,
      offset: 0,
    });
    deleteClientMock.mockResolvedValue({ id: 9, deleted_at: '2026-05-06' });

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      renderPage();
      await waitFor(() => screen.getByText('Doomed SRL'));
      fireEvent.click(screen.getByRole('button', { name: /^Șterge$/i }));
      await waitFor(() => expect(deleteClientMock).toHaveBeenCalledWith(9));
      // refetch declanșat → listClients apelat încă o dată
      await waitFor(() => expect(listClientsMock).toHaveBeenCalledTimes(2));
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('tenant_user NU vede butonul „Șterge" pe rânduri', async () => {
    mockAuthState = { user: { role: 'tenant_user', email: 'u@b.ro' } };
    listClientsMock.mockResolvedValue({
      rows: [
        {
          id: 1,
          company_name: 'Acme SRL',
          fiscal_code: 'RO1234567',
          county: 'Cluj',
          city: 'Cluj',
          anaf_verified: false,
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Acme SRL')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /Șterge/i })).not.toBeInTheDocument();
    // Butonul „Editează" rămâne vizibil pentru ambele roluri
    expect(screen.getByRole('link', { name: /Editează/i })).toBeInTheDocument();
  });
});
