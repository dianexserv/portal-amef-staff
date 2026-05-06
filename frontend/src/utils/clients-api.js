// Wrapper-uri pentru endpoint-urile `/api/v1/clients`.
//
// Fiecare funcție wrap-uiește `apiClient` (axios cu refresh-on-401) și
// returnează DOAR `response.data.data` (sau payload-ul direct, după caz) ca
// hook-urile să nu se ocupe de unwrapping. Erorile axios bubble-up neschimbate
// — caller-ul folosește `getBackendErrorMessage` din `clients-validation.js`
// pentru afișare.
//
// Toate funcțiile acceptă `signal` (AbortSignal) opțional, propagat la axios
// pentru cancellation la unmount sau filter change.

import { get, post, put, del } from './api-client';

const BASE_URL = '/api/v1/clients';

function buildQueryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.append(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}

export async function listClients({
  limit,
  offset,
  search,
  fiscalCodeType,
  anafVerified,
  signal,
} = {}) {
  const qs = buildQueryString({
    limit,
    offset,
    search,
    fiscalCodeType,
    anafVerified,
  });
  const response = await get(`${BASE_URL}${qs}`, { signal });
  // Backend răspunde `{ success: true, data: { rows, total, limit, offset } }`.
  return response.data.data;
}

export async function getClientById(id, { signal } = {}) {
  const response = await get(`${BASE_URL}/${id}`, { signal });
  return response.data.data;
}

export async function createClient(data) {
  const response = await post(BASE_URL, data);
  return response.data.data;
}

export async function updateClient(id, data) {
  const response = await put(`${BASE_URL}/${id}`, data);
  return response.data.data;
}

export async function deleteClient(id) {
  const response = await del(`${BASE_URL}/${id}`);
  return response.data.data;
}

export async function lookupCui(cui, { referenceDate, signal } = {}) {
  const body = { cui };
  if (referenceDate) body.referenceDate = referenceDate;
  const response = await post(`${BASE_URL}/lookup-by-cui`, body, { signal });
  return response.data.data;
}
