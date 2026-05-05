// Service pentru integrare cu ANAF webservice V9 (PlatitorTvaRest).
//
// Endpoint:  POST https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva
// Payload:   [{ cui: <int>, data: 'YYYY-MM-DD' }]    (ARRAY — V9 e batch)
// Răspuns:   { cod, message, found: [...], notFound: [int...] }
//
// Replicăm pattern-urile din implementarea Dianex (factura.js, în uz în
// producție) — header, payload, normalizare CUI, mapping județ via cod auto,
// mapare „adresa_sediu_social" → câmpuri structurate. Diferențele față de
// Dianex:
//   - Pino logger (fără log.factura).
//   - Validare răspuns cu Zod (`.passthrough()` peste tot — ANAF schimbă
//     uneori câmpuri auxiliare între versiuni).
//   - Cache in-memory cu TTL 24h (Dianex făcea call live la fiecare lookup).
//   - Erori canonicizate prin `AppError` subclasses (NotFoundError,
//     ServiceUnavailableError, ValidationError) — UI-ul disting clar
//     între „CUI invalid", „CUI nu există la ANAF" și „ANAF e jos".
//   - Fallback stale-cache când ANAF e jos (returnăm date vechi marcate
//     `stale: true` în loc să eșuăm complet).
//
// Cache:
//   - global cross-tenant (datele ANAF sunt publice).
//   - cheia = `${cui}:${referenceDate}` ca să suportăm interogări la
//     date diferite (ex: dump istoric pentru audit).
//   - stocat în-process Map; pe restart Cloud Run cache-ul se pierde
//     (acceptabil — primul request după boot va lovi ANAF).
//   - notFound NU e cached (clienții rezolvă tipic „CUI nou" înregistrat
//     azi → următoarea cerere ar trebui să-l găsească).
//
// `_deps` test seam (CLAUDE.md → Testing seam pattern):
//   - httpClient: wrapper peste axios.post; testele pasează vi.fn().
//   - logger: Pino; testele pasează un mock cu warn/error/info/debug.
//   - now: Date.now alias; testele forțează valori pentru TTL deterministic.

const axios = require('axios');
const { z } = require('zod');
const realLogger = require('../logger');
const {
  ValidationError,
  NotFoundError,
  ServiceUnavailableError,
} = require('../errors');
const {
  prettyJudetName,
  normalizeJudetCod,
} = require('../utils/judete-romania');

const ANAF_V9_URL =
  'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva';
const ANAF_TIMEOUT_MS = 15000;
const ANAF_MAX_RETRIES = 3;
const ANAF_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ─────────────────────────────────────────────────────────────────────────
// Test seam — vezi „Testing seam pattern" în CLAUDE.md.
//
// `httpClient` e un mic wrapper deasupra axios.post ca să putem să-l
// suprascriem complet în teste fără vi.mock pe axios (CJS). În producție
// face exact ce ar face axios.post(url, body, options).
// ─────────────────────────────────────────────────────────────────────────

async function defaultHttpClient(url, body, options) {
  return axios.post(url, body, options);
}

const _deps = {
  httpClient: defaultHttpClient,
  logger: realLogger,
  now: () => Date.now(),
};

// ─────────────────────────────────────────────────────────────────────────
// Cache in-memory
// ─────────────────────────────────────────────────────────────────────────

// `Map<cacheKey, { data, cachedAt, referenceDate }>`. Module-level singleton
// — cross-tenant, cross-request. Pe restart container se pierde (acceptabil:
// primul lookup post-boot pentru un CUI = un round-trip la ANAF).
const _cache = new Map();

function buildCacheKey(cui, referenceDate) {
  return `${cui}:${referenceDate}`;
}

function getFromCache(cacheKey) {
  return _cache.get(cacheKey);
}

function setInCache(cacheKey, data, referenceDate) {
  _cache.set(cacheKey, {
    data,
    cachedAt: _deps.now(),
    referenceDate,
  });
}

function isCacheFresh(entry) {
  if (!entry) return false;
  return _deps.now() - entry.cachedAt < ANAF_CACHE_TTL_MS;
}

// Expus pentru teste — NU folosi din cod de producție. Cache-ul se golește
// natural via TTL; un clear forțat e util doar la rulare suite-ului de teste.
function _clearCache() {
  _cache.clear();
}

