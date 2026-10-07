// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  groupRepeats, describeDashboardEntry, describeServerEntry, mergeActivity, phoneNames, presentPhones, reasonText,
  type LocalClient, type ServerAudit,
} from '../server/utils/phoneActivity'

const SAM = '01a1172088447a50825cbda5d218cd9a'
const ADMIN = '01a111e82040716d88da70b93a6b55d8'
const clients: LocalClient[] = [
  { id: SAM, name: "Sam's iPhone", role: 'user', vehicles: ['*'], key_id: 'k1', status: 'active', enrolled_at: '2026-10-07T16:09:30Z', last_seen_at: '2026-10-07T17:00:00Z', last_transport: 'lan' },
  { id: ADMIN, name: 'cairn-phone (Mac)', role: 'user', vehicles: ['*'], key_id: 'k2', status: 'active', enrolled_at: '2026-10-07T01:00:00Z', last_seen_at: '2026-10-07T01:25:24Z', last_transport: 'lan' },
  { id: 'ff'.repeat(16), name: 'Old phone', role: 'user', vehicles: ['a', 'b'], key_id: 'k3', status: 'revoked', enrolled_at: '2026-10-05T00:00:00Z', revoked_at: '2026-10-06T00:00:00Z', revoked_reason: 'lost it (passkey)', last_seen_at: '0001-01-01T00:00:00Z' },
]
const names = phoneNames(clients)
const row = (o: Partial<ServerAudit>): ServerAudit => ({ ts: '2026-10-07T16:30:00Z', actor_type: 'app', route: 'GET /v1/snapshot', status: 200, ...o })

describe('describeServerEntry', () => {
  it('says a phone enrolled, by the name it enrolled under', () => {
    const e = describeServerEntry(row({ route: 'POST /v1/enroll/app', actor_type: 'anonymous', status: 201, target_id: SAM, transport: 'lan' }), names)!
    expect(e).toMatchObject({ kind: 'phone', tone: 'ok', text: "Sam's iPhone enrolled", via: 'home network' })
  })

  it('says a trip was carried, and by whom, and which trip', () => {
    const e = describeServerEntry(row({ route: 'POST /v1/relay/bundles/{id}/commit', client_id: ADMIN, target_id: '00000000000005891a66275bacca2cf3' }), names)!
    expect(e).toMatchObject({ kind: 'trip', tone: 'ok', text: 'cairn-phone (Mac) carried a trip to the server', detail: 'trip 00000000…2cf3' })
  })

  it('says who revoked whom', () => {
    const e = describeServerEntry(row({ route: 'POST /v1/clients/{id}/revoke', client_id: ADMIN, target_id: SAM }), names)!
    expect(e).toMatchObject({ kind: 'phone', tone: 'warn', text: "cairn-phone (Mac) revoked Sam's iPhone" })
  })

  it('surfaces a refused sign-in in words, without naming a phone it could not verify', () => {
    const e = describeServerEntry(row({ route: 'GET /v1/snapshot', actor_type: 'anonymous', status: 401, reason: 'signature_does_not_verify' }), names)!
    expect(e.kind).toBe('security')
    expect(e.tone).toBe('warn')
    expect(e.text).toContain('not signed in')
    expect(e.detail).toBe('the phone’s signature did not match its registered key')
    expect(e.text).not.toContain("Sam's")
  })

  it('reports a refused enrolment and a refused trip', () => {
    expect(describeServerEntry(row({ route: 'POST /v1/enroll/app', actor_type: 'anonymous', status: 403, reason: 'enrolment_refused' }), names)!.text).toBe('A phone could not enrol')
    const trip = describeServerEntry(row({ route: 'POST /v1/relay/bundles/offer', client_id: SAM, status: 403, reason: 'scope' }), names)!
    expect(trip).toMatchObject({ kind: 'trip', tone: 'warn', detail: 'outside what this phone may see' })
  })

  it('tells a refresh from a check that found nothing new', () => {
    expect(describeServerEntry(row({ client_id: SAM, status: 200 }), names)!.text).toBe("Sam's iPhone refreshed its trip history")
    expect(describeServerEntry(row({ client_id: SAM, status: 304 }), names)!.text).toBe("Sam's iPhone checked for new trips")
  })

  it('leaves routine traffic out', () => {
    for (const route of ['GET /v1/health', 'POST /v1/sync/push', 'GET /v1/sync/pull', 'POST /v1/auth/token', 'GET /v1/devices']) {
      expect(describeServerEntry(row({ route }), names), route).toBeNull()
    }
    // the steps inside a trip being carried: the commit says it all
    expect(describeServerEntry(row({ route: 'POST /v1/relay/bundles/offer' }), names)).toBeNull()
    expect(describeServerEntry(row({ route: 'PUT /v1/relay/bundles/{id}/chunks/{digest}' }), names)).toBeNull()
  })

  it('names a phone it does not know by a short id rather than failing', () => {
    expect(names.nameOf('0123456789abcdef0123456789abcdef')).toBe('a phone (01234567…cdef)')
    expect(names.nameOf(undefined)).toBe('Someone')
  })

  it('ignores a row with no usable time', () => {
    expect(describeServerEntry(row({ ts: 'nope' }), names)).toBeNull()
  })
})

