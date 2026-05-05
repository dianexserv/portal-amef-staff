// Configurație Vitest pentru backend (UNIT tests).
// Folosim CommonJS (module.exports) ca să fie consistent cu restul codului server.
// Vitest acceptă config în CJS (e încărcat de Vite via require fallback).
//
// Include glob: DOAR `src/**/*.test.js`. Integration tests din `tests/integration/**`
// au propriul config (`vitest.integration.config.js`) cu `singleFork: true` și
// `fileParallelism: false` — rulează SECVENȚIAL pentru că share-uiesc o singură
// DB Postgres reală (race condition observat pe main: auth.integration creează
// schema `amef_shared` în paralel cu clients.integration care o face DROP →
// „relation does not exist" intermitent). Vezi `vitest.integration.config.js`.
//
// Ca rezultat, `vitest run` (default) rulează unit tests în paralel (fast),
// iar `vitest run --config vitest.integration.config.js` rulează integration
// secvențial. CI orchestrează ambele apeluri.

module.exports = {
  test: {
    environment: 'node',
    // Globalele Vitest (describe, it, expect, vi) sunt expuse direct ca să evităm
    // `require('vitest')` în fișierele .test.js — Vitest 2.x este pur ESM și nu poate fi
    // importat via require dintr-un modul CJS. Codul aplicației rămâne CommonJS curat.
    globals: true,
    include: ['src/**/*.test.js'],
    exclude: ['node_modules/**', 'dist/**', 'coverage/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.js'],
      exclude: [
        'src/**/*.test.js',
        'src/**/*.integration.test.js',
        'src/db/migrations/**',
        'src/db/setup/**',
        // CLI thin wrapper — entry point invocat manual / din scripturi
        // de deploy; nu are logică de testat unitar. Validarea reală a
        // pipeline-ului de migrare e în migrate.test.js + migrate.integration.test.js.
        'src/db/migrate-cli.js',
        // Bootstrap entry — încarcă dotenv, pornește listener-ul HTTP,
        // wire SIGTERM. Logica de aplicare e în app.js (testat direct cu
        // Supertest); aici ar fi doar mocking de process.exit + listen.
        'src/server.js',
      ],
      // Praguri per folder din CLAUDE.md (Testing Rules).
      // Vitest verifică pragurile doar pentru fișierele care match-uiesc glob-ul;
      // dacă nu există fișiere care match-uiesc, pragul este sărit.
      thresholds: {
        'src/services/**': {
          lines: 80,
          functions: 80,
          branches: 70,
          statements: 80,
        },
        'src/middleware/**': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/routes/**': {
          lines: 70,
          functions: 70,
          branches: 60,
          statements: 70,
        },
      },
    },
  },
};
