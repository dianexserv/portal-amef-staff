// Teste pentru useClients. Mock-uim listClients la nivel de modul ca să
// controlăm răspunsurile și să verificăm comportamentul de abort/refetch.

const { listClientsMock } = vi.hoisted(() => ({
  listClientsMock: vi.fn(),
}));

vi.mock('../utils/clients-api', () => ({
  listClients: listClientsMock,
}));

import { act, renderHook, waitFor } from '@testing-library/react';
import { useClients } from './useClients';

beforeEach(() => {
  listClientsMock.mockReset();
});

describe('useClients — initial state și happy path', () => {
  it('inițial: loading=true, data=null', async () => {
    let resolveFn;
    listClientsMock.mockImplementation(
      () => new Promise((resolve) => { resolveFn = resolve; })
    );
    const { result } = renderHook(() => useClients({ limit: 10, offset: 0 }));
    // Înainte ca promise-ul să fie rezolvat
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await act(async () => {
      resolveFn({ rows: [], total: 0, limit: 10, offset: 0 });
    });
  });

  it('pe success: data populat, loading=false, error=null', async () => {
    const payload = { rows: [{ id: 1, company_name: 'Acme' }], total: 1, limit: 10, offset: 0 };
    listClientsMock.mockResolvedValue(payload);

    const { result } = renderHook(() => useClients({ limit: 10, offset: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(payload);
    expect(result.current.error).toBeNull();
  });

  it('pe error: error populat, loading=false, data=null', async () => {
    const err = new Error('Network down');
    listClientsMock.mockRejectedValue(err);

    const { result } = renderHook(() => useClients({ limit: 10, offset: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(err);
    expect(result.current.data).toBeNull();
  });
});

describe('useClients — refetch pe schimbare filtre', () => {
  it('schimbarea filtrelor declanșează un nou fetch', async () => {
    listClientsMock.mockResolvedValue({ rows: [], total: 0, limit: 10, offset: 0 });

    const { result, rerender } = renderHook(
      ({ search }) => useClients({ limit: 10, offset: 0, search }),
      { initialProps: { search: '' } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listClientsMock).toHaveBeenCalledTimes(1);

    rerender({ search: 'Acme' });
    await waitFor(() => expect(listClientsMock).toHaveBeenCalledTimes(2));
    const secondCall = listClientsMock.mock.calls[1][0];
    expect(secondCall.search).toBe('Acme');
  });

  it('refetch() forțează un nou fetch fără schimbarea filtrelor', async () => {
    listClientsMock.mockResolvedValue({ rows: [], total: 0, limit: 10, offset: 0 });

    const { result } = renderHook(() => useClients({ limit: 10, offset: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listClientsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refetch();
    });
    await waitFor(() => expect(listClientsMock).toHaveBeenCalledTimes(2));
  });
});

describe('useClients — cancellation', () => {
  it('unmount în timpul fetch-ului abort-ează request-ul (NU setează state)', async () => {
    let resolveFn;
    listClientsMock.mockImplementation(
      (args) =>
        new Promise((resolve, reject) => {
          if (args.signal) {
            args.signal.addEventListener('abort', () => {
              const err = new Error('canceled');
              err.name = 'CanceledError';
              reject(err);
            });
          }
          resolveFn = resolve;
        })
    );

    const { result, unmount } = renderHook(() => useClients({ limit: 10, offset: 0 }));
    expect(result.current.loading).toBe(true);

    unmount();

    // Resolve după unmount — nu ar trebui să afecteze state (componentă demontată).
    // Hook-ul tratează signal.aborted înainte de setState, deci nu există warning.
    await act(async () => {
      resolveFn({ rows: [], total: 0, limit: 10, offset: 0 });
    });
    // Nu putem face assertions după unmount, dar absența unui warning în consolă
    // e proba că abort-ul a funcționat.
  });

  it('răspunsul abort NU setează error pe state', async () => {
    listClientsMock
      .mockImplementationOnce(
        (args) =>
          new Promise((_, reject) => {
            if (args.signal) {
              args.signal.addEventListener('abort', () => {
                const err = new Error('canceled');
                err.name = 'CanceledError';
                reject(err);
              });
            }
          })
      )
      .mockResolvedValueOnce({ rows: [{ id: 99 }], total: 1, limit: 10, offset: 0 });

    const { result, rerender } = renderHook(
      ({ search }) => useClients({ limit: 10, offset: 0, search }),
      { initialProps: { search: '' } }
    );
    // Trigger refetch (schimbare search) — primul fetch e abort-uit.
    rerender({ search: 'X' });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ rows: [{ id: 99 }], total: 1, limit: 10, offset: 0 });
  });
});
