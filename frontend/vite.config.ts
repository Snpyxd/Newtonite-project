import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser talks to /api; Vite forwards it to the backend (no CORS needed).
const target = process.env.VITE_API_TARGET ?? 'http://localhost:3000';
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target, rewrite: (p) => p.replace(/^\/api/, '') } } },
});
