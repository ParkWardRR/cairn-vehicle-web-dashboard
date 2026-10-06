import { defineConfig } from 'vitest/config'

// The web acceptance suite: it talks to staged instances over HTTP, so it needs no Nuxt
// test environment and is not part of the default `vitest run` (see vitest.config.ts).
export default defineConfig({
  test: {
    include: ['tests/acceptance/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // describe blocks must run in file order: the coverage check at the end relies on it
    sequence: { concurrent: false },
    fileParallelism: false,
  },
})
