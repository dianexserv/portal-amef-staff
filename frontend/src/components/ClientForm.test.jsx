// Teste pentru ClientForm — focus pe validare, ANAF lookup și interacțiuni.

const { lookupCuiMock } = vi.hoisted(() => ({ lookupCuiMock: vi.fn() }));

vi.mock('../utils/clients-api', () => ({
  lookupCui: lookupCuiMock,
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ClientForm from './ClientForm';

beforeEach(() => {
  lookupCuiMock.mockReset();
  navigateMock.mockReset();
});

// Câmpurile required au „ *" în label (asterisk roșu) — îl includem în regex.
function setValue(label, value) {
  fireEvent.change(screen.getByLabelText(new RegExp(label, 'i')), {
    target: { value },
  });
}

function fillMinimalValid() {
  setValue('^Cod fiscal \\*$', 'RO1234567');
  setValue('^Denumire \\*$', 'Acme SRL');
  setValue('^Județ \\*$', 'Cluj');
  setValue('^Oraș \\*$', 'Cluj');
  setValue('^Stradă \\*$', 'X');
  setValue('^Număr \\*$', '1');
  setValue('^Telefon$', '0700111222');
  setValue('^Nume reprezentant \\*$', 'Test');
  fireEvent.change(screen.getByLabelText(/^Rol \*$/i), { target: { value: '1' } });
  setValue('^Număr CI \\*$', '111');
  setValue('^Eliberat de \\*$', 'SPCLEP');
  setValue('^Data eliberării CI \\*$', '2020-01-01');
  setValue('^Județ reprezentant \\*$', 'Cluj');
  setValue('^Oraș reprezentant \\*$', 'Cluj');
  setValue('^Stradă reprezentant \\*$', 'X');
  setValue('^Număr reprezentant \\*$', '1');
}

function renderForm(props = {}) {
  return render(
    <MemoryRouter>
      <ClientForm onSubmit={vi.fn()} {...props} />
    </MemoryRouter>
  );
}

describe('ClientForm — render', () => {
  it('randează cele 5 secțiuni (Identificare/Companie/Contact/Reprezentant/Banking)', () => {
    renderForm();
    // Folosim text-ul din <legend> ca să identificăm fieldset-urile
    expect(screen.getByText(/Identificare fiscală/i)).toBeInTheDocument();
    expect(screen.getByText(/Date companie/i)).toBeInTheDocument();
    expect(screen.getByText(/^Contact$/i)).toBeInTheDocument();
    expect(screen.getByText(/Reprezentant legal/i)).toBeInTheDocument();
    expect(screen.getByText(/^Banking/i)).toBeInTheDocument();
  });
});

describe('ClientForm — validare', () => {
  it('lipsa telefon ȘI email afișează „cel puțin telefon SAU email obligatoriu"', async () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    fillMinimalValid();
    // Ștergem telefonul ca să nu rămână nici phone nici email.
    setValue('^Telefon$', '');
    fireEvent.click(screen.getByRole('button', { name: /^Salvează/i }));

    await waitFor(() =>
      expect(
        screen.getAllByText(/Cel puțin telefon SAU email obligatoriu/i).length
      ).toBeGreaterThan(0)
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('ClientForm — ANAF lookup', () => {
  it('„Verifică ANAF" apelează lookup cu CUI-ul curent', async () => {
    lookupCuiMock.mockResolvedValue({
      cui: '1234567',
      denumire: 'Auto-completed SRL',
      county: 'Bucuresti',
      city: 'Sector 1',
      street: 'Calea Victoriei',
      street_number: '100',
      stale: false,
    });
    renderForm();
    setValue('^Cod fiscal \\*$', 'RO1234567');
    fireEvent.click(screen.getByRole('button', { name: /Verifică ANAF/i }));

    await waitFor(() => expect(lookupCuiMock).toHaveBeenCalledWith('RO1234567', {}));
  });

  it('lookup ANAF cu success NOT stale: auto-completează company_name și adresa', async () => {
    lookupCuiMock.mockResolvedValue({
      cui: '1234567',
      denumire: 'Auto-completed SRL',
      county: 'Bucuresti',
      city: 'Sector 1',
      street: 'Calea Victoriei',
      street_number: '100',
      scpTVA: true,
      stale: false,
    });
    renderForm();
    setValue('^Cod fiscal \\*$', 'RO1234567');
    fireEvent.click(screen.getByRole('button', { name: /Verifică ANAF/i }));

    await waitFor(() =>
      expect(screen.getByLabelText(/^Denumire \*$/i)).toHaveValue('Auto-completed SRL')
    );
    expect(screen.getByLabelText(/^Județ \*$/i)).toHaveValue('Bucuresti');
    expect(screen.getByLabelText(/^Oraș \*$/i)).toHaveValue('Sector 1');
    expect(screen.getByLabelText(/^Stradă \*$/i)).toHaveValue('Calea Victoriei');
    expect(screen.getByLabelText(/^Număr \*$/i)).toHaveValue('100');
    expect(screen.getByLabelText(/Plătitor TVA/i)).toBeChecked();
    // Banner stale NU afișat (stale=false)
    expect(screen.queryByTestId('client-stale-banner')).not.toBeInTheDocument();
  });

  it('lookup ANAF cu stale=true: randează ClientStaleBanner', async () => {
    lookupCuiMock.mockResolvedValue({
      cui: '1234567',
      denumire: 'Cached SRL',
      stale: true,
      cachedAt: '2026-04-01T10:00:00Z',
    });
    renderForm();
    setValue('^Cod fiscal \\*$', 'RO1234567');
    fireEvent.click(screen.getByRole('button', { name: /Verifică ANAF/i }));

    await waitFor(() =>
      expect(screen.getByTestId('client-stale-banner')).toBeInTheDocument()
    );
    expect(screen.getByText(/Date ANAF din cache/i)).toBeInTheDocument();
  });
});

describe('ClientForm — Anulează', () => {
  it('butonul „Anulează" apelează navigate(-1)', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: /^Anulează/i }));
    expect(navigateMock).toHaveBeenCalledWith(-1);
  });
});
