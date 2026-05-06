// Scheme Zod simplificate pentru formularul de client (decizia 5b).
//
// Backend-ul rămâne autoritate finală — service-ul (5b) face Zod-ul propriu
// care e mai strict (refines pentru phone-or-email, regex CUI/CNP, refine pe
// fiscal_code). Aici dublăm DOAR câmpurile-câmp pentru a prinde greșeli
// evidente fără round-trip la API: lipsesc câmpuri obligatorii, format CUI/CNP
// vădit greșit, email invalid, etc.
//
// De ce duplicăm și nu importăm direct schemele server-side: server-ul e
// CommonJS, frontend-ul e ESM. Singurul mod să share-uim ar fi un workspace
// pachet partajat — overkill pentru MVP. Trade-off: schimbări de validare
// trebuie făcute în două locuri (cu testele care prind divergențele).

import { z } from 'zod';

// Regex-uri identice cu cele din `server/src/services/client-service.js` ca
// să nu introducem divergențe subtile între client și server.
const CUI_REGEX = /^(RO\s?)?\d{2,10}$/i;
const CNP_REGEX = /^\d{13}$/;
const IBAN_REGEX = /^RO\d{2}[A-Z]{4}\d{16}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function refineFiscalCode(data, ctx) {
  if (data.fiscal_code_type === 'CUI' && !CUI_REGEX.test(data.fiscal_code)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fiscal_code'],
      message:
        'CUI invalid: format corect este 2-10 cifre, opțional prefix RO',
    });
  }
  if (data.fiscal_code_type === 'CNP' && !CNP_REGEX.test(data.fiscal_code)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fiscal_code'],
      message: 'CNP invalid: format corect este exact 13 cifre',
    });
  }
}

function refinePhoneOrEmail(data, ctx) {
  // CHECK constraint-ul DB enforce-ează la final pe ROW. Aici pre-validăm
  // ca să afișăm mesajul lângă câmp înainte de trimiterea formularului.
  const hasPhone = data.phone && data.phone.trim().length > 0;
  const hasEmail = data.email && data.email.trim().length > 0;
  if (!hasPhone && !hasEmail) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['phone'],
      message: 'Cel puțin telefon SAU email obligatoriu',
    });
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['email'],
      message: 'Cel puțin telefon SAU email obligatoriu',
    });
  }
}

const requiredString = (msg) => z.string().min(1, msg);
const optionalNullableString = z
  .string()
  .optional()
  .or(z.literal('').transform(() => undefined));

// Schema strictă pentru CREATE prin UI (modul UI din decizia 5b).
// Reprezentantul e required la creare via UI; pentru import (Stage 13) backend-ul
// folosește varianta `.partial()` din service.
const CreateClientFormSchemaBase = z.object({
  fiscal_code_type: z.enum(['CUI', 'CNP'], {
    errorMap: () => ({ message: 'Selectează CUI sau CNP' }),
  }),
  fiscal_code: requiredString('Cod fiscal obligatoriu')
    .min(2, 'Cod fiscal prea scurt')
    .max(20, 'Cod fiscal prea lung'),
  company_name: requiredString('Denumire obligatorie').max(255),

  // Adresă companie — toate NOT NULL în DB (vezi migrația 001).
  county: requiredString('Județ obligatoriu').max(100),
  city: requiredString('Oraș obligatoriu').max(100),
  street: requiredString('Stradă obligatorie').max(255),
  street_number: requiredString('Număr obligatoriu').max(50),
  address_full: optionalNullableString,
  address_extra: optionalNullableString,
  postal_code: optionalNullableString,

  // Contact — phone XOR email refine la nivel composed.
  phone: optionalNullableString,
  email: z
    .string()
    .email('Email invalid')
    .max(255)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  notes: optionalNullableString,

  // Reprezentant legal — required în UI mode.
  representative_name: requiredString('Nume reprezentant obligatoriu').max(255),
  representative_role_id: z
    .number({ invalid_type_error: 'Rol obligatoriu' })
    .int('Rol invalid')
    .positive('Rol invalid'),
  representative_ci_series: optionalNullableString,
  representative_ci_number: requiredString('Serie/număr CI obligatoriu').max(50),
  representative_ci_issued_by: requiredString('Emitent CI obligatoriu').max(
    255
  ),
  representative_ci_issued_at: z
    .string()
    .regex(DATE_REGEX, 'Data trebuie format YYYY-MM-DD'),
  representative_county: requiredString('Județ reprezentant obligatoriu').max(
    100
  ),
  representative_city: requiredString('Oraș reprezentant obligatoriu').max(100),
  representative_street: requiredString(
    'Stradă reprezentant obligatorie'
  ).max(255),
  representative_street_number: requiredString(
    'Număr reprezentant obligatoriu'
  ).max(50),
  representative_address_full: optionalNullableString,
  representative_address_extra: optionalNullableString,
  representative_postal_code: optionalNullableString,

  // Banking — opționale.
  iban: z
    .string()
    .regex(IBAN_REGEX, 'IBAN invalid (format RO + 22 caractere)')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  bank_name: optionalNullableString,

  // ANAF flags — booleen-uri cu default.
  is_vat_payer: z.boolean().optional(),
});

