// Teste pentru requireRole. Modul pur (no I/O), nu necesită stubEnv.

const requireRole = require('./require-role');
const { UnauthorizedError, ForbiddenError } = require('../errors');

describe('requireRole — validare argument', () => {
  it('aruncă sync la wire-up dacă allowedRoles nu e array', () => {
    expect(() => requireRole('tenant_admin')).toThrow(/array non-gol/);
    expect(() => requireRole(null)).toThrow(/array non-gol/);
    expect(() => requireRole()).toThrow(/array non-gol/);
  });

  it('aruncă pentru array gol', () => {
    expect(() => requireRole([])).toThrow(/array non-gol/);
  });
});

describe('requireRole — execuție', () => {
  it('req.user lipsă → next(UnauthorizedError) (nu Forbidden)', () => {
    const mw = requireRole(['tenant_admin']);
    const next = vi.fn();
    mw({}, {}, next);
    expect(next.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
  });

  it('rol nepermis → next(ForbiddenError) cu lista așteptată în mesaj', () => {
    const mw = requireRole(['tenant_admin', 'platform_operator']);
    const next = vi.fn();
    mw({ user: { role: 'tenant_user' } }, {}, next);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toContain('tenant_admin');
    expect(err.message).toContain('platform_operator');
  });

  it('rol în lista permisă → next() fără eroare', () => {
    const mw = requireRole(['tenant_admin']);
    const next = vi.fn();
    mw({ user: { role: 'tenant_admin' } }, {}, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('acceptă mai multe roluri în lista permisă', () => {
    const mw = requireRole(['tenant_admin', 'platform_operator']);
    const adminNext = vi.fn();
    const operatorNext = vi.fn();
    mw({ user: { role: 'tenant_admin' } }, {}, adminNext);
    mw({ user: { role: 'platform_operator' } }, {}, operatorNext);
    expect(adminNext).toHaveBeenCalledWith();
    expect(operatorNext).toHaveBeenCalledWith();
  });

  it('rol diferit ca string (case-sensitive) NU e match', () => {
    const mw = requireRole(['tenant_admin']);
    const next = vi.fn();
    mw({ user: { role: 'Tenant_Admin' } }, {}, next);
    expect(next.mock.calls[0][0]).toBeInstanceOf(ForbiddenError);
  });

  it('platform_operator NU e admin implicit (lista trebuie să-l includă)', () => {
    // Regression test pentru o convenție: platform_operator NU primește
    // automat drepturile de tenant_admin pe acțiuni „Configurare Tenant" —
    // route-ul trebuie să-l listeze explicit dacă vrea să-l permită.
    const mw = requireRole(['tenant_admin']);
    const next = vi.fn();
    mw({ user: { role: 'platform_operator' } }, {}, next);
    expect(next.mock.calls[0][0]).toBeInstanceOf(ForbiddenError);
  });
});
