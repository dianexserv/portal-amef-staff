// Teste pentru not-found-handler. Modul pur (no I/O), nu necesită stubEnv.

const notFoundHandler = require('./not-found-handler');
const { NotFoundError } = require('../errors');

describe('notFoundHandler', () => {
  it('apelează next(NotFoundError) cu metoda și URL-ul în mesaj', () => {
    const req = { method: 'GET', originalUrl: '/api/v1/clients/42' };
    const next = vi.fn();
    notFoundHandler(req, {}, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toContain('GET');
    expect(err.message).toContain('/api/v1/clients/42');
  });

  it('funcționează și pentru POST + URL cu query string', () => {
    const req = { method: 'POST', originalUrl: '/foo?bar=1' };
    const next = vi.fn();
    notFoundHandler(req, {}, next);

    expect(next.mock.calls[0][0].message).toContain('POST');
    expect(next.mock.calls[0][0].message).toContain('/foo?bar=1');
  });
});