export const CreateClientFormSchema = CreateClientFormSchemaBase.superRefine(
  refineFiscalCode
).superRefine(refinePhoneOrEmail);

// Update — fiscal_code_type și fiscal_code sunt IMUTABILE după creare (decizia
// service layer 5b), deci le omitem din schema de update. Toate celelalte
// câmpuri devin opționale via `.partial()` (PUT-ul backend-ului acceptă body
// parțial). NU aplicăm refine-ul phone-or-email aici pentru că la update
// utilizatorul poate trimite doar `{ company_name: 'X' }` fără să atingă
// contactul; CHECK constraint-ul DB enforce-ează pe row-ul final.
export const UpdateClientFormSchema = CreateClientFormSchemaBase.omit({
  fiscal_code_type: true,
  fiscal_code: true,
}).partial();

// Helper: convertește erori Zod în obiect `{ fieldName: 'mesaj' }` pentru
// afișare inline în formular. Dacă același câmp are mai multe erori,
// păstrăm prima (cea mai relevantă în general).
export function zodErrorsToFieldMap(zodError) {
  const map = {};
  if (!zodError || !zodError.issues) return map;
  for (const issue of zodError.issues) {
    const path = issue.path && issue.path.join('.');
    if (path && !map[path]) {
      map[path] = issue.message;
    }
  }
  return map;
}

// Map error code → mesaj user-friendly în română.
// Backend-ul returnează `{ code, error }`; mesajul `error` e deja localizat,
// dar îl preferăm pe ăsta când avem control complet (consistență de tone +
// versionable separat de backend).
export const BACKEND_ERROR_MESSAGES = {
  FISCAL_CODE_DUPLICATE: 'Există deja un client cu acest CUI/CNP',
  EMAIL_DUPLICATE: 'Există deja un client cu acest email',
  PHONE_OR_EMAIL_REQUIRED: 'Telefon sau email obligatoriu',
  CUI_NOT_FOUND_AT_ANAF:
    'CUI nu există la ANAF. Verifică sau continuă manual.',
  ANAF_UNAVAILABLE:
    'ANAF temporar indisponibil. Încearcă mai târziu sau completează manual.',
  ANAF_RATE_LIMIT: 'Limita de verificări ANAF atinsă. Reîncearcă peste o oră.',
  REPRESENTATIVE_ROLE_INVALID: 'Rolul reprezentantului nu există',
  INVALID_CUI: 'CUI invalid',
  INVALID_FISCAL_CODE_TYPE: 'Tip cod fiscal invalid (acceptat: CUI sau CNP)',
};

export function getBackendErrorMessage(error) {
  // axios error normalization: er.response.data are forma { success, error, code }
  const code =
    error &&
    error.response &&
    error.response.data &&
    error.response.data.code;
  if (code && BACKEND_ERROR_MESSAGES[code]) {
    return BACKEND_ERROR_MESSAGES[code];
  }
  // Fallback: mesajul backend-ului dacă e disponibil
  const backendMsg =
    error &&
    error.response &&
    error.response.data &&
    error.response.data.error;
  if (backendMsg) return backendMsg;
  if (error && error.message) return error.message;
  return 'A apărut o eroare. Încearcă din nou.';
}

export function getBackendErrorCode(error) {
  return (
    (error &&
      error.response &&
      error.response.data &&
      error.response.data.code) ||
    null
  );
}
