import { safeNext } from '~/composables/usePasskeys'

// A 401 from any data call means the session is gone: go to the sign-in page, and come back here
// afterwards. Calls under /api/auth answer for themselves (a wrong passkey, a re-prompt).
export default defineNuxtPlugin(() => {
  globalThis.$fetch = $fetch.create({
    onResponseError({ request, response }) {
      const url = String(typeof request === 'string' ? request : (request as Request).url)
      if (response.status !== 401 || url.includes('/api/auth/')) return
      if (window.location.pathname === '/login') return
      window.location.assign(`/login?next=${encodeURIComponent(safeNext(window.location.pathname + window.location.search))}`)
    },
  }) as typeof $fetch
})
