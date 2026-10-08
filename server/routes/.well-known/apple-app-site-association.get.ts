// Tells iOS which apps may use this site's passkeys (Associated Domains, `webcredentials`). The
// app signs in and registers with the same passkeys Safari uses. Public by necessity: iOS fetches
// it with no session. Empty until NUXT_AUTH_APPLE_APPS names an app (TEAMID.bundle.id).
export default defineEventHandler((event) => {
  const apps = appleAppIds(useRuntimeConfig().authAppleApps as string)
  if (!apps.length) throw createError({ statusCode: 404, statusMessage: 'not configured' })
  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=300')
  return { webcredentials: { apps } }
})
