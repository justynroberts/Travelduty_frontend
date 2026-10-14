import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5317,
    proxy: { '/api': process.env.GATEWAY_URL ?? 'http://localhost:8080' },
  },
});
