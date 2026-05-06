// Hook pentru fetch-ul unui singur client.
//
// Pattern identic cu useClients dar pentru endpoint-ul `/clients/:id`.
// Returnează `{ client, loading, error, refetch }`.
//
// La schimbarea id-ului, abort-ăm request-ul anterior și refetch-uim. Dacă
// id-ul e null/undefined (ex: în create mode al ClientFormPage) NU facem fetch.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getClientById } from '../utils/clients-api';

export function useClient(id) {
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(Boolean(id));
  const [error, setError] = useState(null);

  const abortRef = useRef(null);
  const reloadCounterRef = useRef(0);
  const [reloadTrigger, setReloadTrigger] = useState(0);

  useEffect(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    if (!id) {
      setClient(null);
      setLoading(false);
      setError(null);
      return undefined;
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    getClientById(id, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setClient(result);
        setLoading(false);
      })
      .catch((err) => {
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
  }, [id, reloadTrigger]);

  const refetch = useCallback(() => {
    reloadCounterRef.current += 1;
    setReloadTrigger(reloadCounterRef.current);
  }, []);

  return { client, loading, error, refetch };
}
