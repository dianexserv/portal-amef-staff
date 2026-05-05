// Mapping județe România — replicat din implementarea Dianex (factura.js).
//
// ANAF webservice returnează cod-uri auto de 2 litere (ex: 'B' pentru
// București, 'CJ' pentru Cluj). În UI noi afișăm denumirea „prietenoasă"
// (fără diacritice — convenție AMEF, vezi seed-ul `core_representative_roles`
// din migrația 001 care folosește același pattern). Mapping-ul e bidirecțional:
//   - `JUDET_COD`        — denumire → cod auto
//   - `JUDET_COD_REVERSE` — cod auto → denumire
//
// Sursa adevărului: codurile ISO 3166-2:RO + lista oficială ANAF
// (`dcod_JudetAuto` din răspunsul V9). NU diacritice — fără 'ș/ț' — ca să
// evităm probleme de encoding la export DOCX (Stage 11) sau la integrare
// cu sisteme legacy. Cele 41 județe + Municipiul București = 42 intrări.

const JUDET_COD = Object.freeze({
  Alba: 'AB',
  Arad: 'AR',
  Arges: 'AG',
  Bacau: 'BC',
  Bihor: 'BH',
  'Bistrita-Nasaud': 'BN',
  Botosani: 'BT',
  Brasov: 'BV',
  Braila: 'BR',
  Bucuresti: 'B',
  Buzau: 'BZ',
  'Caras-Severin': 'CS',
  Calarasi: 'CL',
  Cluj: 'CJ',
  Constanta: 'CT',
  Covasna: 'CV',
  Dambovita: 'DB',
  Dolj: 'DJ',
  Galati: 'GL',
  Giurgiu: 'GR',
  Gorj: 'GJ',
  Harghita: 'HR',
  Hunedoara: 'HD',
  Ialomita: 'IL',
  Iasi: 'IS',
  Ilfov: 'IF',
  Maramures: 'MM',
  Mehedinti: 'MH',
  Mures: 'MS',
  Neamt: 'NT',
  Olt: 'OT',
  Prahova: 'PH',
  'Satu Mare': 'SM',
  Salaj: 'SJ',
  Sibiu: 'SB',
  Suceava: 'SV',
  Teleorman: 'TR',
  Timis: 'TM',
  Tulcea: 'TL',
  Vaslui: 'VS',
  Valcea: 'VL',
  Vrancea: 'VN',
});

// Inverse map construit la load. `Object.freeze` ca să prevenim mutarea
// accidentală în cod consumator (cache-ul ANAF poate trăi minute pe
// instanța Cloud Run, nu vrem ca un bug care setează `JUDET_COD_REVERSE.B`
// să se propage la următoarele cereri).
const JUDET_COD_REVERSE = Object.freeze(
  Object.fromEntries(
    Object.entries(JUDET_COD).map(([name, code]) => [code, name])
  )
);

// Acceptă fie denumirea („Timis", „TIMIS", „timis") fie codul („TM"). Returnează
// codul de 2 litere uppercase. Input invalid sau gol → string gol (NU aruncă —
// convenție Dianex: lipsa județului e un caz comun la import legacy).
function normalizeJudetCod(input) {
  if (input === undefined || input === null) return '';
  const trimmed = String(input).trim();
  if (trimmed === '') return '';
  // 1) Match exact pe cod (case-insensitive). Codurile sunt 1-3 char-uri.
  const upper = trimmed.toUpperCase();
  if (JUDET_COD_REVERSE[upper]) return upper;
  // 2) Match pe denumire — case-insensitive. Iterăm ca să acceptăm orice casing
  // în input (Dianex factura.js nu normalizează stringul venit din UI).
  for (const [name, code] of Object.entries(JUDET_COD)) {
    if (name.toUpperCase() === upper) return code;
  }
  return '';
}

// Cod auto → denumire prietenoasă. Cod necunoscut → returnăm input-ul ca-i
// (defensive: dacă ANAF adaugă un județ nou nemapat aici, măcar nu pierdem
// informația; UI-ul va afișa codul brut).
function prettyJudetName(code) {
  if (code === undefined || code === null) return '';
  const upper = String(code).trim().toUpperCase();
  return JUDET_COD_REVERSE[upper] || upper;
}

module.exports = {
  JUDET_COD,
  JUDET_COD_REVERSE,
  normalizeJudetCod,
  prettyJudetName,
};
