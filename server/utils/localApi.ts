import { readFileSync } from 'node:fs'

// The loopback local API of cairn-server: the one the dashboard asks for vehicle names, and for
// the phone administration. It demands a shared token; who may cause a call is decided by the
// route (a fresh passkey for anything that changes state), never here.
export function localApi(): { base: string, token: string } | { missing: string[] } {
  const c = useRuntimeConfig()
  const missing: string[] = []
  const base = ((c.cairnLocalUrl as string) || '').replace(/\/$/, '')
  if (!base) missing.push('NUXT_CAIRN_LOCAL_URL')
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
  return missing.length ? { missing } : { base, token }
}

export class LocalApiUnavailable extends Error {
  constructor(readonly missing: string[]) {
    super(`phone administration is not set up: ${missing.join(', ')}`)
  }
}

function need(): { base: string, token: string } {
  const api = localApi()
  if ('missing' in api) throw new LocalApiUnavailable(api.missing)
  return api
}

export async function localGet<T>(path: string): Promise<T> {
  const { base, token } = need()
  return await $fetch<T>(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 })
}

export async function localPost<T>(path: string, body: unknown): Promise<T> {
  const { base, token } = need()
  return await $fetch<T>(`${base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body, timeout: 5000 })
}
