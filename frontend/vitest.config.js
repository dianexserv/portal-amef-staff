import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Configurație Vitest pentru frontend (jsdom + React Testing Library).
// `globals: true` permite describe/it/expect fără import explicit (stilul Jest).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    include: ['src/**/*.test.{js,jsx}', 'tests/**/*.test.{js,jsx}'],
    exclude: ['node_modules/**', 'dist/**', 'coverage/**'],
    // Permite rularea fără teste (până când avem componente reale).
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{js,jsx}'],
      exclude: [
        'src/**/*.test.{js,jsx}',
        'src/main.jsx',
        // `firebase.js` e doar un wrapper de inițializare care apelează
        // `initializeApp` cu config din `import.meta.env`. Nu are logică de
        // testat unitar; în testele consumatorilor mock-uim întregul modul.
        'src/firebase.js',
      ],
      // Praguri din CLAUDE.md — aplicate doar fișierelor care match-uiesc glob-ul.
      thresholds: {
        'src/components/**': {
          lines: 70,
          functions: 70,
          branches: 60,
          statements: 70,
        },
        'src/hooks/**': {
          lines: 70,
          functions: 70,
          branches: 60,
          statements: 70,
        },
        'src/pages/**': {
          lines: 70,
          functions: 70,
          branches: 60,
          statements: 70,
        },
        'src/contexts/**': {
          lines: 70,
          functions: 70,
          branches: 60,
          statements: 70,
        },
        'src/utils/**': {
          lines: 70,
          functions: 70,
          branches: 60,
          statements: 70,
        },
      },
    },
  },
});
