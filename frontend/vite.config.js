import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Configurație Vite pentru frontend Portal AMEF Staff.
// Proxy `/api` către backend local (port 3001) ca să evităm CORS în dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