// ─────────────────────────────────────────────────────────────────────────
// Normalizare CUI
//
// Acceptă: integer (1234567), string fără prefix ('1234567'), string cu
// prefix RO ('RO1234567', 'RO 1234567', 'ro1234567'). Returnează un string
// numeric de cifre ce poate fi parseInt-uit pentru payload-ul ANAF.
// Aruncă `ValidationError(INVALID_CUI)` dacă input-ul nu se parsează.
// ─────────────────────────────────────────────────────────────────────────

function setErrorCode(err, code) {
  err.code = code;
  return err;
}

function normalizeCui(input) {
  if (input === undefined || input === null || input === '') {
    throw setErrorCode(new ValidationError('CUI invalid'), 'INVALID_CUI');
  }
  // Integer direct → string fără prefix.
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input <= 0) {
      throw setErrorCode(new ValidationError('CUI invalid'), 'INVALID_CUI');
    }
    return String(input);
  }
  // String — uppercase, scoate prefix RO + spații.
  const stripped = String(input)
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/^RO/, '');
  if (!/^\d+$/.test(stripped) || stripped === '') {
    throw setErrorCode(new ValidationError('CUI invalid'), 'INVALID_CUI');
  }
  return stripped;
}

// ─────────────────────────────────────────────────────────────────────────
// Zod — validare răspuns V9.
// `.passthrough()` peste tot: ANAF adaugă/scoate câmpuri auxiliare între
// versiuni minore. Noi extragem doar ce avem nevoie; restul tolerăm.
// ─────────────────────────────────────────────────────────────────────────

const DateGeneraleSchema = z
  .object({
    cui: z.number(),
    data: z.string(),
    denumire: z.string(),
    adresa: z.string().optional().default(''),
    nrRegCom: z.string().optional().default(''),
    cod_CAEN: z.string().optional().default(''),
    data_inregistrare: z.string().optional().default(''),
  })
  .passthrough();

const FoundEntrySchema = z
  .object({
    date_generale: DateGeneraleSchema,
    inregistrare_scop_Tva: z
      .object({ scpTVA: z.boolean() })
      .passthrough()
      .optional(),
    stare_inactiv: z
      .object({ statusInactivi: z.boolean() })
      .passthrough()
      .optional(),
    inregistrare_SplitTVA: z
      .object({ statusSplitTVA: z.boolean() })
      .passthrough()
      .optional(),
    adresa_sediu_social: z.object({}).passthrough().optional(),
    adresa_domiciliu_fiscal: z.object({}).passthrough().optional(),
  })
  .passthrough();

const AnafV9ResponseSchema = z
  .object({
    cod: z.number().optional(),
    message: z.string().optional(),
    found: z.array(FoundEntrySchema),
    notFound: z.array(z.number()).optional().default([]),
  })
  .passthrough();

// ─────────────────────────────────────────────────────────────────────────
// Mapping răspuns ANAF → shape intern
// ─────────────────────────────────────────────────────────────────────────

// Extrage „Sector N" din ddenumire_Localitate (Dianex pattern). Util doar
// pentru București — restul județelor au localitatea ca string normal.
// Regex acceptă atât „SECTOR 1" cât și „SECTORUL 1" — în răspunsurile reale
// ANAF V9 forma observată e „BUCURESTI SECTORUL <N>", dar tolerăm și
// varianta scurtă pentru robustețe la schimbări de format.
function extractSectorIfBucuresti(adresa) {
  if (!adresa) return null;
  const match = /sector(?:ul)?\s*(\d)/i.exec(String(adresa));
  return match ? `Sector ${match[1]}` : null;
}

