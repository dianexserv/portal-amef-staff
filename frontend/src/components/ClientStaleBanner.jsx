// Banner galben afișat când lookup-ul ANAF a întors date din cache (decizia 4a).
//
// Mecanism: backend-ul (anaf-lookup-service.js) face fallback la cache când
// API-ul ANAF e down după toate retry-urile, marcând `stale: true` pe răspuns.
// Frontend-ul afișează acest banner ca utilizatorul să știe că datele auto-
// completate sunt din cache (nu live de la ANAF) și să verifice manual.
//
// Banner-ul e dismissible (X) — state local, nu persistă peste mount-uri.

import { useState } from 'react';

function formatDate(dateString) {
  if (!dateString) return 'necunoscut';
  try {
    const d = new Date(dateString);
    if (Number.isNaN(d.getTime())) return dateString;
    return d.toLocaleDateString('ro-RO', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return dateString;
  }
}

export default function ClientStaleBanner({ verifiedAt }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div
      role="alert"
      data-testid="client-stale-banner"
      className="mb-4 flex items-start gap-3 rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-800"
    >
      <span aria-hidden="true" className="mt-0.5 text-lg leading-none">
        ⚠️
      </span>
      <div className="flex-1">
        <p className="font-medium">
          Date ANAF din cache (verificat ultima dată: {formatDate(verifiedAt)})
        </p>
        <p className="mt-1">
          API ANAF temporar indisponibil. Verifică manual datele înainte de
          salvare.
        </p>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Închide notificarea"
        className="rounded p-1 text-yellow-700 hover:bg-yellow-100"
      >
        ✕
      </button>
    </div>
  );
}
