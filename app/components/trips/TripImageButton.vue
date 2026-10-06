<script setup lang="ts">
import { canvasToPng, drawTripImage, type ImageData } from '~/composables/useTripImage'

// Saves a high-resolution picture of the route. Drawn here, with no map tiles, and without the
// trip's start and end or anything near a private place you have saved.
const props = defineProps<{ bootId: string }>()
const scale = ref(2)
const busy = ref(false)
const error = ref('')
const note = ref('')

async function save() {
  busy.value = true
  error.value = ''
  note.value = ''
  try {
    const d = await $fetch<ImageData>(`/api/trips/${props.bootId}/image-data`)
    if (!d.segments.length) {
      note.value = 'This trip is too short to draw without showing where it started and ended.'
      return
    }
    const canvas = document.createElement('canvas')
    drawTripImage(canvas, d, scale.value, document.documentElement.classList.contains('light') ? false : true)
    const blob = await canvasToPng(canvas)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `cairn-trip-${d.summary.day ?? 'drive'}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch (e: any) {
    error.value = e?.data?.statusMessage ?? 'Could not make the picture.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <span class="inline-flex items-center gap-2">
    <select v-model.number="scale" aria-label="Picture size" class="rounded-lg px-2 py-1.5 text-[13px] border" :style="{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }">
      <option :value="1">1600 px</option>
      <option :value="2">3200 px</option>
      <option :value="3">4800 px</option>
    </select>
    <button class="px-3.5 py-2 text-[13px] font-medium rounded-xl disabled:opacity-50" :disabled="busy" :style="{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }" @click="save">
      {{ busy ? 'Drawing…' : 'Save a picture' }}
    </button>
    <span v-if="note" class="text-[12px]" style="color: var(--color-text-secondary)">{{ note }}</span>
    <span v-if="error" role="alert" class="text-[12px]" style="color: var(--color-danger, #f87171)">{{ error }}</span>
  </span>
</template>
