// Teste pentru helper-ul de județe. Modul pur (no I/O) — testăm direct.

const {
  JUDET_COD,
  JUDET_COD_REVERSE,
  normalizeJudetCod,
  prettyJudetName,
} = require('./judete-romania');

describe('JUDET_COD / JUDET_COD_REVERSE', () => {
  it('conține 42 intrări (41 județe + București)', () => {
    expect(Object.keys(JUDET_COD)).toHaveLength(42);
    expect(Object.keys(JUDET_COD_REVERSE)).toHaveLength(42);
  });

  it('REVERSE e inversul lui FORWARD pentru fiecare intrare', () => {
    for (const [name, code] of Object.entries(JUDET_COD)) {
      expect(JUDET_COD_REVERSE[code]).toBe(name);
    }
  });

  it('mapping-uri sunt înghețate (Object.frozen — runtime safety)', () => {
    expect(Object.isFrozen(JUDET_COD)).toBe(true);
    expect(Object.isFrozen(JUDET_COD_REVERSE)).toBe(true);
  });
});

describe('normalizeJudetCod', () => {
  it('denumire simplă → cod', () => {
    expect(normalizeJudetCod('Timis')).toBe('TM');
  });

  it('cod direct → cod (uppercase)', () => {
    expect(normalizeJudetCod('TM')).toBe('TM');
  });

  it('case insensitive pe denumire', () => {
    expect(normalizeJudetCod('timis')).toBe('TM');
    expect(normalizeJudetCod('TIMIS')).toBe('TM');
  });

  it('case insensitive pe cod', () => {
    expect(normalizeJudetCod('cj')).toBe('CJ');
    expect(normalizeJudetCod('Cj')).toBe('CJ');
  });

  it('București ca exemplu de cod cu o singură literă', () => {
    expect(normalizeJudetCod('Bucuresti')).toBe('B');
    expect(normalizeJudetCod('B')).toBe('B');
  });

  it('input gol → string gol (NU aruncă)', () => {
    expect(normalizeJudetCod('')).toBe('');
    expect(normalizeJudetCod('   ')).toBe('');
    expect(normalizeJudetCod(undefined)).toBe('');
    expect(normalizeJudetCod(null)).toBe('');
  });

  it('input necunoscut → string gol', () => {
    expect(normalizeJudetCod('XYZ')).toBe('');
    expect(normalizeJudetCod('Texas')).toBe('');
  });
});

describe('prettyJudetName', () => {
  it('cod cunoscut → denumire prietenoasă', () => {
    expect(prettyJudetName('B')).toBe('Bucuresti');
    expect(prettyJudetName('CJ')).toBe('Cluj');
    expect(prettyJudetName('TM')).toBe('Timis');
  });

  it('case insensitive', () => {
    expect(prettyJudetName('cj')).toBe('Cluj');
  });

  it('cod necunoscut → returnează input-ul uppercase (defensive fallback)', () => {
    expect(prettyJudetName('XX')).toBe('XX');
  });

  it('input gol/null → string gol', () => {
    expect(prettyJudetName('')).toBe('');
    expect(prettyJudetName(null)).toBe('');
    expect(prettyJudetName(undefined)).toBe('');
  });
});
