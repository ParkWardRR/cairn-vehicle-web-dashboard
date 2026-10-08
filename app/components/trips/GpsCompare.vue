<script setup lang="ts">
import 'echarts'
import VChart from 'vue-echarts'
import type { GpsComparison } from '#shared/utils/gpsSources'

// How the dongle's GNSS and the phone's GPS differed on one trip, and how close each came to the
// car's own speed. Position has no ground truth, so the disagreement between the two is the honest
// measure of it; speed and distance are checked against OBD.
const props = defineProps<{ bootId: string }>()

const { data: c, status } = useFetch<GpsComparison>(() => `/api/trips/${props.bootId}/gps-compare`, {
  key: () => `gps-compare-${props.bootId}`,
})

const hasDevice = computed(() => !!c.value?.device)
const hasPhone = computed(() => !!c.value?.phone)
const hasPairs = computed(() => (c.value?.pairs.count ?? 0) > 0)

function n(v: number | null | undefined, digits = 1, unit = ''): string {
  return v == null ? '—' : `${v.toFixed(digits)}${unit}`
}
function km(m: number | null | undefined): string {
  if (m == null) return '—'
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`
}
function signed(v: number | null | undefined, unit: string): string {
  return v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)} ${unit}`
}

type Side = 'device' | 'phone'
type Row = { label: string; hint?: string; device: string; phone: string; better?: Side | null }

// Which of two values is better, when they differ enough to say so.
function lower(d: number | null | undefined, p: number | null | undefined, margin = 0.05): Side | null {
  if (d == null || p == null) return null
  if (Math.abs(d - p) <= Math.max(Math.abs(d), Math.abs(p)) * margin) return null
  return d < p ? 'device' : 'phone'
}
function higher(d: number | null | undefined, p: number | null | undefined, margin = 0.05): Side | null {
  const side = lower(d, p, margin)
  return side == null ? null : side === 'device' ? 'phone' : 'device'
}

const basisNote: Record<string, string> = {
  reported: 'as the receiver reports it',
  hdop: 'estimated from HDOP × 4 m',
  assumed: 'assumed, the receiver gave none',
}

const rows = computed<Row[]>(() => {
  const d = c.value?.device, p = c.value?.phone
  if (!d && !p) return []
  const abs = (v: number | null | undefined) => (v == null ? null : Math.abs(v))
  return [
    { label: 'Fixes recorded', device: d ? String(d.fixes) : '—', phone: p ? String(p.fixes) : '—' },
    { label: 'Update rate', device: n(d?.rate_hz, 1, ' Hz'), phone: n(p?.rate_hz, 1, ' Hz'), better: higher(d?.rate_hz, p?.rate_hz) },
    { label: 'Time with a fix', hint: 'share of the trip with a fix no older than 5 s', device: n(d?.coverage_pct, 0, '%'), phone: n(p?.coverage_pct, 0, '%'), better: higher(d?.coverage_pct, p?.coverage_pct, 0.02) },
    { label: 'Gaps over 5 s', device: d ? `${d.gaps}${d.longest_gap_s ? ` · longest ${d.longest_gap_s} s` : ''}` : '—', phone: p ? `${p.gaps}${p.longest_gap_s ? ` · longest ${p.longest_gap_s} s` : ''}` : '—', better: lower(d?.gaps, p?.gaps, 0) },
    {
      label: 'Stated accuracy', hint: 'typical / worst 5% horizontal error each receiver claims',
      device: d ? `${n(d.accuracy_median_m, 1, ' m')} / ${n(d.accuracy_p95_m, 1, ' m')}` : '—',
      phone: p ? `${n(p.accuracy_median_m, 1, ' m')} / ${n(p.accuracy_p95_m, 1, ' m')}` : '—',
      better: d && p && d.accuracy_basis === p.accuracy_basis ? lower(d.accuracy_median_m, p.accuracy_median_m) : null,
    },
    { label: 'Satellites', hint: 'the phone does not say how many it used', device: n(d?.sats_median, 0), phone: '—' },
    { label: 'Distance driven', device: km(d?.distance_m), phone: km(p?.distance_m) },
    { label: 'Distance vs the car', hint: `against the ${km(c.value?.obd_distance_m)} the car's own speed adds up to`, device: signed(d?.distance_error_pct, '%'), phone: signed(p?.distance_error_pct, '%'), better: lower(abs(d?.distance_error_pct), abs(p?.distance_error_pct), 0.1) },
    { label: 'Top speed', device: n(d?.max_speed_kph, 0, ' km/h'), phone: n(p?.max_speed_kph, 0, ' km/h') },
    { label: 'Speed vs the car', hint: 'average error against OBD speed while moving; the part after the dot is how far off it typically is', device: d?.speed_samples ? `${signed(d.speed_bias_kph, 'km/h')} · ±${n(d.speed_rms_kph, 1)}` : '—', phone: p?.speed_samples ? `${signed(p.speed_bias_kph, 'km/h')} · ±${n(p.speed_rms_kph, 1)}` : '—', better: lower(d?.speed_rms_kph, p?.speed_rms_kph, 0.1) },
    { label: 'Speed within 2 km/h', hint: 'of the car\'s own speed', device: n(d?.speed_within_2kph_pct, 0, '%'), phone: n(p?.speed_within_2kph_pct, 0, '%'), better: higher(d?.speed_within_2kph_pct, p?.speed_within_2kph_pct, 0.03) },
  ]
})

