// Smoke test minim — verifică doar că Vitest rulează corect.
// Va fi înlocuit cu teste reale începând cu Stage 3 (pool.test.js, logger.test.js).
//
// Globalele `describe`, `it`, `expect` vin din Vitest cu `globals: true` în vitest.config.js
// (Vitest 2.x este ESM-only și nu poate fi importat via require dintr-un modul CJS).

describe('smoke', () => {
  it('vitest works', () => {
    expect(1).toBe(1);
  });
});
