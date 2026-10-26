<script setup lang="ts">
// "Networks seen here": Wi-Fi access points that are probably at a saved place, to
// attach to it. A scan that hears an attached network puts the car at the place when
// GNSS has no fix. Only BSSIDs, counts and dates: network names are never recorded.

interface Candidate {
  bssid: string
  attached: boolean
  learned: { observations: number; dist_m: number; spread_m: number | null; last_seen: string | null } | null
  at_trip_ends: { sightings: number; boots: number; last_seen: string | null } | null
  max_rssi_dbm: number | null
  last_seen: string | null
}

const props = defineProps<{ savedId: number; radiusM: number }>()
const emit = defineEmits<{ (e: 'saved'): void }>()

const { data, status, refresh } = useFetch<{ available: boolean; attached: string[]; networks: Candidate[] }>(
  () => `/api/places/saved/${props.savedId}/networks`,
  { key: `place-networks-${props.savedId}` },
)
watch(() => props.radiusM, () => refresh())

const picked = ref<Set<string>>(new Set())
watch(() => data.value?.attached, (a) => { picked.value = new Set(a ?? []) }, { immediate: true })

const changed = computed(() => {
  const a = new Set(data.value?.attached ?? [])
  return a.size !== picked.value.size || [...picked.value].some(b => !a.has(b))
})

function toggle(b: string) {
  const next = new Set(picked.value)
  if (next.has(b)) next.delete(b)
  else next.add(b)
  picked.value = next
}

const saving = ref(false)
const error = ref<string | null>(null)
async function save() {
  saving.value = true
  error.value = null
  try {
    await $fetch(`/api/places/saved/${props.savedId}`, { method: 'PATCH', body: { bssids: [...picked.value] } })
    await refresh()
    emit('saved')
  } catch (e: any) {
    error.value = e?.data?.statusMessage ?? 'Could not save the networks'
  } finally {
    saving.value = false
  }
}

function fmtSeen(iso: string | null): string {
  if (!iso) return '--'
  const d = new Date(iso)
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '--'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

function evidence(c: Candidate): string {
  const parts: string[] = []
  if (c.learned) parts.push(`${c.learned.observations} fix${c.learned.observations === 1 ? '' : 'es'} in the learned map, ${c.learned.dist_m} m from the centre`)
  if (c.at_trip_ends) parts.push(`heard ${c.at_trip_ends.sightings}× before a fix as ${c.at_trip_ends.boots} trip${c.at_trip_ends.boots === 1 ? '' : 's'} left or arrived`)
  if (!parts.length) parts.push('attached; not seen recently')
  return parts.join(' · ')
}
</script>

<template>
  <div class="mt-3 rounded-lg p-3" style="background: var(--color-surface-elevated)">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
      <p class="text-[10px] font-semibold uppercase tracking-wider" style="color: var(--color-text-secondary)">Networks seen here</p>
      <p class="text-[11px]" style="color: var(--color-text-secondary)">
        Tick the ones that belong to this place. When the car hears one and has no GPS fix, its position is shown as this place.
      </p>
    </div>

    <div v-if="status === 'pending' && !data" class="skeleton h-10" />
    <p v-else-if="data && !data.available && !data.networks.length" class="text-[11px]" style="color: var(--color-text-secondary)">
      The trip store does not record Wi-Fi scans yet.
    </p>
    <p v-else-if="data && !data.networks.length" class="text-[11px]" style="color: var(--color-text-secondary)">
      No networks seen here yet. They appear after trips that start or end here with Wi-Fi scanning on.
    </p>
    <template v-else-if="data">
      <div class="max-h-64 overflow-y-auto space-y-0.5">
        <label
          v-for="c in data.networks"
          :key="c.bssid"
          class="flex items-center gap-2.5 rounded-md px-2 py-1 cursor-pointer hover:bg-[var(--color-surface)]"
        >
          <input type="checkbox" :checked="picked.has(c.bssid)" class="accent-[var(--color-accent)]" @change="toggle(c.bssid)">
          <span class="font-mono text-[12px]">{{ c.bssid }}</span>
          <span class="text-[11px] flex-1 min-w-0 truncate" style="color: var(--color-text-secondary)" :title="evidence(c)">{{ evidence(c) }}</span>
          <span v-if="c.max_rssi_dbm != null" class="text-[10.5px] font-mono shrink-0" style="color: var(--color-text-secondary)">{{ c.max_rssi_dbm }} dBm</span>
          <span class="text-[10.5px] font-mono shrink-0 w-16 text-right" style="color: var(--color-text-secondary)" title="last seen">{{ fmtSeen(c.last_seen) }}</span>
        </label>
      </div>
      <div class="flex items-center gap-2 mt-2">
        <button
          type="button"
          :disabled="!changed || saving"
          class="px-3 py-1 rounded-lg text-[12px] font-semibold disabled:opacity-40"
          style="background: var(--color-accent); color: #fff"
          @click="save"
        >{{ saving ? 'Saving…' : 'Save networks' }}</button>
        <span class="text-[11px]" style="color: var(--color-text-secondary)">{{ picked.size }} attached · at most 64</span>
        <p v-if="error" class="text-[12px]" style="color: var(--color-danger)">{{ error }}</p>
      </div>
    </template>
  </div>
</template>
