// Configurație Vitest pentru INTEGRATION tests.
//
// Extinde `vitest.config.js` cu setări de execuție secvențială. Motivație:
// integration tests se conectează la o singură DB Postgres reală (CI service
// container; local Cloud SQL Proxy). Fiecare fișier integration își gestionează
// propriul ciclu de viață al schemei (`DROP SCHEMA ... CASCADE` în beforeAll
// + `applyMigrations` + seed + cleanup). Dacă vitest paralelizează fișierele,
// se manifestă race condition-uri tipice:
//   - auth.integration creează `amef_shared` și inserează tenants;
//   - clients.integration între timp face DROP SCHEMA `amef_shared` → toate
//     SELECT-urile auth-ului eșuează cu „relation does not exist".
//
// Bug observat după merge-ul Stage 5d pe `main` (CI roșu intermitent).
//
// Setări cheie:
//   - `include` limitat la `tests/integration/**` (NU mai conține src/**)
//   - `poolOptions.forks.singleFork: true` — toate testele rulează într-un
//     singur proces fork (fără paralelism între workeri).
//   - `fileParallelism: false` — fișierele rulează secvențial, NU concurent
//     în același worker (defense-in-depth peste singleFork).
//   - timeout pe test mărit la 30s — 3 retries ANAF cu backoff exponențial
//     se încadrează ușor, plus DB-ul real are latență variabilă în CI.
//
// CommonJS pur: NU folosim `require('vitest/config')` (vitest e ESM-only,
// nu poate fi importat din CJS). Facem merge-ul manual prin spread — mai
// puțin elegant decât `mergeConfig`, dar consistent cu vitest.config.js
// și fără probleme de interop.

const baseConfig = require('./vitest.config.js');

module.exports = {
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['tests/integration/**/*.test.js'],
    poolOptions: {
      ...(baseConfig.test.poolOptions || {}),
      forks: {
        ...((baseConfig.test.poolOptions || {}).forks || {}),
        singleFork: true,
      },
    },
    fileParallelism: false,
    testTimeout: 30000,
  },
};
