import type { Identity } from '../../utils/auth'
import { isTailnetAddress } from '../../utils/authPolicy'

// Who the caller is, and what a sign-in screen needs to offer. Public by design: it says
// nothing about anyone but the caller.
export default defineEventHandler(async (event) => {
  if (authMode() === 'off') return { authenticated: true, method: 'off', actor: null, fresh: true, passkeys: 0, can_enrol: false, on_tailnet: false, auth: 'off' }
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
    // Whether this request arrives from a tailnet address, so the sign-in screen can explain why a
    // device is or is not recognised. A fact about the caller's own address, nothing about anyone else.
    on_tailnet: isTailnetAddress(requestIp(event)),
    auth: 'required',
  }
})
