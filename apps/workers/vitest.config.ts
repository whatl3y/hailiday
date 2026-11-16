import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globalSetup: ['./src/test-global-setup.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    teardownTimeout: 120_000,
  },
});
