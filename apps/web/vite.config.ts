import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.HOLIDAY_API_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: apiTarget, changeOrigin: false },
      '/internal': { target: apiTarget, changeOrigin: false },
      '/s/': { target: apiTarget, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    // Stylesheets imported with `?raw` keep their text, so tests can check contrast and motion.
    css: { include: [/\.css\?raw$/] },
  },
});
