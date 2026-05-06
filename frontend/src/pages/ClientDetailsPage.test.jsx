// Teste pentru ClientDetailsPage. Mock-uim getClientById și params-ul.

const { getClientByIdMock } = vi.hoisted(() => ({
  getClientByIdMock: vi.fn(),
}));

vi.mock('../utils/clients-api', () => ({
  getClientById: getClientByIdMock,
}));

let mockParams = { id: '5' };
const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => mockParams,
    useNavigate: () => navigateMock,
  };
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ClientDetailsPage from './ClientDetailsPage';

beforeEach(() => {
  getClientByIdMock.mockReset();
  navigateMock.mockReset();
  mockParams = { id: '5' };
});

const fixture = {
  id: 5,
  fiscal_code_type: 'CUI',
  fiscal_code: 'RO1234567',
  company_name: 'Acme SRL',
  county: 'Cluj',
  city: 'Cluj-Napoca',
  street: 'Memorandumului',
  street_number: '10',
  phone: '0721000000',
  email: 'acme@x.ro',
  representative_name: 'Ion Popescu',
  representative_role_id: 1,
  representative_ci_number: '123456',
  representative_county: 'Cluj',
  representative_city: 'Cluj-Napoca',
  is_vat_payer: true,
  anaf_verified: true,
  anaf_verified_at: new Date().toISOString(),
  iban: 'RO49AAAA1B31007593840000',
  bank_name: 'BCR',
};

describe('ClientDetailsPage', () => {
  it('afișează spinner pe loading', () => {
    getClientByIdMock.mockImplementation(() => new Promise(() => {}));
    render(
      <MemoryRouter>
        <ClientDetailsPage />
      </MemoryRouter>
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Se încarcă/i);
  });

  it('afișează datele clientului în tab-ul General', async () => {
    getClientByIdMock.mockResolvedValue(fixture);
    render(
      <MemoryRouter>
        <ClientDetailsPage />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Acme SRL/i })).toBeInTheDocument()
    );
    // RO1234567 apare în 2 locuri (header + secțiunea Identificare).
    expect(screen.getAllByText('RO1234567').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Memorandumului')).toBeInTheDocument();
    expect(screen.getByText('Ion Popescu')).toBeInTheDocument();
    // Rolul mappat la nume
    expect(screen.getByText('Administrator')).toBeInTheDocument();
  });

  it('schimbă tab-ul la „Parc case" cu placeholder Stage 8', async () => {
    getClientByIdMock.mockResolvedValue(fixture);
    render(
      <MemoryRouter>
        <ClientDetailsPage />
      </MemoryRouter>
    );
    await waitFor(() => screen.getByRole('heading', { name: /Acme SRL/i }));
    fireEvent.click(screen.getByRole('button', { name: /Parc case/i }));
    expect(screen.getByText(/Stage 8/i)).toBeInTheDocument();
  });

  it('schimbă tab-ul la „Documente" cu placeholder Stage 11', async () => {
    getClientByIdMock.mockResolvedValue(fixture);
    render(
      <MemoryRouter>
        <ClientDetailsPage />
      </MemoryRouter>
    );
    await waitFor(() => screen.getByRole('heading', { name: /Acme SRL/i }));
    fireEvent.click(screen.getByRole('button', { name: /Documente/i }));
    expect(screen.getByText(/Stage 11/i)).toBeInTheDocument();
  });

  it('eroarea de fetch afișează alert + buton „Înapoi la listă"', async () => {
    const apiErr = new Error('not found');
    apiErr.response = {
      status: 404,
      data: { code: 'CLIENT_NOT_FOUND', error: 'Clientul nu există' },
    };
    getClientByIdMock.mockRejectedValue(apiErr);

    render(
      <MemoryRouter>
        <ClientDetailsPage />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toBeInTheDocument()
    );
    expect(screen.getByText(/Nu am putut încărca clientul/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Înapoi la listă/i }));
    expect(navigateMock).toHaveBeenCalledWith('/clients');
  });
});
