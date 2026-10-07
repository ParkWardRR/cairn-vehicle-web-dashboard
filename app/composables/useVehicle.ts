// Which car the pages are looking at. Analysis pages ('single') always show one
// vehicle, because a trim map or boost curve pooled over two engines describes
// neither; list and total pages ('all') may also show every vehicle at once;
// trip detail ('none') is keyed by boot id and needs no selector.
export type VehiclePageScope = 'all' | 'single' | 'none'

export interface VehicleOption {
  id: string
  name: string
  engine_code: string | null
  // The engine profile id the server resolved for this vehicle (e.g. "bmw-n20"); the
  // dongle will treat this as the companion-declared engine. `null` means the dongle
  // falls back to its own VIN pattern or the default profile.
  engine_profile_id: string | null
  archived: boolean
  bundles: number
  boots: number
  first_observed_at: string | null
  last_observed_at: string | null
}

const PAGE_SCOPES: Array<[path: string, scope: VehiclePageScope]> = [
  ['/analytics', 'single'],
  ['/boost', 'single'],
  ['/fuel', 'single'],
  ['/economy', 'single'],
  ['/calibration', 'single'],
  ['/behavior', 'single'],
  ['/', 'all'],
  ['/trips', 'all'],
  ['/places', 'all'],
  ['/system', 'all'],
]

// Exact match only: '/trips/<bootId>' falls through to 'none', as does any
// page not listed here.
export function vehicleScopeForPath(path: string): VehiclePageScope {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path
  return PAGE_SCOPES.find(([prefix]) => prefix === p)?.[1] ?? 'none'
}

const VEHICLE_ID_RE = /^[0-9a-f]{32}$/
const LIST_KEY = 'cairn-vehicles'
const STORE_DOWN_KEY = 'cairn-store-down'

// True while the server reports its store unreachable (502 "store unreachable"),
// so the shell can say so once instead of every page showing its own empty state.
export function useStoreDown() {
  return useState<boolean>(STORE_DOWN_KEY, () => false)
}

// Loaded once, before any page runs, by plugins/vehicles.ts: a single-vehicle
// page has to know which car it shows before it fires its first fetch.
export async function loadVehicles(): Promise<void> {
  const list = useState<VehicleOption[] | null>(LIST_KEY, () => null)
  const storeDown = useStoreDown()
  if (list.value !== null) return
  try {
    const res = await $fetch<{ vehicles: VehicleOption[] }>('/api/vehicles')
    list.value = res.vehicles ?? []
    storeDown.value = false
  } catch (e: any) {
    // Left null so the client tries again; until then nothing is filtered by id.
    storeDown.value = (e?.statusCode ?? e?.response?.status) === 502
  }
}

export function useVehicle() {
  const route = useRoute()
  const list = useState<VehicleOption[] | null>(LIST_KEY, () => null)

  // '' = all vehicles. A cookie, so server-rendered fetches use it too; the raw
  // string is kept as is, since an all-digit id would otherwise decode as a number.
  const cookie = useCookie<string>('cairn-vehicle', {
    default: () => '',
    decode: v => v,
    encode: v => v,
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  })
  const state = useState<string>('cairn-vehicle', () => (VEHICLE_ID_RE.test(cookie.value ?? '') ? cookie.value : ''))

  const vehicles = computed(() => list.value ?? [])

  // A remembered id the store no longer holds counts as "all vehicles".
  const selected = computed<string>({
    get: () => {
      const id = state.value
      if (!id) return ''
      return list.value && !list.value.some(v => v.id === id) ? '' : id
    },
    set: (id) => {
      const v = VEHICLE_ID_RE.test(id) ? id : ''
      state.value = v
      cookie.value = v
    },
  })

  const scope = computed(() => vehicleScopeForPath(route.path))

  // For 'single': the chosen car, else the most recently seen one, which is the
  // list's first entry and the same car the server picks with no ?vehicle=.
  const effectiveId = computed<string | null>(() => {
    if (scope.value === 'none') return null
    if (selected.value) return selected.value
    return scope.value === 'single' ? (vehicles.value[0]?.id ?? null) : null
  })

  // For useFetch(url, { query: vehicleQuery }): reactive, so a new selection refetches.
  const vehicleQuery = computed<{ vehicle?: string }>(() =>
    effectiveId.value ? { vehicle: effectiveId.value } : {},
  )

  function nameOf(id: string | null | undefined): string {
    if (!id) return ''
    return vehicles.value.find(v => v.id === id)?.name ?? `Vehicle ${id.slice(0, 8)}`
  }

  return { vehicles, selected, scope, effectiveId, vehicleQuery, nameOf }
}
