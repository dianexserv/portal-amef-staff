// Badge cu statusul de verificare ANAF al unui client.
//
// 4 stări:
//   - verified: ANAF verificat recent (verde)
//   - stale: verificat dar datele sunt mai vechi de 30 zile (galben)
//   - never: nicicând verificat (gri)
//   - error: ultima verificare a eșuat (roșu)
//
// Pragul de „stale" e 30 de zile — peste această perioadă încurajăm
// utilizatorul să re-verifice manual ca să prindă schimbări de denumire/adresă/
// status TVA care nu au fost detectate de cron-ul zilnic (Stage 12).

const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

function classify(client) {
  if (!client) return 'never';
  if (!client.anaf_verified) return 'never';
  if (client.anaf_status === 'error') return 'error';
  if (client.anaf_verified_at) {
    const verifiedAt = new Date(client.anaf_verified_at).getTime();
    if (!Number.isNaN(verifiedAt)) {
      const ageMs = Date.now() - verifiedAt;
      if (ageMs > STALE_THRESHOLD_MS) return 'stale';
    }
  }
  return 'verified';
}

const STATE_PRESETS = {
  verified: {
    label: 'ANAF verificat',
    dotClass: 'bg-green-500',
    textClass: 'text-green-700 bg-green-50 border-green-200',
  },
  stale: {
    label: 'Date vechi (>30 zile)',
    dotClass: 'bg-yellow-500',
    textClass: 'text-yellow-800 bg-yellow-50 border-yellow-200',
  },
  never: {
    label: 'Nicicând verificat',
    dotClass: 'bg-slate-400',
    textClass: 'text-slate-600 bg-slate-50 border-slate-200',
  },
  error: {
    label: 'Eroare verificare',
    dotClass: 'bg-red-500',
    textClass: 'text-red-700 bg-red-50 border-red-200',
  },
};

export default function AnafLookupBadge({ client }) {
  const state = classify(client);
  const preset = STATE_PRESETS[state];
  return (
    <span
      data-testid="anaf-lookup-badge"
      data-state={state}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${preset.textClass}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-full ${preset.dotClass}`}
      />
      {preset.label}
    </span>
  );
}
