import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During `npm run dev` the React app runs on Vite's port and proxies API
// calls to the Express server on PORT (default 8088). In production the
// Express server serves the built files from client/dist so no proxy is used.
const API_TARGET = `http://localhost:${process.env.PORT || 8088}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
