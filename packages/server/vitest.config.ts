import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globalSetup: ['./src/db/test-global-setup.ts'],
    // Database tests run whole fixture jobs; on a busy machine several of them pass 30 s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 120_000,
  },
});
