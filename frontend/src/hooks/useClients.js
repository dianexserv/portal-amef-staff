// Hook pentru listarea paginată de clienți cu filtre.
//
// State-ul:
//   - data: { rows, total, limit, offset } | null
//   - loading: boolean
//   - error: Error | null
//
// Comportament:
//   - Pe fiecare schimbare de filtre, abort-ăm request-ul anterior și refacem
//     fetch-ul. Așa nu apar race conditions când utilizatorul tastează rapid
//     în search (request-ul vechi venind după cel nou ar suprascrie state-ul).
//   - La unmount abort-ăm request-ul în zbor — nu mai facem setState pe o
//     componentă demontată (React 18 nu mai aruncă warning, dar e oricum
//     traffic inutil pe rețea).

import { useCallback, useEffect, useRef, useState } from 'react';
import { listClients } from '../utils/clients-api';

export function useClients({
  limit,
  offset,
  search,
  fiscalCodeType,
  anafVerified,
} = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const abortRef = useRef(null);
  const reloadCounterRef = useRef(0);
  const [reloadTrigger, setReloadTrigger] = useState(0);

  // Cheia de dependențe — serializăm filtrele ca string ca useEffect să nu
  // re-fire pe identitate (un obiect nou la fiecare render ar declanșa
  // refetch infinit).
  const filtersKey = JSON.stringify({
    limit,
    offset,
    search,
    fiscalCodeType,
    anafVerified,
  });

  useEffect(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    listClients({
      limit,
      offset,
      search,
      fiscalCodeType,
      anafVerified,
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setLoading(false);
      })
      .catch((err) => {
        // Abort-urile vin ca CanceledError sau cu err.name='CanceledError' /
        // 'AbortError'. Nu setăm error în acest caz — request-ul a fost
        // cancellat intenționat.
        if (
          controller.signal.aborted ||
          err.name === 'CanceledError' ||
          err.name === 'AbortError' ||
          err.code === 'ERR_CANCELED'
        ) {
          return;
        }
        setError(err);
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, reloadTrigger]);

  const refetch = useCallback(() => {
    reloadCounterRef.current += 1;
    setReloadTrigger(reloadCounterRef.current);
  }, []);

  return { data, loading, error, refetch };
}
