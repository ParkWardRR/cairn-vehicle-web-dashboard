<script setup lang="ts">
// The form for naming, placing and sizing a saved place, for an existing spot or a
// new one. The draft is edited in place; the page owns saving it and the map pin.

interface Suggestion {
  name: string
  category: string | null
  kind: string
  source: string
  dist_m: number
}

interface PlaceDraft {
  // The place in the list being edited, or null for a new place.
  placeId: number | null
  savedId: number | null
  name: string
  category: string | null
  radius_m: number
  lat: number
  lon: number
}

const props = defineProps<{
  draft: PlaceDraft
  suggestions?: Suggestion[]
  saving?: boolean
  error?: string | null
  // The name of the place that is Home now, if it is another one.
  otherHome?: string | null
}>()

const emit = defineEmits<{
  (e: 'save'): void
  (e: 'cancel'): void
  (e: 'remove'): void
  (e: 'moved'): void
}>()

const KIND_CHOICES = PICKER_KINDS
const RADII = [50, 100, 150, 250, 400]
const MIN_RADIUS = 25
const MAX_RADIUS = 500

const draftKind = computed(() => kindForCategory(props.draft.category))
const ranked = computed(() => rankByKind(props.suggestions ?? [], draftKind.value))

function pickKind(id: string) {
  const d = props.draft
  const k = placeKind(id)
  if (draftKind.value === id) { d.category = null; return }
  d.category = k.label
  // A kind with an obvious name (Home, Work) fills it in if nothing is there yet.
  if (!d.name.trim() && k.defaultName) d.name = k.defaultName
}

function setRadius(v: unknown) {
  const n = Math.round(Number(v))
  if (Number.isFinite(n)) props.draft.radius_m = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, n))
}

// "34.0522, -118.2437" (or with a space) moves the pin there.
const coordText = ref('')
const coordError = ref<string | null>(null)
watch(() => [props.draft.lat, props.draft.lon], ([lat, lon]) => {
  coordText.value = `${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}`
}, { immediate: true })

function applyCoords() {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(coordText.value)
  const lat = m ? Number(m[1]) : NaN
  const lon = m ? Number(m[2]) : NaN
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    coordError.value = 'Enter latitude, longitude, e.g. 34.0522, -118.2437'
    return
  }
  coordError.value = null
  props.draft.lat = lat
  props.draft.lon = lon
  emit('moved')
}

// Address search, only when Find is pressed.
interface GeocodeResult { label: string; lat: number; lon: number; source: string }
const query = ref('')
const searching = ref(false)
const results = ref<GeocodeResult[]>([])
const searchMsg = ref<string | null>(null)
const searchAttribution = ref<string[]>([])

async function findAddress() {
  const q = query.value.trim()
  if (q.length < 3) return
  searching.value = true
  searchMsg.value = null
  results.value = []
  try {
    const r = await $fetch<{ external: boolean; results: GeocodeResult[]; attribution: string[] }>('/api/places/geocode', { method: 'POST', body: { q } })
    results.value = r.results
    searchAttribution.value = r.attribution
    if (!r.external) searchMsg.value = 'Address search is off on this server (external lookups are disabled). Enter coordinates or click the map.'
    else if (!r.results.length) searchMsg.value = 'Nothing found. Try a fuller address, or enter coordinates.'
  } catch (e: any) {
    searchMsg.value = e?.data?.statusMessage ?? 'The search did not answer'
  } finally {
    searching.value = false
  }
}

function useResult(r: GeocodeResult) {
  props.draft.lat = r.lat
  props.draft.lon = r.lon
  if (!props.draft.name.trim()) props.draft.name = r.label.split(',')[0].slice(0, 80)
  results.value = []
  emit('moved')
}

const labelCls = 'block text-[10px] font-semibold uppercase tracking-wider mb-1'
const inputStyle = 'background: var(--color-surface); border: 1px solid var(--color-border); color: var(--color-text)'
</script>

