import { defineVitestConfig } from '@nuxt/test-utils/config'
import { configDefaults } from 'vitest/config'

export default defineVitestConfig({
  test: {
    environment: 'happy-dom',
    // needs staged instances: `npm run test:acceptance` (tests/staging.sh)
    exclude: [...configDefaults.exclude, 'tests/acceptance/**'],
  },
})
