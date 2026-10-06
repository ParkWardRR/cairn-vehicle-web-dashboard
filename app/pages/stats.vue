<script setup lang="ts">
import 'echarts'
import VChart from 'vue-echarts'
import { parseDay, periodLabel, shiftAnchor, type Period } from '#shared/utils/period'

// Statistics for a year, quarter, month, week or any range, with the period before for comparison.
const { baseOptions, colors } = useChartTheme()
const { formatDuration } = useFormatters()

const period = ref<Period>('month')
const anchor = ref(new Date().toISOString().slice(0, 10))
const customFrom = ref('')
const customTo = ref('')

const query = computed(() => period.value === 'custom'
  ? { period: 'custom', from: customFrom.value, to: customTo.value }
  : { period: period.value, date: anchor.value })
const ready = computed(() => period.value !== 'custom' || (parseDay(customFrom.value) && parseDay(customTo.value)))

const { data, status, error } = useFetch<any>('/api/stats/period', { query, watch: [query], immediate: true, server: false })

const options: Array<{ id: Period; label: string }> = [
  { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }, { id: 'quarter', label: 'Quarter' },
  { id: 'year', label: 'Year' }, { id: 'custom', label: 'Custom' },
]
const label = computed(() => data.value ? periodLabel(data.value) : '')
function step(dir: -1 | 1) {
  const a = parseDay(anchor.value)
  if (a) anchor.value = shiftAnchor(period.value, a, dir).toISOString().slice(0, 10)
}

const mi = (m: number) => m / 1609.344
const miles = (m: number) => `${mi(m).toLocaleString('en-US', { maximumFractionDigits: mi(m) < 100 ? 1 : 0 })} mi`
const mph = (kph: number) => `${Math.round(kph / 1.60934)} mph`

// "+12% vs last month", or nothing when there is nothing to compare with
function delta(now: number, before: number): string {
  if (!before) return now ? 'nothing to compare with' : ''
  const pct = Math.round(((now - before) / before) * 100)
  return pct === 0 ? 'same as the period before' : `${pct > 0 ? '+' : ''}${pct}% vs the period before`
}

const cards = computed(() => {
  const d = data.value
  if (!d) return []
  const t = d.totals, p = d.previous.totals
  return [
    { label: 'Trips', value: String(t.trips), subtitle: delta(t.trips, p.trips) },
    { label: 'Distance', value: miles(t.distance_m), subtitle: delta(t.distance_m, p.distance_m) },
    { label: 'Time driving', value: t.duration_s ? formatDuration(t.duration_s) : '0m', subtitle: delta(t.duration_s, p.duration_s) },
    { label: 'Top speed', value: t.max_speed_kph ? mph(t.max_speed_kph) : '--', subtitle: '' },
  ]
})

const chart = computed(() => {
  const s = data.value?.series ?? []
  const short = (b: string) => (data.value?.bucket === 'month' ? new Date(`${b}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) : b.slice(5))
  return {
    ...baseOptions,
    grid: { left: 50, right: 16, top: 24, bottom: 30 },
    tooltip: { ...baseOptions.tooltip, trigger: 'axis', valueFormatter: (v: number) => `${v.toFixed(1)} mi` },
    xAxis: { ...baseOptions.xAxis, type: 'category', data: s.map((x: any) => short(x.bucket)) },
    yAxis: { ...baseOptions.yAxis, type: 'value', name: 'miles', nameTextStyle: { color: '#8b90a0' } },
    series: [{ type: 'bar', data: s.map((x: any) => mi(x.distance_m)), itemStyle: { color: colors.blue, borderRadius: [3, 3, 0, 0] } }],
  }
})
</script>

<template>
  <div>
    <LayoutPageHeader title="Statistics" subtitle="How much you drove, for any stretch of time" />

    <div class="flex flex-wrap items-center gap-3 mb-6">
      <div class="inline-flex rounded-lg overflow-hidden" :style="{ border: '1px solid var(--color-border)' }" role="tablist">
        <button
          v-for="o in options" :key="o.id" role="tab" :aria-selected="period === o.id"
          class="px-3.5 py-1.5 text-[13px] font-medium"
          :style="period === o.id ? { background: 'var(--color-accent-soft)', color: 'var(--color-accent)' } : { color: 'var(--color-text-secondary)' }"
          @click="period = o.id"
        >{{ o.label }}</button>
      </div>
      <template v-if="period !== 'custom'">
        <button class="px-2.5 py-1.5 rounded-lg text-[13px]" :style="{ border: '1px solid var(--color-border)' }" aria-label="Earlier" @click="step(-1)">‹</button>
        <span class="text-sm font-semibold min-w-32 text-center">{{ label }}</span>
        <button class="px-2.5 py-1.5 rounded-lg text-[13px]" :style="{ border: '1px solid var(--color-border)' }" aria-label="Later" @click="step(1)">›</button>
      </template>
      <template v-else>
        <label class="text-[13px]">From <input v-model="customFrom" type="date" class="rounded-lg px-2 py-1 ml-1 border" :style="{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }"></label>
        <label class="text-[13px]">to <input v-model="customTo" type="date" class="rounded-lg px-2 py-1 ml-1 border" :style="{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }"></label>
      </template>
    </div>

    <p v-if="!ready" class="text-[13px]" style="color: var(--color-text-secondary)">Pick the first and last day.</p>
    <p v-else-if="error" role="alert" class="text-[13px]" style="color: var(--color-danger, #f87171)">{{ error.data?.statusMessage ?? 'Could not load statistics.' }}</p>
    <div v-else-if="status === 'pending' && !data" class="grid grid-cols-2 lg:grid-cols-4 gap-4"><div v-for="i in 4" :key="i" class="skeleton h-28" /></div>
    <template v-else-if="data">
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <DataStatCard v-for="c in cards" :key="c.label" :label="c.label" :value="c.value" :subtitle="c.subtitle" />
      </div>
      <p v-if="!data.totals.trips" class="text-[13px] mb-4" style="color: var(--color-text-secondary)">No trips in this period.</p>
      <div class="rounded-xl p-4" :style="{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }">
        <h2 class="text-sm font-semibold mb-2">Distance by {{ data.bucket }}</h2>
        <VChart :option="chart" autoresize style="height: 280px; width: 100%" />
      </div>
    </template>
  </div>
</template>