// Map adresa structurată din ANAF (sediu_social sau domiciliu_fiscal)
// → forma noastră `{ county, city, street, street_number, postal_code }`.
// Câmpuri lipsă → string gol (UI-ul afișează „—" sau placeholder).
function mapAnafAddress(rawAddress) {
  if (!rawAddress || typeof rawAddress !== 'object') {
    return {
      county: '',
      city: '',
      street: '',
      street_number: '',
      postal_code: '',
    };
  }
  const judetCod = rawAddress.dcod_JudetAuto || rawAddress.scod_JudetAuto;
  const judetCodNormalized = normalizeJudetCod(judetCod || '');
  const county = judetCodNormalized
    ? prettyJudetName(judetCodNormalized)
    : '';
  // Prefix-urile câmpurilor diferă: `d*` pentru domiciliu_fiscal, `s*` pentru
  // sediu_social. Verificăm ambele variante ca să refolosim helper-ul.
  const localitate =
    rawAddress.ddenumire_Localitate || rawAddress.sdenumire_Localitate || '';
  const sector =
    county === 'Bucuresti' ? extractSectorIfBucuresti(localitate) : null;
  return {
    county,
    city: sector || localitate,
    street:
      rawAddress.ddenumire_Strada || rawAddress.sdenumire_Strada || '',
    street_number:
      rawAddress.dnumar_Strada || rawAddress.snumar_Strada || '',
    postal_code: rawAddress.dcod_Postal || rawAddress.scod_Postal || '',
  };
}

