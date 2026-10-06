import { csrfRefusal, isApiPath, isPublicPath, SAFE_METHODS } from '../utils/authPolicy'

// Every request has an identity or is refused. This runs before every route and page:
//   - a request from another origin that would change something is refused (CSRF), even from a
//     Tailnet address, because that identity belongs to the machine and not to the page
//   - routes under /api/auth, the login page and static bundles are public
//   - everything else needs a service token (read-only), an allowlisted Tailnet device, or a
//     passkey session; pages redirect to /login, the API answers 401
export default defineEventHandler(async (event) => {
  if (authMode() === 'off') return

  const path = getRequestURL(event).pathname
  const method = event.method

  const refusal = csrfRefusal(method, { get: n => getRequestHeader(event, n as any) })
  if (refusal) throw createError({ statusCode: 403, statusMessage: 'cross-site request refused' })

  if (path.startsWith('/_nuxt/')) return

  const id = await resolveIdentity(event)
  if (id) event.context.cairnIdentity = id
  if (isPublicPath(path)) return

  if (!id) {
    if (isApiPath(path)) throw createError({ statusCode: 401, statusMessage: 'authentication required' })
    return sendRedirect(event, `/login?next=${encodeURIComponent(path)}`, 302)
  }
  if (id.readOnly && !SAFE_METHODS.has(method.toUpperCase())) {
    throw createError({ statusCode: 403, statusMessage: 'this credential is read-only' })
  }
})
