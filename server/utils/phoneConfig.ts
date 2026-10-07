import { readFileSync } from 'node:fs'

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
  const missing: string[] = []
  const base = (c.cairnLocalUrl as string) || ''
  if (!base) missing.push('NUXT_CAIRN_LOCAL_URL')
  const serverUrl = (c.phoneSetupUrl as string) || ''
  if (!serverUrl) missing.push('NUXT_PHONE_SETUP_URL')
  const tokenFile = (c.cairnLocalTokenFile as string) || ''
  let token = ''
  if (!tokenFile) {
    missing.push('NUXT_CAIRN_LOCAL_TOKEN_FILE')
  } else {
    try {
      token = readFileSync(tokenFile, 'utf8').trim()
    } catch {
      missing.push('a readable NUXT_CAIRN_LOCAL_TOKEN_FILE')
    }
  }
  if (missing.length) return { ok: false, missing }
  return {
    ok: true,
    config: { base, token, serverUrl, tailnetUrl: (c.phoneSetupTailnetUrl as string) || '', caFile: (c.phoneSetupCaFile as string) || '' },
  }
}
