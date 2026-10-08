import { browserSupportsWebAuthnAutofill, startAuthentication, startRegistration } from '@simplewebauthn/browser'

// The browser half of the passkey endpoints under /api/auth.
export interface AuthSession {
  authenticated: boolean
  method: 'service' | 'tailnet' | 'passkey' | 'off' | null
  actor: string | null
  fresh: boolean
  passkeys: number
  can_enrol: boolean
  on_tailnet: boolean
}

// Only a path on this site: never an address that would send the person elsewhere after sign-in.
export function safeNext(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'
}

export function errorText(e: any): string {
  const m = e?.data?.statusMessage ?? e?.statusMessage ?? ''
  if (e?.name === 'NotAllowedError') return 'The passkey prompt was cancelled or timed out.'
  if (m === 'reauth_required') return 'Please confirm with your passkey first.'
  return m || e?.message || 'Something went wrong.'
}

export function usePasskeys() {
  const post = <T>(url: string, body: unknown = {}) => $fetch<T>(url, { method: 'POST', body })

  async function signIn(): Promise<void> {
    const o = await post<{ challengeId: string; options: any }>('/api/auth/login-options')
    const response = await startAuthentication({ optionsJSON: o.options })
    await post('/api/auth/login-verify', { challengeId: o.challengeId, response })
  }

  // Passkey autofill ("conditional UI"): the saved passkey appears over a text field (on an
  // iPhone, in the keyboard bar), and one tap and Face ID signs in. It stays pending until the
  // person picks one, and is cancelled by any other passkey prompt, so a button still works.
  async function autofillAvailable(): Promise<boolean> {
    try { return await browserSupportsWebAuthnAutofill() } catch { return false }
  }

  async function signInWithAutofill(): Promise<void> {
    const o = await post<{ challengeId: string; options: any }>('/api/auth/login-options', { discoverable: true })
    const response = await startAuthentication({ optionsJSON: o.options, useBrowserAutofill: true })
    await post('/api/auth/login-verify', { challengeId: o.challengeId, response })
  }

  async function addPasskey(name: string, bootstrapCode?: string): Promise<{ signed_in: boolean }> {
    const o = await post<{ challengeId: string; options: any }>('/api/auth/register-options', bootstrapCode ? { bootstrapCode } : {})
    const response = await startRegistration({ optionsJSON: o.options })
    return post('/api/auth/register-verify', { challengeId: o.challengeId, response, name })
  }

  async function signOut(): Promise<void> {
    await post('/api/auth/logout')
    window.location.assign('/login')
  }

  return { signIn, signInWithAutofill, autofillAvailable, addPasskey, signOut }
}
