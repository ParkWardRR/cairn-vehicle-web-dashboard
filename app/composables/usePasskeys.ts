import { startAuthentication, startRegistration } from '@simplewebauthn/browser'

// The browser half of the passkey endpoints under /api/auth.
export interface AuthSession {
  authenticated: boolean
  method: 'service' | 'tailnet' | 'passkey' | 'off' | null
  actor: string | null
  fresh: boolean
  passkeys: number
  can_enrol: boolean
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

  async function addPasskey(name: string, bootstrapCode?: string): Promise<{ signed_in: boolean }> {
    const o = await post<{ challengeId: string; options: any }>('/api/auth/register-options', bootstrapCode ? { bootstrapCode } : {})
    const response = await startRegistration({ optionsJSON: o.options })
    return post('/api/auth/register-verify', { challengeId: o.challengeId, response, name })
  }

  async function signOut(): Promise<void> {
    await post('/api/auth/logout')
    window.location.assign('/login')
  }

  return { signIn, addPasskey, signOut }
}
