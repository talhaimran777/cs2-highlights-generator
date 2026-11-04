import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  // PORT / WEB_PORT run a second copy beside one already running
  server: { port: Number(process.env.WEB_PORT ?? 5173), proxy: { '/api': `http://127.0.0.1:${process.env.PORT ?? 5174}` } },
});
