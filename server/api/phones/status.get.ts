// Whether "Add a phone" is set up, and if not what is missing. Names only, never a value.
export default defineEventHandler((event) => {
  requireHuman(event)
  const r = phoneSetupConfig()
  return r.ok
    ? { configured: true, server: new URL(r.config.serverUrl).host, tailnet: r.config.tailnetUrl ? new URL(r.config.tailnetUrl).host : null }
    : { configured: false, missing: r.missing }
})
