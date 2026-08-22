import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Spec §12.1: the suite must never read the developer's config file or
    // inherit their API keys. This runs before any test module is imported.
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
})
