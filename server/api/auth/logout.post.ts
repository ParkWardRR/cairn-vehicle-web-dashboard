export default defineEventHandler((event) => {
  const token = getCookie(event, SESSION_COOKIE)
  if (token) {
    audit(event, 'logout')
    authStore().endSession(token)
  }
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
  return { ok: true }
})
