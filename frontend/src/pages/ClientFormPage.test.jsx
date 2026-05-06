// Teste pentru ClientFormPage. Mock-uim hook-ul useClient + funcțiile API
// + react-router-dom pentru param-uri și navigate.

const { createClientMock, updateClientMock, getClientByIdMock, lookupCuiMock } =
  vi.hoisted(() => ({
    createClientMock: vi.fn(),
    updateClientMock: vi.fn(),
    getClientByIdMock: vi.fn(),
    lookupCuiMock: vi.fn(),
  }));

vi.mock('../utils/clients-api', () => ({
  createClient: createClientMock,
  updateClient: updateClientMock,
  getClientById: getClientByIdMock,
  lookupCui: lookupCuiMock,
}));

let mockParams = {};
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
import ClientFormPage from './ClientFormPage';

beforeEach(() => {
  createClientMock.mockReset();
  updateClientMock.mockReset();
  getClientByIdMock.mockReset();
  lookupCuiMock.mockReset();
  navigateMock.mockReset();
  mockParams = {};
});

function fillValidCreateForm() {
  // Câmpurile required au „ *" la final în label.
  const setValue = (label, value) => {
    fireEvent.change(screen.getByLabelText(new RegExp(label, 'i')), {
      target: { value },
    });
  };
  setValue('^Cod fiscal \\*$', 'RO1234567');
  setValue('^Denumire \\*$', 'Acme SRL');
  setValue('^Județ \\*$', 'Cluj');
  setValue('^Oraș \\*$', 'Cluj-Napoca');
  setValue('^Stradă \\*$', 'Memorandumului');
  setValue('^Număr \\*$', '10');
  setValue('^Telefon$', '0721000000');
  setValue('^Nume reprezentant \\*$', 'Ion Popescu');
  fireEvent.change(screen.getByLabelText(/^Rol \*$/i), { target: { value: '1' } });
  setValue('^Număr CI \\*$', '123456');
  setValue('^Eliberat de \\*$', 'SPCLEP Cluj');
  setValue('^Data eliberării CI \\*$', '2020-01-15');
  setValue('^Județ reprezentant \\*$', 'Cluj');
  setValue('^Oraș reprezentant \\*$', 'Cluj-Napoca');
  setValue('^Stradă reprezentant \\*$', 'Memorandumului');
  setValue('^Număr reprezentant \\*$', '10');
}

describe('ClientFormPage — create mode', () => {
  it('randează formularul gol cu titlul „Client nou"', () => {
    render(
      <MemoryRouter>
        <ClientFormPage mode="create" />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: /Client nou/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Cod fiscal \*$/i)).toHaveValue('');
    expect(screen.getByLabelText(/^Denumire \*$/i)).toHaveValue('');
  });

  it('submit cu date valide apelează createClient și navighează', async () => {
    createClientMock.mockResolvedValue({ id: 42 });
    render(
      <MemoryRouter>
        <ClientFormPage mode="create" />
      </MemoryRouter>
    );

    fillValidCreateForm();
    fireEvent.click(screen.getByRole('button', { name: /^Salvează/i }));

    await waitFor(() => expect(createClientMock).toHaveBeenCalled());
    const submitted = createClientMock.mock.calls[0][0];
    expect(submitted.fiscal_code).toBe('RO1234567');
    expect(submitted.company_name).toBe('Acme SRL');
    expect(navigateMock).toHaveBeenCalledWith('/clients/42', { replace: true });
  });

  it('Zod-eroare: submit cu CUI invalid afișează mesaj inline', async () => {
    render(
      <MemoryRouter>
        <ClientFormPage mode="create" />
      </MemoryRouter>
    );
    // Completăm un CUI invalid (litere) și restul minim
    fillValidCreateForm();
    fireEvent.change(screen.getByLabelText(/^Cod fiscal \*$/i), {
      target: { value: 'INVALID' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Salvează/i }));

    await waitFor(() =>
      expect(screen.getByText(/CUI invalid/i)).toBeInTheDocument()
    );
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('eroarea 409 (FISCAL_CODE_DUPLICATE) afișată ca formError', async () => {
    const apiErr = new Error('conflict');
    apiErr.response = {
      status: 409,
      data: { success: false, error: 'Există', code: 'FISCAL_CODE_DUPLICATE' },
    };
    createClientMock.mockRejectedValue(apiErr);

    render(
      <MemoryRouter>
        <ClientFormPage mode="create" />
      </MemoryRouter>
    );
    fillValidCreateForm();
    fireEvent.click(screen.getByRole('button', { name: /^Salvează/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/Există deja un client cu acest CUI\/CNP/i)
      ).toBeInTheDocument()
    );
    expect(navigateMock).not.toHaveBeenCalled();
  });
});

describe('ClientFormPage — edit mode', () => {
  it('fetchează clientul și pre-completează form-ul', async () => {
    mockParams = { id: '7' };
    getClientByIdMock.mockResolvedValue({
      id: 7,
      fiscal_code_type: 'CUI',
      fiscal_code: 'RO9999999',
      company_name: 'Existing SRL',
      county: 'Cluj',
      city: 'Cluj',
      street: 'X',
      street_number: '1',
      phone: '0700111222',
      representative_name: 'Test',
      representative_role_id: 1,
      representative_ci_number: '111',
      representative_ci_issued_by: 'SPCLEP',
      representative_ci_issued_at: '2020-01-01',
      representative_county: 'Cluj',
      representative_city: 'Cluj',
      representative_street: 'X',
      representative_street_number: '1',
    });

    render(
      <MemoryRouter>
        <ClientFormPage mode="edit" />
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/^Denumire \*$/i)).toHaveValue('Existing SRL')
    );
    // În edit, label-ul „Cod fiscal" încă are asterisk (component required-ul îl arată).
    expect(screen.getByLabelText(/^Cod fiscal \*$/i)).toHaveValue('RO9999999');
    // Câmpul fiscal_code e read-only în edit
    expect(screen.getByLabelText(/^Cod fiscal \*$/i)).toHaveAttribute('readonly');
  });
});
