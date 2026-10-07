export interface PhoneSetupConfig {
  base: string
  token: string
  serverUrl: string
  tailnetUrl: string
  caFile: string
}

// What "Add a phone" needs, or why it cannot work yet. The token is read from a file on each use
// (the same file cairn-server reads), so it is never copied into another environment file.
export function phoneSetupConfig(): { ok: true, config: PhoneSetupConfig } | { ok: false, missing: string[] } {
  const c = useRuntimeConfig()
  const api = localApi()
  const missing = 'missing' in api ? [...api.missing] : []
  const serverUrl = (c.phoneSetupUrl as string) || ''
  if (!serverUrl) missing.push('NUXT_PHONE_SETUP_URL')
  if (missing.length || 'missing' in api) return { ok: false, missing }
  return {
    ok: true,
    config: { base: api.base, token: api.token, serverUrl, tailnetUrl: (c.phoneSetupTailnetUrl as string) || '', caFile: (c.phoneSetupCaFile as string) || '' },
  }
}
