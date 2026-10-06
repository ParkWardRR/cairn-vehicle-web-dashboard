// On start: say how the web layer is protected, and while no passkey exists make sure the
// one-time enrolment code is on disk (never in the log, which others may read).
export default defineNitroPlugin(() => {
  if (process.env.VITEST) return
  if (authMode() === 'off') {
    console.warn('[auth] NUXT_AUTH_MODE=off: every route is open. Never do this on a reachable host.')
    return
  }
  const store = authStore()
  const c = useRuntimeConfig()
  const n = store.credentials().length
  const tailnet = String(c.authTailnetUsers || '').split(',').filter(s => s.trim()).length
  console.log(`[auth] required; ${n} passkey${n === 1 ? '' : 's'}, ${tailnet} Tailnet login${tailnet === 1 ? '' : 's'} allowed`)
  store.serviceToken(c.authServiceToken as string)
  if (store.bootstrapCode(c.authBootstrapCode as string)) {
    console.log(`[auth] no passkey yet: enrol one at /login from an allowed Tailnet device, or with the code in ${store.dir}/bootstrap-code`)
  }
})
