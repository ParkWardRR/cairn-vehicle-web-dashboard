// Wi-Fi access points are known by their BSSID: the radio's MAC address, written
// "aa:bb:cc:dd:ee:ff". Shared by the app and the server, so a network the page offers
// is one the server will accept. Network names (SSIDs) are never recorded anywhere.

export const MAX_PLACE_BSSIDS = 64

const BSSID_RE = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/

// Lowercase colon-hex, or null when it is not a MAC address at all. Dashes and upper
// case are accepted on the way in, since that is how some tools print them.
export function normalizeBssid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase().replace(/-/g, ':')
  return BSSID_RE.test(s) ? s : null
}

function firstOctet(bssid: string): number {
  return parseInt(bssid.slice(0, 2), 16)
}

// A locally administered address (bit 0x02 of the first octet) is one the device made
// up: phone hotspots and randomised MACs. It moves with its owner, so it says nothing
// about where the car is. A multicast address (bit 0x01) is never a radio's own.
export function isLocallyAdministered(bssid: string): boolean {
  return (firstOctet(bssid) & 0x02) !== 0
}

// Whether a (normalised) BSSID can stand for a place: a real, globally assigned,
// unicast address of a fixed access point.
export function isUsableBssid(bssid: string | null | undefined): bssid is string {
  if (!bssid || !BSSID_RE.test(bssid)) return false
  if (bssid === '00:00:00:00:00:00') return false
  const o = firstOctet(bssid)
  return (o & 0x01) === 0 && (o & 0x02) === 0
}

export class BssidError extends Error {}

// Validates a list a person attached to a place: every entry a usable BSSID, at most
// MAX_PLACE_BSSIDS of them. Returns them normalised, de-duplicated and sorted. Throws
// BssidError with a message fit to show the user.
export function cleanBssidList(input: unknown): string[] {
  if (input == null) return []
  if (!Array.isArray(input)) throw new BssidError('Networks must be a list of BSSIDs')
  const out = new Set<string>()
  for (const raw of input) {
    const b = normalizeBssid(raw)
    if (!b) throw new BssidError(`"${String(raw).slice(0, 40)}" is not a BSSID (aa:bb:cc:dd:ee:ff)`)
    if (isLocallyAdministered(b)) throw new BssidError(`${b} is a locally administered address (a phone hotspot or a randomised MAC), so it cannot mark a place`)
    if (!isUsableBssid(b)) throw new BssidError(`${b} is not an access point's own address`)
    out.add(b)
  }
  if (out.size > MAX_PLACE_BSSIDS) throw new BssidError(`A place can have at most ${MAX_PLACE_BSSIDS} networks`)
  return [...out].sort()
}
