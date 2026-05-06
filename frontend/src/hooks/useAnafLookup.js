// Hook pentru auto-completare ANAF (decizia 3b — manual trigger only).
//
// NU face fetch automat la mount. Utilizatorul apasă butonul „Verifică ANAF"
// din ClientForm, care apelează `lookup(cui, { referenceDate })`.
//
// State-ul:
//   - loading: boolean — request în zbor
//   - result: payload-ul ANAF (incl. `stale: boolean`) sau null
//   - error: Error | null
//
// `reset()` curăță state-ul (folosit la schimbarea CUI-ului în formular).

import { useCallback, useState } from 'react';
import { lookupCui } from '../utils/clients-api';

export function useAnafLookup() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const lookup = useCallback(async (cui, options = {}) => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await lookupCui(cui, options);
      setResult(data);
      setLoading(false);
      return data;
    } catch (err) {
      setError(err);
      setLoading(false);
      throw err;
    }
  }, []);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
    setLoading(false);
  }, []);

  return { lookup, reset, loading, result, error };
}
