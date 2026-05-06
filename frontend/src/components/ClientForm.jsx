// Formularul unic pentru creare/editare client.
//
// Folosit de ClientFormPage atât pentru CREATE cât și pentru EDIT — modul
// determinat de prezența `initialValues`. Diferențe:
//   - CREATE: secțiunea „Identificare fiscală" e editabilă + butonul „Verifică
//     ANAF" auto-completează company_name + adresa companie.
//   - EDIT: fiscal_code_type și fiscal_code sunt read-only (DB nu permite update
//     la `fiscal_code` — ar fi semantic „client nou", nu update).
//
// Validare: Zod safeParse la submit (decizia 5b — frontend-only Zod simplificat).
// Backend rămâne autoritate finală; mesajele sale sunt mapate în getBackendErrorMessage.
//
// ANAF lookup (decizia 3b — manual button, nu pe blur):
//   - Buton „Verifică ANAF" lângă fiscal_code, vizibil doar la fiscal_code_type=CUI.
//   - Pe success NOT stale: auto-fill company_name + adresă companie + flag is_vat_payer.
//   - Pe success stale: același auto-fill + ClientStaleBanner la top.
//   - Pe eroare: mesaj inline lângă buton.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAnafLookup } from '../hooks/useAnafLookup';
import { REPRESENTATIVE_ROLES } from '../utils/representative-roles';
import {
  CreateClientFormSchema,
  UpdateClientFormSchema,
  zodErrorsToFieldMap,
  getBackendErrorMessage,
  getBackendErrorCode,
} from '../utils/clients-validation';
import ClientStaleBanner from './ClientStaleBanner';

const EMPTY_FORM = {
  fiscal_code_type: 'CUI',
  fiscal_code: '',
  company_name: '',
  county: '',
  city: '',
  street: '',
  street_number: '',
  address_full: '',
  address_extra: '',
  postal_code: '',
  phone: '',
  email: '',
  notes: '',
  representative_name: '',
  representative_role_id: '',
  representative_ci_series: '',
  representative_ci_number: '',
  representative_ci_issued_by: '',
  representative_ci_issued_at: '',
  representative_county: '',
  representative_city: '',
  representative_street: '',
  representative_street_number: '',
  representative_address_full: '',
  representative_address_extra: '',
  representative_postal_code: '',
  iban: '',
  bank_name: '',
  is_vat_payer: false,
};

function normalizeInitial(initialValues) {
  if (!initialValues) return EMPTY_FORM;
  const merged = { ...EMPTY_FORM };
  for (const key of Object.keys(EMPTY_FORM)) {
    const v = initialValues[key];
    if (v === null || v === undefined) continue;
    merged[key] = v;
  }
  // Normalizează data CI la format YYYY-MM-DD pentru `<input type="date">`.
  if (merged.representative_ci_issued_at) {
    const d = String(merged.representative_ci_issued_at).slice(0, 10);
    merged.representative_ci_issued_at = d;
  }
  return merged;
}

function cleanForSubmit(values, mode) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (mode === 'edit' && (key === 'fiscal_code_type' || key === 'fiscal_code')) {
      continue;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '') continue;
      out[key] = trimmed;
    } else if (value !== null && value !== undefined) {
      out[key] = value;
    }
  }
  if (out.representative_role_id !== undefined) {
    out.representative_role_id = Number(out.representative_role_id);
  }
  return out;
}

function FieldError({ message }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1 text-xs text-red-600">
      {message}
    </p>
  );
}

function TextField({ label, name, value, onChange, error, type = 'text', readOnly = false, required = false }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-slate-700">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      <input
        type={type}
        name={name}
        value={value ?? ''}
        onChange={onChange}
        readOnly={readOnly}
        aria-invalid={Boolean(error)}
        className={`rounded-md border px-3 py-2 ${error ? 'border-red-400' : 'border-slate-300'} ${readOnly ? 'bg-slate-100 text-slate-500' : 'bg-white'}`}
      />
      <FieldError message={error} />
    </label>
  );
}