function compass(east: number, north: number): string {
  const parts = []
  if (Math.abs(north) >= 1) parts.push(`${Math.abs(north).toFixed(0)} m ${north > 0 ? 'north' : 'south'}`)
  if (Math.abs(east) >= 1) parts.push(`${Math.abs(east).toFixed(0)} m ${east > 0 ? 'east' : 'west'}`)
  return parts.join(', ')
}

// The same facts in words, for someone who does not want to read a table.
const findings = computed<string[]>(() => {
  const out: string[] = []
  const v = c.value
  if (!v) return out
  const { pairs, device: d, phone: p } = v
  if (hasPairs.value && pairs.median_m != null && pairs.p95_m != null) {
    out.push(`The two tracks were typically ${pairs.median_m.toFixed(1)} m apart, and within ${pairs.p95_m.toFixed(0)} m for 95% of the trip.`)
    const e = pairs.bias_east_m ?? 0, no = pairs.bias_north_m ?? 0
    if (Math.hypot(e, no) >= 2) out.push(`The phone sat ${compass(e, no)} of the device on average, which looks like where it was in the car rather than noise.`)
  }
  if (d?.speed_samples && p?.speed_samples && d.speed_rms_kph != null && p.speed_rms_kph != null) {
    const dev = d.speed_rms_kph, ph = p.speed_rms_kph
    if (Math.abs(dev - ph) < 0.2) out.push(`Both read the car's speed equally well (±${dev.toFixed(1)} km/h).`)
    else out.push(`${dev < ph ? 'The device' : 'The phone'} tracked the car's own speed more closely: ±${Math.min(dev, ph).toFixed(1)} km/h against ±${Math.max(dev, ph).toFixed(1)} km/h.`)
  }
  if (d && p && d.coverage_pct != null && p.coverage_pct != null && Math.abs(d.coverage_pct - p.coverage_pct) >= 5) {
    out.push(`${d.coverage_pct > p.coverage_pct ? 'The device' : 'The phone'} had a fix for more of the trip (${Math.max(d.coverage_pct, p.coverage_pct)}% against ${Math.min(d.coverage_pct, p.coverage_pct)}%).`)
  }
  if (v.combined.from_both > 0) {
    out.push(`The combined line uses both where both had a fix (${v.combined.from_both} of ${v.combined.points} points), weighting the more accurate one, and whichever one had a fix elsewhere.`)
  }
  return out
})

const chartOption = computed(() => {
  const series = c.value?.pairs.series ?? []
  if (series.length < 2) return null
  const t0 = series[0].mono_ms
  const x = (s: { mono_ms: number }) => Math.round((s.mono_ms - t0) / 1000)
  return {
    backgroundColor: 'transparent',
    animation: false,
    grid: { top: 24, right: 44, bottom: 22, left: 40 },
    legend: { top: 0, left: 40, textStyle: { color: '#7c8298', fontSize: 10 }, itemWidth: 12, itemHeight: 3 },
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: '#1a1d27', borderColor: '#262b3d', textStyle: { color: '#e8eaf0', fontSize: 11 },
      valueFormatter: (v: number | null) => (v == null ? '—' : v.toFixed(1)),
    },
    xAxis: {
      type: 'value' as const, name: 's', nameTextStyle: { color: '#7c8298', fontSize: 10 },
      axisLabel: { color: '#7c8298', fontSize: 10 }, splitLine: { show: false },
    },
    yAxis: [
      { type: 'value' as const, name: 'm apart', nameTextStyle: { color: '#7c8298', fontSize: 10 }, min: 0, axisLabel: { color: '#7c8298', fontSize: 10 }, splitLine: { lineStyle: { color: '#262b3d' } } },
      { type: 'value' as const, name: 'km/h', nameTextStyle: { color: '#7c8298', fontSize: 10 }, axisLabel: { color: '#7c8298', fontSize: 10 }, splitLine: { show: false } },
    ],
    series: [
      { name: 'Distance between the two', type: 'line' as const, showSymbol: false, smooth: false, lineStyle: { width: 1.5, color: '#f59e0b' }, areaStyle: { color: 'rgba(245,158,11,.12)' }, data: series.map(s => [x(s), s.sep_m]) },
      { name: 'Phone speed minus device', type: 'line' as const, yAxisIndex: 1, showSymbol: false, lineStyle: { width: 1, color: '#8b5cf6' }, data: series.map(s => [x(s), s.speed_delta_kph]) },
    ],
  }
})
</script>