function mapAnafResponseToResult(foundEntry, fetchedAt) {
  const dg = foundEntry.date_generale;
  return {
    cui: String(dg.cui),
    denumire: dg.denumire,
    adresa: dg.adresa || '',
    cod_caen: dg.cod_CAEN || '',
    is_vat_payer: foundEntry.inregistrare_scop_Tva
      ? Boolean(foundEntry.inregistrare_scop_Tva.scpTVA)
      : false,
    is_inactive: foundEntry.stare_inactiv
      ? Boolean(foundEntry.stare_inactiv.statusInactivi)
      : false,
    is_split_tva: foundEntry.inregistrare_SplitTVA
      ? Boolean(foundEntry.inregistrare_SplitTVA.statusSplitTVA)
      : false,
    adresa_sediu: mapAnafAddress(foundEntry.adresa_sediu_social),
    adresa_domiciliu_fiscal: mapAnafAddress(foundEntry.adresa_domiciliu_fiscal),
    nr_reg_com: dg.nrRegCom || '',
    data_inregistrare: dg.data_inregistrare || '',
    anaf_data: foundEntry, // raw, pentru audit + cron de re-verificare (Stage 12)
    fetched_at: new Date(fetchedAt).toISOString(),
    stale: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Retry cu backoff + jitter
//
// Replică pattern-ul din Dianex factura.js: 3 încercări, backoff exponențial
// `2^attempt * 1000 ms` + jitter random 0-1000ms ca să de-sincronizăm dacă
// ANAF e supraîncărcat și mai multe instanțe Cloud Run pornesc retries
// simultan. Jitter NU folosește crypto (nu e secret), Math.random e suficient.
// ─────────────────────────────────────────────────────────────────────────

function shouldRetry(err) {
  // Network/timeout — fără response, retry.
  if (!err || !err.response) return true;
  const status = err.response.status;
  // 5xx și 429 (rate-limit) — retry. 4xx altele — bail-out.
  return status >= 500 || status === 429;
}

function backoffDelay(attempt) {
  return Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callAnafWithRetry(payload) {
  let lastErr;
  for (let attempt = 0; attempt < ANAF_MAX_RETRIES; attempt++) {
    try {
      const response = await _deps.httpClient(ANAF_V9_URL, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: ANAF_TIMEOUT_MS,
      });
      return response;
    } catch (err) {
      lastErr = err;
      if (!shouldRetry(err) || attempt === ANAF_MAX_RETRIES - 1) {
        // Bail out fie pentru că nu retry-ăm acest tip de eroare, fie pentru
        // că am consumat toate încercările.
        break;
      }
      const wait = backoffDelay(attempt);
      _deps.logger.warn(
        { err, attempt: attempt + 1, waitMs: wait },
        'ANAF lookup failed, retrying'
      );
      await sleep(wait);
    }
  }
  // lastErr garantat setat — am ieșit din loop pe break după ce-am prins err.
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────
// Format `data` — expectat YYYY-MM-DD în payload-ul ANAF.
// ─────────────────────────────────────────────────────────────────────────

function formatReferenceDate(input) {
  if (input === undefined || input === null) {
    // Default: azi în UTC — payload-ul ANAF nu e sensibil la timezone, dar
    // folosirea UTC garantează comportament identic indiferent de TZ-ul
    // pe care rulează Cloud Run (oficial e Europe/Bucharest, dar dacă cineva
    // schimbă, nu vrem să apară diff-uri).
    return new Date().toISOString().slice(0, 10);
  }
  if (input instanceof Date) {
    return input.toISOString().slice(0, 10);
  }
  // String — trust user input format-ul YYYY-MM-DD; dacă greșesc, ANAF
  // returnează eroare validă pe care o lăsăm să cadă pe ServiceUnavailable.
  return String(input);
}

// ─────────────────────────────────────────────────────────────────────────
// API public
// ─────────────────────────────────────────────────────────────────────────

async function lookupByCui(cui, options = {}) {
  const normalizedCui = normalizeCui(cui);
  const referenceDate = formatReferenceDate(options.referenceDate);
  const cacheKey = buildCacheKey(normalizedCui, referenceDate);
  const skipCache = Boolean(options.skipCache);

  // 1) Cache hit fresh — return imediat.
  if (!skipCache) {
    const entry = getFromCache(cacheKey);
    if (isCacheFresh(entry)) {
      return entry.data;
    }
  }

  // 2) Apel ANAF cu retry.
  const payload = [{ cui: parseInt(normalizedCui, 10), data: referenceDate }];
  let response;
  try {
    response = await callAnafWithRetry(payload);
  } catch (err) {
    // 3c — fallback stale-cache: dacă avem ORICE entry (chiar expirat),
    // returnăm cu `stale: true`. UI-ul afișează banner „Date învechite —
    // ANAF temporar indisponibil".
    const entry = getFromCache(cacheKey);
    if (entry) {
      _deps.logger.warn(
        { cui: normalizedCui, err },
        'ANAF unavailable, returning stale cache'
      );
      return { ...entry.data, stale: true };
    }
    _deps.logger.error(
      { cui: normalizedCui, err },
      'ANAF unavailable, no cache fallback'
    );
    throw setErrorCode(
      new ServiceUnavailableError(
        'Serviciul ANAF e temporar indisponibil'
      ),
      'ANAF_UNAVAILABLE'
    );
  }

  // 3) Validare shape răspuns.
  let parsed;
  try {
    parsed = AnafV9ResponseSchema.parse(response.data);
  } catch (err) {
    _deps.logger.error(
      { cui: normalizedCui, response: response.data, err },
      'ANAF response shape invalid'
    );
    throw setErrorCode(
      new ServiceUnavailableError('Răspuns ANAF necunoscut'),
      'ANAF_RESPONSE_INVALID'
    );
  }

  // 4) notFound → NotFoundError. NU cache-uim notFound: CUI-uri noi pot
  // apărea în registry zilnic, iar caching-ul ar masca asta 24h.
  const cuiInt = parseInt(normalizedCui, 10);
  if ((parsed.notFound || []).includes(cuiInt)) {
    throw setErrorCode(
      new NotFoundError(`CUI ${normalizedCui} nu a fost găsit la ANAF`),
      'CUI_NOT_FOUND_AT_ANAF'
    );
  }

  // 5) found[0] → mapping + cache.
  if (!parsed.found || parsed.found.length === 0) {
    // Răspuns „valid Zod" dar fără rezultate și fără notFound — situație
    // bizară (ANAF garantează una sau alta). Tratăm ca shape invalid.
    _deps.logger.error(
      { cui: normalizedCui, response: response.data },
      'ANAF response: empty found and notFound'
    );
    throw setErrorCode(
      new ServiceUnavailableError('Răspuns ANAF necunoscut'),
      'ANAF_RESPONSE_INVALID'
    );
  }
  const result = mapAnafResponseToResult(parsed.found[0], _deps.now());
  setInCache(cacheKey, result, referenceDate);
  return result;
}

module.exports = {
  lookupByCui,
  // Test seam — vezi „Testing seam pattern" în CLAUDE.md.
  _deps,
  _clearCache,
  // Expuse pentru teste izolate ale helper-elor pure (mapping, normalizare).
  // NU folosi din cod de producție — `lookupByCui` orchestrează totul.
  _normalizeCui: normalizeCui,
  _mapAnafResponseToResult: mapAnafResponseToResult,
};