export default function ClientForm({
  mode = 'create',
  initialValues = null,
  onSubmit,
  submitting = false,
  formError = null,
}) {
  const navigate = useNavigate();
  const initial = useMemo(() => normalizeInitial(initialValues), [initialValues]);
  const [values, setValues] = useState(initial);
  const [fieldErrors, setFieldErrors] = useState({});
  const [showStaleBanner, setShowStaleBanner] = useState(false);
  const [staleVerifiedAt, setStaleVerifiedAt] = useState(null);

  const { lookup, loading: anafLoading, result: anafResult, error: anafError, reset: anafReset } =
    useAnafLookup();

  // Re-hidratează formul când `initialValues` se schimbă (load async în edit mode).
  useEffect(() => {
    setValues(normalizeInitial(initialValues));
  }, [initialValues]);

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    const v = type === 'checkbox' ? checked : value;
    setValues((prev) => ({ ...prev, [name]: v }));
    if (fieldErrors[name]) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
    if (name === 'fiscal_code' || name === 'fiscal_code_type') {
      anafReset();
      setShowStaleBanner(false);
    }
  }

  async function handleAnafLookup() {
    if (!values.fiscal_code) return;
    try {
      const data = await lookup(values.fiscal_code);
      // Backend returnează `data.companyData` în formatul lui `_mapAnafResponse`
      // (vezi anaf-lookup-service.js): denumire, scpTVA, statusInactivi,
      // adresa_sediu_social mapată la county/city/street/street_number.
      const next = { ...values };
      if (data.denumire) next.company_name = data.denumire;
      if (data.county) next.county = data.county;
      if (data.city) next.city = data.city;
      if (data.street) next.street = data.street;
      if (data.street_number) next.street_number = data.street_number;
      if (data.postal_code) next.postal_code = data.postal_code;
      if (data.address_full) next.address_full = data.address_full;
      if (typeof data.scpTVA === 'boolean') next.is_vat_payer = data.scpTVA;
      setValues(next);
      if (data.stale) {
        setShowStaleBanner(true);
        setStaleVerifiedAt(data.cachedAt || data.referenceDate || null);
      } else {
        setShowStaleBanner(false);
      }
    } catch {
      // Erorile sunt afișate prin `anafError` în render.
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const cleaned = cleanForSubmit(values, mode);
    const schema = mode === 'edit' ? UpdateClientFormSchema : CreateClientFormSchema;
    const parsed = schema.safeParse(cleaned);
    if (!parsed.success) {
      setFieldErrors(zodErrorsToFieldMap(parsed.error));
      return;
    }
    setFieldErrors({});
    await onSubmit(parsed.data);
  }

  const anafErrorCode = anafError ? getBackendErrorCode(anafError) : null;
  const anafErrorMsg = anafError ? getBackendErrorMessage(anafError) : null;
  const isEdit = mode === 'edit';

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {showStaleBanner && <ClientStaleBanner verifiedAt={staleVerifiedAt} />}

      {formError && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {formError}
        </div>
      )}

      <fieldset className="space-y-4 rounded-lg border border-slate-200 p-4">
        <legend className="px-2 text-sm font-semibold text-slate-700">
          Identificare fiscală
        </legend>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-slate-700">
              Tip cod fiscal <span className="text-red-500">*</span>
            </span>
            <select
              name="fiscal_code_type"
              value={values.fiscal_code_type}
              onChange={handleChange}
              disabled={isEdit}
              className={`rounded-md border px-3 py-2 ${isEdit ? 'border-slate-200 bg-slate-100 text-slate-500' : 'border-slate-300 bg-white'}`}
            >
              <option value="CUI">CUI</option>
              <option value="CNP">CNP</option>
            </select>
            <FieldError message={fieldErrors.fiscal_code_type} />
          </label>
          <TextField
            label="Cod fiscal"
            name="fiscal_code"
            value={values.fiscal_code}
            onChange={handleChange}
            error={fieldErrors.fiscal_code}
            readOnly={isEdit}
            required
          />
          {!isEdit && values.fiscal_code_type === 'CUI' && (
            <div className="flex flex-col gap-1 text-sm">
              <span className="invisible text-slate-700">.</span>
              <button
                type="button"
                onClick={handleAnafLookup}
                disabled={anafLoading || !values.fiscal_code}
                className="rounded-md bg-slate-700 px-3 py-2 text-white font-medium hover:bg-slate-800 disabled:opacity-60"
              >
                {anafLoading ? 'Se verifică...' : 'Verifică ANAF'}
              </button>
              {anafResult && !anafResult.stale && (
                <p className="mt-1 text-xs text-green-700">✓ Date încărcate de la ANAF</p>
              )}
              {anafErrorMsg && (
                <p role="alert" className="mt-1 text-xs text-red-600" data-testid="anaf-error">
                  {anafErrorMsg}
                  {anafErrorCode === 'CUI_NOT_FOUND_AT_ANAF' && (
                    <span className="block mt-1 text-slate-600">
                      Verifică sau continuă manual.
                    </span>
                  )}
                </p>
              )}
            </div>
          )}
        </div>
      </fieldset>

      <fieldset className="space-y-4 rounded-lg border border-slate-200 p-4">
        <legend className="px-2 text-sm font-semibold text-slate-700">
          Date companie
        </legend>
        <TextField
          label="Denumire"
          name="company_name"
          value={values.company_name}
          onChange={handleChange}
          error={fieldErrors.company_name}
          required
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField
            label="Județ"
            name="county"
            value={values.county}
            onChange={handleChange}
            error={fieldErrors.county}
            required
          />
          <TextField
            label="Oraș"
            name="city"
            value={values.city}
            onChange={handleChange}
            error={fieldErrors.city}
            required
          />
          <TextField
            label="Stradă"
            name="street"
            value={values.street}
            onChange={handleChange}
            error={fieldErrors.street}
            required
          />
          <TextField
            label="Număr"
            name="street_number"
            value={values.street_number}
            onChange={handleChange}
            error={fieldErrors.street_number}
            required
          />
          <TextField
            label="Cod poștal"
            name="postal_code"
            value={values.postal_code}
            onChange={handleChange}
            error={fieldErrors.postal_code}
          />
          <TextField
            label="Adresă suplimentară (bloc/scară/etc)"
            name="address_extra"
            value={values.address_extra}
            onChange={handleChange}
            error={fieldErrors.address_extra}
          />
        </div>
        <TextField
          label="Adresă completă (text liber)"
          name="address_full"
          value={values.address_full}
          onChange={handleChange}
          error={fieldErrors.address_full}
        />
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="is_vat_payer"
            checked={Boolean(values.is_vat_payer)}
            onChange={handleChange}
          />
          Plătitor TVA
        </label>
      </fieldset>

      <fieldset className="space-y-4 rounded-lg border border-slate-200 p-4">
        <legend className="px-2 text-sm font-semibold text-slate-700">
          Contact
        </legend>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField
            label="Telefon"
            name="phone"
            value={values.phone}
            onChange={handleChange}
            error={fieldErrors.phone}
          />
          <TextField
            label="Email"
            name="email"
            type="email"
            value={values.email}
            onChange={handleChange}
            error={fieldErrors.email}
          />
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-700">Note</span>
          <textarea
            name="notes"
            value={values.notes ?? ''}
            onChange={handleChange}
            rows={3}
            className="rounded-md border border-slate-300 bg-white px-3 py-2"
          />
        </label>
      </fieldset>

      <fieldset className="space-y-4 rounded-lg border border-slate-200 p-4">
        <legend className="px-2 text-sm font-semibold text-slate-700">
          Reprezentant legal
        </legend>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField
            label="Nume reprezentant"
            name="representative_name"
            value={values.representative_name}
            onChange={handleChange}
            error={fieldErrors.representative_name}
            required={!isEdit}
          />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-slate-700">
              Rol {!isEdit && <span className="text-red-500">*</span>}
            </span>
            <select
              name="representative_role_id"
              value={values.representative_role_id ?? ''}
              onChange={handleChange}
              aria-invalid={Boolean(fieldErrors.representative_role_id)}
              className={`rounded-md border bg-white px-3 py-2 ${fieldErrors.representative_role_id ? 'border-red-400' : 'border-slate-300'}`}
            >
              <option value="">— Selectează —</option>
              {REPRESENTATIVE_ROLES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <FieldError message={fieldErrors.representative_role_id} />
          </label>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <TextField
            label="Serie CI"
            name="representative_ci_series"
            value={values.representative_ci_series}
            onChange={handleChange}
            error={fieldErrors.representative_ci_series}
          />
          <TextField
            label="Număr CI"
            name="representative_ci_number"
            value={values.representative_ci_number}
            onChange={handleChange}
            error={fieldErrors.representative_ci_number}
            required={!isEdit}
          />
          <TextField
            label="Eliberat de"
            name="representative_ci_issued_by"
            value={values.representative_ci_issued_by}
            onChange={handleChange}
            error={fieldErrors.representative_ci_issued_by}
            required={!isEdit}
          />
        </div>
        <TextField
          label="Data eliberării CI"
          name="representative_ci_issued_at"
          type="date"
          value={values.representative_ci_issued_at}
          onChange={handleChange}
          error={fieldErrors.representative_ci_issued_at}
          required={!isEdit}
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField
            label="Județ reprezentant"
            name="representative_county"
            value={values.representative_county}
            onChange={handleChange}
            error={fieldErrors.representative_county}
            required={!isEdit}
          />
          <TextField
            label="Oraș reprezentant"
            name="representative_city"
            value={values.representative_city}
            onChange={handleChange}
            error={fieldErrors.representative_city}
            required={!isEdit}
          />
          <TextField
            label="Stradă reprezentant"
            name="representative_street"
            value={values.representative_street}
            onChange={handleChange}
            error={fieldErrors.representative_street}
            required={!isEdit}
          />
          <TextField
            label="Număr reprezentant"
            name="representative_street_number"
            value={values.representative_street_number}
            onChange={handleChange}
            error={fieldErrors.representative_street_number}
            required={!isEdit}
          />
          <TextField
            label="Cod poștal reprezentant"
            name="representative_postal_code"
            value={values.representative_postal_code}
            onChange={handleChange}
            error={fieldErrors.representative_postal_code}
          />
          <TextField
            label="Adresă suplimentară reprezentant"
            name="representative_address_extra"
            value={values.representative_address_extra}
            onChange={handleChange}
            error={fieldErrors.representative_address_extra}
          />
        </div>
        <TextField
          label="Adresă completă reprezentant (text liber)"
          name="representative_address_full"
          value={values.representative_address_full}
          onChange={handleChange}
          error={fieldErrors.representative_address_full}
        />
      </fieldset>

      <fieldset className="space-y-4 rounded-lg border border-slate-200 p-4">
        <legend className="px-2 text-sm font-semibold text-slate-700">
          Banking (opțional)
        </legend>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField
            label="IBAN"
            name="iban"
            value={values.iban}
            onChange={handleChange}
            error={fieldErrors.iban}
          />
          <TextField
            label="Bancă"
            name="bank_name"
            value={values.bank_name}
            onChange={handleChange}
            error={fieldErrors.bank_name}
          />
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-slate-800 px-4 py-2 text-white font-medium hover:bg-slate-900 disabled:opacity-60"
        >
          {submitting ? 'Se salvează...' : 'Salvează'}
        </button>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-slate-700 hover:bg-slate-50"
        >
          Anulează
        </button>
      </div>
    </form>
  );
}
