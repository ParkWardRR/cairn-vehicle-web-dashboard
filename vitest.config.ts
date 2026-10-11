import { defineVitestConfig } from '@nuxt/test-utils/config'
import { configDefaults } from 'vitest/config'

export default defineVitestConfig({
  test: {
    environment: 'happy-dom',
    // needs staged instances: `npm run test:acceptance` (tests/staging.sh)
    // needs the deployed host and a session: `npm run test:live` (tests/live/README.md)
    exclude: [...configDefaults.exclude, 'tests/acceptance/**', 'tests/live/**', '.contracts/**', '.staging/**'],
  },
})