<template>
  <form class="mt-3 space-y-3 rounded-lg p-3" style="background: var(--color-surface-elevated)" @submit.prevent="emit('save')">
    <div>
      <label :class="labelCls" style="color: var(--color-text-secondary)">Name</label>
      <input
        v-model="draft.name"
        type="text"
        maxlength="80"
        placeholder="e.g. Home, Gym, Mom's house"
        class="w-full rounded-md px-2.5 py-1.5 text-[13px] outline-none"
        :style="inputStyle"
        autofocus
      >
    </div>

    <div>
      <p :class="labelCls" style="color: var(--color-text-secondary)">
        Kind <span class="normal-case font-normal tracking-normal opacity-70">a hint: it ranks the names below and sets the icon</span>
      </p>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="k in KIND_CHOICES"
          :key="k.id"
          type="button"
          class="inline-flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-lg text-[12px] transition-colors"
          :style="{ background: draftKind === k.id ? 'var(--color-accent-soft)' : 'var(--color-surface)', border: '1px solid ' + (draftKind === k.id ? 'var(--color-accent)' : 'var(--color-border)'), color: draftKind === k.id ? 'var(--color-accent)' : 'var(--color-text)' }"
          @click="pickKind(k.id)"
        >
          <PlaceIcon :kind="k.id" :size="15" />{{ k.label }}
        </button>
      </div>
      <p v-if="draftKind === 'home' && otherHome" class="text-[11px] mt-1.5" style="color: var(--color-text-secondary)">
        “{{ otherHome }}” is Home now, and there is one Home. Move that place instead, or give it another kind first (Home is a privacy zone, so it is never changed for you).
      </p>
    </div>

    <div v-if="ranked.length">
      <p :class="labelCls" style="color: var(--color-text-secondary)">Nearby, tap to use</p>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="s in ranked"
          :key="s.name"
          type="button"
          class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] transition-colors hover:brightness-125"
          :style="{ background: draft.name === s.name ? 'var(--color-accent-soft)' : 'var(--color-surface)', border: '1px solid var(--color-border)', color: draft.name === s.name ? 'var(--color-accent)' : 'var(--color-text)' }"
          @click="draft.name = s.name"
        >
          <PlaceIcon v-if="s.kind !== 'other'" :kind="s.kind" :size="12" />
          {{ s.name }}<span v-if="s.dist_m" class="opacity-50"> · {{ s.dist_m }} m</span>
        </button>
      </div>
    </div>

    <div class="flex flex-wrap items-end gap-x-5 gap-y-2">
      <div>
        <p :class="labelCls" style="color: var(--color-text-secondary)">Covers visits within</p>
        <div class="flex flex-wrap items-center gap-1.5">
          <button
            v-for="r in RADII"
            :key="r"
            type="button"
            class="px-2 py-0.5 rounded-md text-[11px] font-mono transition-colors"
            :style="{ background: draft.radius_m === r ? 'var(--color-accent-soft)' : 'var(--color-surface)', border: '1px solid var(--color-border)', color: draft.radius_m === r ? 'var(--color-accent)' : 'var(--color-text)' }"
            @click="draft.radius_m = r"
          >{{ r }} m</button>
          <label class="inline-flex items-center gap-1 text-[11px]" style="color: var(--color-text-secondary)">
            or
            <input
              type="number"
              :min="MIN_RADIUS"
              :max="MAX_RADIUS"
              step="5"
              :value="draft.radius_m"
              aria-label="Radius in metres"
              class="w-16 rounded-md px-1.5 py-0.5 text-[11px] font-mono outline-none"
              :style="inputStyle"
              @change="setRadius(($event.target as HTMLInputElement).value)"
            > m
          </label>
        </div>
      </div>
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <div>
        <label :class="labelCls" style="color: var(--color-text-secondary)">Coordinates</label>
        <div class="flex gap-1.5">
          <input
            v-model="coordText"
            type="text"
            inputmode="decimal"
            placeholder="34.0522, -118.2437"
            class="flex-1 min-w-0 rounded-md px-2.5 py-1.5 text-[12px] font-mono outline-none"
            :style="inputStyle"
            @keydown.enter.prevent="applyCoords"
          >
          <button type="button" class="px-2.5 py-1 rounded-md text-[12px] font-semibold" style="background: var(--color-accent-soft); color: var(--color-accent)" @click="applyCoords">Move</button>
        </div>
        <p v-if="coordError" class="text-[11px] mt-1" style="color: var(--color-danger)">{{ coordError }}</p>
      </div>
      <div>
        <label :class="labelCls" style="color: var(--color-text-secondary)">Or find an address</label>
        <div class="flex gap-1.5">
          <input
            v-model="query"
            type="text"
            maxlength="200"
            placeholder="123 Main St, Springfield"
            class="flex-1 min-w-0 rounded-md px-2.5 py-1.5 text-[12px] outline-none"
            :style="inputStyle"
            @keydown.enter.prevent="findAddress"
          >
          <button type="button" :disabled="searching || query.trim().length < 3" class="px-2.5 py-1 rounded-md text-[12px] font-semibold disabled:opacity-40" style="background: var(--color-accent-soft); color: var(--color-accent)" @click="findAddress">{{ searching ? '…' : 'Find' }}</button>
        </div>
        <div v-if="results.length" class="mt-1.5 space-y-1">
          <button
            v-for="r in results"
            :key="`${r.lat},${r.lon}`"
            type="button"
            class="block w-full text-left rounded-md px-2 py-1 text-[11px] hover:brightness-125"
            :style="inputStyle"
            @click="useResult(r)"
          >{{ r.label }}</button>
          <p v-if="searchAttribution.length" class="text-[10px]" style="color: var(--color-text-secondary)">{{ searchAttribution.join(' · ') }}</p>
        </div>
        <p v-if="searchMsg" class="text-[11px] mt-1" style="color: var(--color-text-secondary)">{{ searchMsg }}</p>
      </div>
    </div>
    <p class="text-[11px]" style="color: var(--color-text-secondary)">Click the map or drag the highlighted pin to move it. The dashed circle shows what it covers.</p>

    <p v-if="error" class="text-[12px]" style="color: var(--color-danger)">{{ error }}</p>

    <div class="flex items-center gap-2">
      <button
        type="submit"
        :disabled="saving || !draft.name.trim()"
        class="px-3.5 py-1.5 rounded-lg text-[12px] font-semibold disabled:opacity-40"
        style="background: var(--color-accent); color: #fff"
      >{{ saving ? 'Saving…' : 'Save' }}</button>
      <button type="button" class="px-3 py-1.5 rounded-lg text-[12px]" style="color: var(--color-text-secondary)" @click="emit('cancel')">Cancel</button>
      <button
        v-if="draft.savedId != null"
        type="button"
        class="ml-auto px-3 py-1.5 rounded-lg text-[12px]"
        style="color: var(--color-danger)"
        @click="emit('remove')"
      >Delete this place</button>
    </div>
    <p class="text-[10px]" style="color: var(--color-text-secondary)">
      Saving applies to every past and future visit inside the circle, and nothing about the place is sent to any lookup service. An address you search for is sent to the search service named below its results.
    </p>
  </form>
</template>