<template>
  <section v-if="status !== 'pending' && c && (hasDevice || hasPhone)" class="rounded-xl p-4 mb-4" :style="{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }" aria-labelledby="gps-compare-title">
    <div class="flex flex-wrap items-baseline gap-x-3 mb-3">
      <h2 id="gps-compare-title" class="text-[11px] font-bold uppercase tracking-wider" style="color: var(--color-text-secondary)">GPS: device and phone</h2>
      <span class="text-[11px]" style="color: var(--color-text-secondary)">
        {{ hasDevice && hasPhone ? 'Both recorded this trip' : hasDevice ? 'Device only' : 'Phone only' }}
      </span>
    </div>

    <p v-if="!hasPhone" class="text-[13px] mb-3" style="color: var(--color-text-secondary)">
      No phone GPS was recorded on this trip, so there is nothing to compare. Open the Cairn app on the phone and let it connect before you drive: it hands its fixes to the dongle, which records them next to its own.
    </p>
    <p v-else-if="!hasDevice" class="text-[13px] mb-3" style="color: var(--color-text-secondary)">
      The dongle had no GNSS fix on this trip, so only the phone's track exists.
    </p>

    <ul v-if="findings.length" class="text-[13px] space-y-1.5 mb-4 list-disc pl-5">
      <li v-for="(f, i) in findings" :key="i">{{ f }}</li>
    </ul>

    <!-- Each source, side by side -->
    <div class="overflow-x-auto">
      <table class="w-full text-[12px]">
        <thead>
          <tr style="color: var(--color-text-secondary)">
            <th class="text-left font-semibold py-1.5 pr-3 w-[38%]" />
            <th class="text-left font-semibold py-1.5 pr-3"><span class="inline-block w-2 h-0.5 mr-1.5 align-middle" style="background: #3b82f6" />Device</th>
            <th class="text-left font-semibold py-1.5"><span class="inline-block w-2 h-0.5 mr-1.5 align-middle" style="background: #f97316" />Phone</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.label" :style="{ borderTop: '1px solid var(--color-border)' }">
            <td class="py-1.5 pr-3 align-top">
              {{ r.label }}
              <span v-if="r.hint" class="block text-[10px]" style="color: var(--color-text-secondary)">{{ r.hint }}</span>
            </td>
            <td class="py-1.5 pr-3 font-mono align-top" :style="{ color: r.better === 'device' ? 'var(--color-success)' : undefined, fontWeight: r.better === 'device' ? 600 : undefined }">{{ r.device }}</td>
            <td class="py-1.5 font-mono align-top" :style="{ color: r.better === 'phone' ? 'var(--color-success)' : undefined, fontWeight: r.better === 'phone' ? 600 : undefined }">{{ r.phone }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="text-[10px] mt-2" style="color: var(--color-text-secondary)">
      Green is the closer one, where the gap is big enough to call.
      <template v-if="c.device?.accuracy_basis && c.device.accuracy_basis !== 'reported'">The device's accuracy is {{ basisNote[c.device.accuracy_basis] }}, so it is not directly comparable with the phone's own figure.</template>
    </p>

    <!-- How they differed -->
    <template v-if="hasPairs">
      <h3 class="text-[11px] font-bold uppercase tracking-wider mt-5 mb-2" style="color: var(--color-text-secondary)">How they differed</h3>
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-3">
        <div v-for="t in [
          { l: 'Typical gap', v: n(c.pairs.median_m, 1, ' m') },
          { l: '95% within', v: n(c.pairs.p95_m, 0, ' m') },
          { l: 'Largest gap', v: n(c.pairs.max_m, 0, ' m') },
          { l: 'Within 5 m', v: n(c.pairs.within_5m_pct, 0, '%') },
          { l: 'Speed differed by', v: n(c.pairs.speed_delta_abs_mean_kph, 1, ' km/h') },
          { l: 'Compared at', v: `${c.pairs.count} points` },
        ]" :key="t.l" class="rounded-lg px-3 py-2" :style="{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }">
          <p class="text-[10px] uppercase tracking-wider" style="color: var(--color-text-secondary)">{{ t.l }}</p>
          <p class="text-sm font-mono font-semibold mt-0.5">{{ t.v }}</p>
        </div>
      </div>
      <ClientOnly>
        <VChart v-if="chartOption" :option="chartOption" autoresize style="height: 160px" aria-label="Distance between the device and phone tracks over the trip" />
      </ClientOnly>
      <p class="text-[10px] mt-1" style="color: var(--color-text-secondary)">
        Each device fix is compared with the phone's position at that same instant, worked out between its two nearest fixes, so the delay the phone's fixes pick up on the way over Bluetooth is not counted as GPS error.
      </p>
    </template>
  </section>
</template>
