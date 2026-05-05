// Configurație Vitest pentru backend.
// Folosim CommonJS (module.exports) ca să fie consistent cu restul codului server.
// Vitest acceptă config în CJS (e încărcat de Vite via require fallback).

module.exports = {
  test: {
    environment: 'node',
    // Globalele Vitest (describe, it, expect, vi) sunt expuse direct ca să evităm
    // `require('vitest')` în fișierele .test.js — Vitest 2.x este pur ESM și nu poate fi
    // importat via require dintr-un modul CJS. Codul aplicației rămâne CommonJS curat.
    globals: true,
    include: ['src/**/*.test.js', 'tests/**/*.test.js'],
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
