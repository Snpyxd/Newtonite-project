import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/env.ts'],
    fileParallelism: false, // all test files share one Postgres database
    testTimeout: 20000,
  },
});
