// Teste pentru wrapper-urile clients-api.js. Mock-uim api-client (get/post/put/del)
// la nivel de modul ca să nu lovim rețeaua și să verificăm forma cererilor.

const { getMock, postMock, putMock, delMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  delMock: vi.fn(),
}));

vi.mock('./api-client', () => ({
  get: getMock,
  post: postMock,
  put: putMock,
  del: delMock,
}));

import {
  listClients,
  getClientById,
  createClient,
  updateClient,
  deleteClient,
  lookupCui,
} from './clients-api';

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  putMock.mockReset();
  delMock.mockReset();
});

describe('listClients', () => {
  it('construiește query string-ul cu filtrele și întoarce data.data', async () => {
    getMock.mockResolvedValue({
      data: {
        success: true,
        data: { rows: [{ id: 1 }], total: 1, limit: 10, offset: 0 },
      },
    });

    const signal = new AbortController().signal;
    const result = await listClients({
      limit: 10,
      offset: 0,
      search: 'Acme',
      fiscalCodeType: 'CUI',
      anafVerified: true,
      signal,
    });

    expect(getMock).toHaveBeenCalledTimes(1);
    const [url, config] = getMock.mock.calls[0];
    expect(url).toBe(
      '/api/v1/clients?limit=10&offset=0&search=Acme&fiscalCodeType=CUI&anafVerified=true'
    );
    expect(config).toEqual({ signal });
    expect(result.rows).toEqual([{ id: 1 }]);
  });

  it('omite parametrii undefined/null/empty din query string', async () => {
    getMock.mockResolvedValue({
      data: { data: { rows: [], total: 0, limit: 20, offset: 0 } },
    });

    await listClients({
      limit: 20,
      offset: 0,
      search: '',
      fiscalCodeType: undefined,
      anafVerified: false,
    });

    const url = getMock.mock.calls[0][0];
    // search='' și fiscalCodeType=undefined excluse; anafVerified=false PĂSTRAT
    // (boolean false e o valoare validă de filtru — neverificați).
    expect(url).toBe('/api/v1/clients?limit=20&offset=0&anafVerified=false');
  });

  it('fără argumente întoarce listă fără query string', async () => {
    getMock.mockResolvedValue({
      data: { data: { rows: [], total: 0, limit: 50, offset: 0 } },
    });
    await listClients();
    expect(getMock.mock.calls[0][0]).toBe('/api/v1/clients');
  });
});

describe('getClientById', () => {
  it('GET la /clients/:id și întoarce data.data', async () => {
    getMock.mockResolvedValue({ data: { data: { id: 42, company_name: 'X' } } });
    const result = await getClientById(42);
    expect(getMock).toHaveBeenCalledWith('/api/v1/clients/42', { signal: undefined });
    expect(result).toEqual({ id: 42, company_name: 'X' });
  });
});

describe('createClient', () => {
  it('POST la /clients cu body-ul transmis', async () => {
    postMock.mockResolvedValue({ data: { data: { id: 7 } } });
    const body = { company_name: 'Test SRL', fiscal_code: 'RO123' };
    const result = await createClient(body);
    expect(postMock).toHaveBeenCalledWith('/api/v1/clients', body);
    expect(result).toEqual({ id: 7 });
  });
});

describe('updateClient', () => {
  it('PUT la /clients/:id cu body-ul parțial', async () => {
    putMock.mockResolvedValue({ data: { data: { id: 7, company_name: 'New' } } });
    const result = await updateClient(7, { company_name: 'New' });
    expect(putMock).toHaveBeenCalledWith('/api/v1/clients/7', { company_name: 'New' });
    expect(result.company_name).toBe('New');
  });
});

describe('deleteClient', () => {
  it('DELETE la /clients/:id', async () => {
    delMock.mockResolvedValue({ data: { data: { id: 7, deleted_at: '2026-05-06' } } });
    const result = await deleteClient(7);
    expect(delMock).toHaveBeenCalledWith('/api/v1/clients/7');
    expect(result.id).toBe(7);
  });
});

describe('lookupCui', () => {
  it('POST la /clients/lookup-by-cui cu cui și referenceDate', async () => {
    postMock.mockResolvedValue({
      data: {
        data: { cui: '1234567', denumire: 'Test SRL', stale: false },
      },
    });
    const signal = new AbortController().signal;
    const result = await lookupCui('RO1234567', {
      referenceDate: '2026-01-15',
      signal,
    });
    expect(postMock).toHaveBeenCalledWith(
      '/api/v1/clients/lookup-by-cui',
      { cui: 'RO1234567', referenceDate: '2026-01-15' },
      { signal }
    );
    expect(result.denumire).toBe('Test SRL');
  });

  it('fără referenceDate trimite doar cui-ul', async () => {
    postMock.mockResolvedValue({ data: { data: { cui: '1' } } });
    await lookupCui(1);
    expect(postMock.mock.calls[0][1]).toEqual({ cui: 1 });
  });
});

describe('propagare erori api-client', () => {
  it('eroarea axios bubble-up neschimbată', async () => {
    const apiErr = new Error('boom');
    apiErr.response = { status: 409, data: { code: 'FISCAL_CODE_DUPLICATE' } };
    postMock.mockRejectedValue(apiErr);

    await expect(createClient({ x: 1 })).rejects.toBe(apiErr);
  });
});