describe('dashboard entries', () => {
  it('shows invitations and revocations made here, nothing else', () => {
    expect(describeDashboardEntry({ ts: 5, actor: 'twesh', method: 'passkey', action: 'phone-invite', target: 'iPhone' })).toMatchObject({ kind: 'phone', text: 'twesh made an invitation for iPhone', via: 'dashboard' })
    expect(describeDashboardEntry({ ts: 6, actor: 'twesh', method: 'passkey', action: 'phone-revoked', target: "Sam's iPhone" })).toMatchObject({ tone: 'warn', text: "twesh revoked Sam's iPhone" })
    expect(describeDashboardEntry({ ts: 7, actor: 'twesh', method: 'passkey', action: 'passkey-removed', target: 'x' })).toBeNull()
  })
})

describe('mergeActivity', () => {
  it('weaves both sources newest first and caps the list', () => {
    const server = [
      row({ ts: '2026-10-07T10:00:00Z', route: 'POST /v1/relay/bundles/{id}/commit', client_id: SAM, target_id: 'a'.repeat(32) }),
      row({ ts: '2026-10-07T12:00:00Z', route: 'GET /v1/health', actor_type: 'anonymous' }),
      row({ ts: '2026-10-07T14:00:00Z', route: 'GET /v1/snapshot', client_id: SAM }),
    ]
    const mine = [{ ts: Date.parse('2026-10-07T13:00:00Z'), actor: 'twesh', method: 'passkey', action: 'phone-revoked', target: 'Old phone' }]
    const merged = mergeActivity(server, mine, names)
    expect(merged.map(e => e.kind)).toEqual(['history', 'phone', 'trip'])
    expect(mergeActivity(server, mine, names, 2)).toHaveLength(2)
  })
})

describe('groupRepeats', () => {
  const refused = (ts: string) => row({ ts, route: 'GET /v1/snapshot', actor_type: 'anonymous', status: 401, reason: 'client_revoked' })

  it('folds a phone retrying a refused request into one line with a count', () => {
    const merged = mergeActivity([refused('2026-10-07T16:00:00Z'), refused('2026-10-07T16:01:00Z'), refused('2026-10-07T16:02:00Z')], [], names)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ count: 3, at: Date.parse('2026-10-07T16:02:00Z'), firstAt: Date.parse('2026-10-07T16:00:00Z'), detail: 'this phone was revoked' })
  })

  it('does not fold different things, or the same thing hours apart', () => {
    const trip = row({ ts: '2026-10-07T16:01:30Z', route: 'POST /v1/relay/bundles/{id}/commit', client_id: SAM, target_id: 'b'.repeat(32) })
    const between = mergeActivity([refused('2026-10-07T16:00:00Z'), trip, refused('2026-10-07T16:03:00Z')], [], names)
    expect(between.map(e => e.kind)).toEqual(['security', 'trip', 'security'])
    const apart = mergeActivity([refused('2026-10-07T08:00:00Z'), refused('2026-10-07T16:00:00Z')], [], names)
    expect(apart).toHaveLength(2)
  })

  it('leaves single events without a count', () => {
    expect(groupRepeats([{ at: 1, kind: 'phone', tone: 'ok', text: 'x' }])[0].count).toBeUndefined()
  })
})

describe('presentPhones', () => {
  const list = presentPhones(clients)
  it('puts working phones first, most recently used first, and revoked ones last', () => {
    expect(list.map(p => p.name)).toEqual(["Sam's iPhone", 'cairn-phone (Mac)', 'Old phone'])
  })
  it('describes reach and the revocation', () => {
    expect(list[0]).toMatchObject({ reach: 'every car', active: true, last_via: 'home network' })
    const old = list[2]
    expect(old).toMatchObject({ reach: '2 cars', active: false, revoked_reason: 'lost it (passkey)' })
    expect(old.last_seen_at).toBeNull()   // the zero time means "never"
    expect(old.revoked_at).toBe(Date.parse('2026-10-06T00:00:00Z'))
  })
  it('never exposes anything but the short key fingerprint', () => {
    expect(JSON.stringify(list)).not.toContain('public_key')
  })
})

describe('reasonText', () => {
  it('turns a code into words and leaves unknown codes readable', () => {
    expect(reasonText('scope')).toBe('outside what this phone may see')
    expect(reasonText('some_new_code')).toBe('some new code')
    expect(reasonText(undefined)).toBeUndefined()
  })
})
