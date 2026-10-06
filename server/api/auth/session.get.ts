import type { Identity } from '../../utils/auth'

// Who the caller is, and what a sign-in screen needs to offer. Public by design: it says
// nothing about anyone but the caller.
export default defineEventHandler(async (event) => {
  if (authMode() === 'off') return { authenticated: true, method: 'off', actor: null, fresh: true, passkeys: 0, can_enrol: false, auth: 'off' }
  const id = event.context.cairnIdentity as Identity | undefined
  const passkeys = authStore().credentials().length
  return {
    authenticated: Boolean(id),
    method: id?.method ?? null,
    actor: id && id.method !== 'service' ? id.actor : null,
    fresh: id?.fresh ?? false,
    passkeys,
    // With no passkey yet, a first one can be created from an allowlisted Tailnet device or
    // with the one-time code on the host.
    can_enrol: passkeys === 0,
    auth: 'required',
  }
})
