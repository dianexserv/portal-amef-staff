// Teste pentru useAnafLookup. Mock-uim lookupCui ca să simulăm răspunsuri
// happy / stale / 404.

const { lookupCuiMock } = vi.hoisted(() => ({ lookupCuiMock: vi.fn() }));

vi.mock('../utils/clients-api', () => ({
  lookupCui: lookupCuiMock,
}));

import { act, renderHook, waitFor } from '@testing-library/react';
import { useAnafLookup } from './useAnafLookup';

beforeEach(() => {
  lookupCuiMock.mockReset();
});

describe('useAnafLookup', () => {
  it('starea inițială: idle (NU se face fetch automat)', () => {
    const { result } = renderHook(() => useAnafLookup());
    expect(result.current.loading).toBe(false);
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
    expect(lookupCuiMock).not.toHaveBeenCalled();
  });

  it('lookup() success: setează result, loading=false', async () => {
    lookupCuiMock.mockResolvedValue({
      cui: '1234567',
      denumire: 'Test SRL',
      stale: false,
    });

    const { result } = renderHook(() => useAnafLookup());

    await act(async () => {
      await result.current.lookup('RO1234567');
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.result.denumire).toBe('Test SRL');
    expect(result.current.result.stale).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('lookup() returnează stale=true: result.stale=true', async () => {
    lookupCuiMock.mockResolvedValue({
      cui: '1234567',
      denumire: 'Cached SRL',
      stale: true,
      cachedAt: '2026-04-01T10:00:00Z',
    });

    const { result } = renderHook(() => useAnafLookup());
    await act(async () => {
      await result.current.lookup('1234567');
    });
    expect(result.current.result.stale).toBe(true);
  });

  it('lookup() error 404: error populat cu code CUI_NOT_FOUND_AT_ANAF', async () => {
    const err = new Error('not found');
    err.response = {
      status: 404,
      data: { success: false, error: 'CUI nu există', code: 'CUI_NOT_FOUND_AT_ANAF' },
    };
    lookupCuiMock.mockRejectedValue(err);

    const { result } = renderHook(() => useAnafLookup());

    await act(async () => {
      await expect(result.current.lookup('999')).rejects.toBe(err);
    });

    expect(result.current.error).toBe(err);
    expect(result.current.error.response.data.code).toBe('CUI_NOT_FOUND_AT_ANAF');
    expect(result.current.result).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('reset() curăță result + error + loading', async () => {
    lookupCuiMock.mockResolvedValue({ cui: '1', denumire: 'X' });

    const { result } = renderHook(() => useAnafLookup());
    await act(async () => {
      await result.current.lookup('1');
    });
    expect(result.current.result).not.toBeNull();

    act(() => {
      result.current.reset();
    });

    await waitFor(() => expect(result.current.result).toBeNull());
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
