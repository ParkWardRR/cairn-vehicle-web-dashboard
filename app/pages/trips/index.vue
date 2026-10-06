<script setup lang="ts">
interface Trip {
  boot_id: string
  start_time: string
  duration_s: number
  max_speed_kph: number
  max_rpm: number
  obd_samples: number
  gap_count: number
}

interface Annotation { bookmarked: boolean; note: string | null; tags: string[] }
type ListedTrip = Trip & { annotation: Annotation | null }

// Find a drive again: by what you wrote about it, a tag, a bookmark, a saved place it visited, or a date.
const q = ref('')
const tag = ref('')
const bookmarked = ref(false)
const from = ref('')
const to = ref('')
const limit = ref(20)
const query = computed(() => ({
  ...(q.value.trim() ? { q: q.value.trim() } : {}),
  ...(tag.value ? { tag: tag.value } : {}),
  ...(bookmarked.value ? { bookmarked: '1' } : {}),
  ...(from.value ? { from: from.value } : {}),
  ...(to.value ? { to: to.value } : {}),
  limit: String(limit.value),
}))
watch([q, tag, bookmarked, from, to], () => { limit.value = 20 })
const { data, status } = useFetch<{ trips: ListedTrip[]; total: number }>('/api/trips/search', { query, watch: [query] })
const { data: marks } = useFetch<{ tags: Array<{ tag: string; trips: number }> }>('/api/annotations')
const trips = computed(() => data.value?.trips ?? [])
const total = computed(() => data.value?.total ?? 0)
const filtered = computed(() => Boolean(q.value.trim() || tag.value || bookmarked.value || from.value || to.value))
function clear() { q.value = ''; tag.value = ''; bookmarked.value = false; from.value = ''; to.value = '' }

function formatDate(iso: string | null): string {
  if (!iso) return '--'
  const d = new Date(iso)
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '--'
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '--'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${s}s`
}
</script>

<template>
  <div>
    <LayoutPageHeader title="Trips" subtitle="Every drive you have recorded. Open one to see where you went.">
      <template #actions>
        <span v-if="total" class="text-xs font-medium px-2.5 py-1 rounded-full" style="background: var(--color-accent-soft); color: var(--color-accent)">
          {{ total }} trip{{ total === 1 ? '' : 's' }}{{ filtered ? ' found' : '' }}
        </span>
      </template>
    </LayoutPageHeader>

    <form class="flex flex-wrap items-center gap-2 mb-4" role="search" @submit.prevent>
      <input v-model="q" type="search" placeholder="Search notes, tags and places" aria-label="Search trips" class="rounded-lg px-3 py-1.5 text-[13px] border w-64" :style="{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }">
      <select v-if="marks?.tags.length" v-model="tag" aria-label="Tag" class="rounded-lg px-2 py-1.5 text-[13px] border" :style="{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }">
        <option value="">Any tag</option>
        <option v-for="t in marks.tags" :key="t.tag" :value="t.tag">{{ t.tag }} ({{ t.trips }})</option>
      </select>
      <label class="text-[13px] inline-flex items-center gap-1.5"><input v-model="bookmarked" type="checkbox"> Bookmarked</label>
      <label class="text-[13px]">From <input v-model="from" type="date" class="rounded-lg px-2 py-1 border" :style="{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }"></label>
      <label class="text-[13px]">to <input v-model="to" type="date" class="rounded-lg px-2 py-1 border" :style="{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }"></label>
      <button v-if="filtered" type="button" class="text-[13px] underline-offset-2 hover:underline" style="color: var(--color-accent)" @click="clear">Clear</button>
    </form>

    <div v-if="status === 'pending' && !trips.length" class="space-y-2">
      <div v-for="i in 5" :key="i" class="skeleton h-14" />
    </div>

    <DataEmptyState
      v-else-if="trips.length === 0 && filtered"
      title="No trips match"
      message="Try fewer words, another tag, or a wider range of dates."
    />
    <DataEmptyState
      v-else-if="trips.length === 0"
      title="No trips yet"
      message="Your drives will show up here after the device records one and sends it to the server."
    />

    <div
      v-else
      class="rounded-xl overflow-hidden"
      :style="{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }"
    >
      <table class="w-full text-sm">
        <thead>
          <tr :style="{ borderBottom: '1px solid var(--color-border)' }">
            <th class="text-left px-5 py-3 text-[11px] font-semibold uppercase tracking-wider" style="color: var(--color-text-secondary)">Date</th>
            <th class="text-left px-5 py-3 text-[11px] font-semibold uppercase tracking-wider" style="color: var(--color-text-secondary)">Duration</th>
            <th class="text-right px-5 py-3 text-[11px] font-semibold uppercase tracking-wider" style="color: var(--color-text-secondary)">Max Speed</th>
            <th class="text-right px-5 py-3 text-[11px] font-semibold uppercase tracking-wider hidden sm:table-cell" style="color: var(--color-text-secondary)">Max RPM</th>
            <th class="text-right px-5 py-3 text-[11px] font-semibold uppercase tracking-wider hidden md:table-cell" style="color: var(--color-text-secondary)">OBD</th>
            <th class="text-right px-5 py-3 text-[11px] font-semibold uppercase tracking-wider hidden md:table-cell" style="color: var(--color-text-secondary)">Gaps</th>
            <th class="w-10 px-3" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="trip in trips"
            :key="trip.boot_id"
            class="group cursor-pointer transition-colors hover:bg-[var(--color-surface-elevated)]"
            :style="{ borderBottom: '1px solid var(--color-border)' }"
            @click="navigateTo(`/trips/${trip.boot_id}`)"
          >
            <td class="px-5 py-3.5 text-[13px]">
              <span v-if="trip.annotation?.bookmarked" class="mr-1" style="color: var(--color-accent)" title="Bookmarked">★</span>{{ formatDate(trip.start_time) }}
              <span v-for="t in trip.annotation?.tags ?? []" :key="t" class="ml-1.5 text-[11px] px-2 py-0.5 rounded-full" :style="{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }">{{ t }}</span>
              <span v-if="trip.annotation?.note" class="block text-[12px] mt-0.5 truncate max-w-md" style="color: var(--color-text-secondary)">{{ trip.annotation.note }}</span>
            </td>
            <td class="px-5 py-3.5 font-mono text-[13px]">{{ formatDuration(trip.duration_s) }}</td>
            <td class="px-5 py-3.5 font-mono text-[13px] text-right">{{ Math.round(trip.max_speed_kph / 1.60934) }} <span class="text-[11px]" style="color: var(--color-text-secondary)">mph</span></td>
            <td class="px-5 py-3.5 font-mono text-[13px] text-right hidden sm:table-cell">{{ trip.max_rpm.toLocaleString() }}</td>
            <td class="px-5 py-3.5 font-mono text-[13px] text-right hidden md:table-cell">{{ trip.obd_samples.toLocaleString() }}</td>
            <td class="px-5 py-3.5 font-mono text-[13px] text-right hidden md:table-cell">{{ trip.gap_count }}</td>
            <td class="px-3 py-3.5 text-right">
              <svg class="w-4 h-4 inline-block opacity-0 group-hover:opacity-50 transition-opacity" style="color: var(--color-text-secondary)" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="trips.length < total" class="mt-4 text-center">
      <button class="px-4 py-2 rounded-lg text-[13px] font-medium" :style="{ border: '1px solid var(--color-border)' }" @click="limit += 20">Show more ({{ total - trips.length }} more)</button>
    </div>
  </div>
</template>
