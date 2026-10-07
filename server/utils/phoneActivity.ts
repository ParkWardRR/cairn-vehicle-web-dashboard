// What the page shows as "activity": the server's audit of the app API, and what people did on this
// dashboard, in plain words. Everything here is pure so it can be tested without a server.

export interface ServerAudit {
  ts: string
  actor_type: string
  client_id?: string
  transport?: string
  route: string
  target_id?: string
  status: number
  reason?: string
}

export interface DashboardAudit { ts: number, actor: string, method: string, action: string, target: string | null }

export type ActivityKind = 'phone' | 'trip' | 'history' | 'security'
export type ActivityTone = 'ok' | 'info' | 'warn'

export interface ActivityEvent {
  at: number
  kind: ActivityKind
  tone: ActivityTone
  text: string
  detail?: string
  via?: string
}

export interface PhoneNames { nameOf(id: string | undefined): string }

const ROUTES_OF_NO_INTEREST = new Set([
  'GET /v1/health',
  'GET /v1/devices',
  'GET /v1/clients',
  'POST /v1/sync/push',
  'GET /v1/sync/pull',
  'POST /v1/sync/ack',
  'POST /v1/auth/token',
  'GET /v1/relay/bundles/{id}/receipt',
])

const short = (id?: string) => (id ? `${id.slice(0, 8)}…${id.slice(-4)}` : '')

export function via(transport?: string): string | undefined {
  switch (transport) {
    case 'lan': return 'home network'
    case 'tailnet': return 'Tailnet'
    case 'loopback': return 'this server'
    default: return transport || undefined
  }
}

// A refused request names its reason as a short code (`signature_does_not_verify`); say it in words.
export function reasonText(reason?: string): string | undefined {
  if (!reason) return undefined
  const known: Record<string, string> = {
    signature_does_not_verify: 'the phone’s signature did not match its registered key',
    bad_manifest_signature: 'the dongle’s signature on the trip did not verify',
    unknown_client: 'an unknown phone',
    revoked: 'the phone was revoked',
    scope: 'outside what this phone may see',
    timestamp_skew: 'the phone’s clock is off',
  }
  return known[reason] ?? reason.replaceAll('_', ' ')
}

// One server audit row as an event, or null when it is routine noise (health checks, syncs that worked).
export function describeServerEntry(e: ServerAudit, names: PhoneNames): ActivityEvent | null {
  const at = Date.parse(e.ts)
  if (!Number.isFinite(at) || ROUTES_OF_NO_INTEREST.has(e.route) && e.status < 400) return null
  const who = e.client_id ? names.nameOf(e.client_id) : 'Someone'
  const base = { at, via: via(e.transport) }

  if (e.status >= 400) {
    // A request that failed to sign in is `anonymous`; name nothing we could not verify.
    const why = reasonText(e.reason)
    const what = e.route.replace(/^(GET|POST|PUT|DELETE) /, '').replace('/v1/', '').replace(/\/\{[^}]+\}/g, '')
    if (e.route === 'POST /v1/enroll/app') {
      return { ...base, kind: 'security', tone: 'warn', text: 'A phone could not enrol', detail: why ?? 'the invitation was not accepted' }
    }
    if (e.status === 401 || e.actor_type === 'anonymous') {
      return { ...base, kind: 'security', tone: 'warn', text: `Refused a request that was not signed in (${what})`, detail: why }
    }
    return { ...base, kind: e.route.includes('relay') ? 'trip' : 'security', tone: 'warn', text: `${who} was refused (${what})`, detail: why ?? `status ${e.status}` }
  }

  switch (e.route) {
    case 'POST /v1/enroll/app':
      return { ...base, kind: 'phone', tone: 'ok', text: `${names.nameOf(e.target_id)} enrolled` }
    case 'POST /v1/clients/{id}/revoke':
      return { ...base, kind: 'phone', tone: 'warn', text: `${who} revoked ${names.nameOf(e.target_id)}` }
    case 'POST /v1/relay/bundles/{id}/commit':
      return { ...base, kind: 'trip', tone: 'ok', text: `${who} carried a trip to the server`, detail: e.target_id ? `trip ${short(e.target_id)}` : undefined }
    case 'GET /v1/snapshot':
      return { ...base, kind: 'history', tone: 'info', text: e.status === 304 ? `${who} checked for new trips` : `${who} refreshed its trip history` }
    default:
      // Offers and chunk uploads are the steps inside a trip being carried; the commit says it all.
      return null
  }
}

// The dashboard's own audit trail, for the actions that concern phones.
export function describeDashboardEntry(r: DashboardAudit): ActivityEvent | null {
  if (r.action === 'phone-invite') {
    return { at: r.ts, kind: 'phone', tone: 'info', text: `${r.actor} made an invitation${r.target ? ` for ${r.target}` : ''}`, via: 'dashboard' }
  }
  if (r.action === 'phone-revoked') {
    return { at: r.ts, kind: 'phone', tone: 'warn', text: `${r.actor} revoked ${r.target ?? 'a phone'}`, via: 'dashboard' }
  }
  return null
}

// Newest first, the two sources woven together, capped.
export function mergeActivity(server: ServerAudit[], dashboard: DashboardAudit[], names: PhoneNames, limit = 150): ActivityEvent[] {
  const events: ActivityEvent[] = []
  for (const e of server) {
    const d = describeServerEntry(e, names)
    if (d) events.push(d)
  }
  for (const r of dashboard) {
    const d = describeDashboardEntry(r)
    if (d) events.push(d)
  }
  return events.sort((a, b) => b.at - a.at).slice(0, limit)
}

export interface LocalClient {
  id: string
  name: string
  role: string
  vehicles: string[]
  key_id: string
  status: string
  enrolled_at: string
  revoked_at?: string
  revoked_reason?: string
  last_seen_at?: string
  last_transport?: string
}

export function phoneNames(clients: LocalClient[]): PhoneNames {
  const byId = new Map(clients.map(c => [c.id, c.name?.trim() || `Phone ${c.id.slice(0, 8)}`]))
  return { nameOf: id => (id ? byId.get(id) ?? `a phone (${short(id)})` : 'Someone') }
}

// The phones as the page lists them: working ones first, most recently used first.
export function presentPhones(clients: LocalClient[]) {
  const time = (s?: string) => (s && !s.startsWith('0001') ? Date.parse(s) : 0)
  return clients
    .map(c => ({
      id: c.id,
      name: c.name?.trim() || `Phone ${c.id.slice(0, 8)}`,
      role: c.role,
      reach: c.vehicles?.includes('*') ? 'every car' : `${c.vehicles?.length ?? 0} car${c.vehicles?.length === 1 ? '' : 's'}`,
      active: c.status === 'active',
      status: c.status,
      key_id: c.key_id,
      enrolled_at: time(c.enrolled_at) || null,
      revoked_at: time(c.revoked_at) || null,
      revoked_reason: c.revoked_reason || null,
      last_seen_at: time(c.last_seen_at) || null,
      last_via: via(c.last_transport) ?? null,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0) || (b.enrolled_at ?? 0) - (a.enrolled_at ?? 0))
}
