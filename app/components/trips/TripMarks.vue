<script setup lang="ts">
// Bookmark, tags and a note on one trip, saved as you go. Stored on this server, with the places.
const props = defineProps<{ bootId: string }>()

interface Mark { bookmarked: boolean; note: string | null; tags: string[] }
const { data, refresh } = await useFetch<{ annotation: Mark }>(() => `/api/annotations/${props.bootId}`)
const mark = computed<Mark>(() => data.value?.annotation ?? { bookmarked: false, note: null, tags: [] })

const newTag = ref('')
const note = ref(mark.value.note ?? '')
const error = ref('')
const saving = ref(false)
watch(() => mark.value.note, n => { note.value = n ?? '' })

async function save(patch: Partial<Mark>) {
  saving.value = true
  error.value = ''
  try {
    await $fetch(`/api/annotations/${props.bootId}`, { method: 'PUT', body: patch })
    await refresh()
  } catch (e: any) {
    error.value = e?.data?.statusMessage ?? 'Could not save.'
  } finally {
    saving.value = false
  }
}
const toggle = () => save({ bookmarked: !mark.value.bookmarked })
const addTag = async () => {
  const t = newTag.value.trim()
  if (!t) return
  await save({ tags: [...mark.value.tags, t] })
  if (!error.value) newTag.value = ''
}
const removeTag = (t: string) => save({ tags: mark.value.tags.filter(x => x !== t) })
const saveNote = () => { if ((mark.value.note ?? '') !== note.value.trim()) save({ note: note.value }) }
</script>

<template>
  <section class="rounded-xl p-4 mb-6" :style="{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }" aria-label="Your notes on this trip">
    <div class="flex flex-wrap items-center gap-2">
      <button
        class="px-3 py-1.5 rounded-lg text-[13px] font-medium" :aria-pressed="mark.bookmarked" :disabled="saving"
        :style="mark.bookmarked ? { background: 'var(--color-accent-soft)', color: 'var(--color-accent)' } : { border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }"
        @click="toggle"
      >{{ mark.bookmarked ? '★ Bookmarked' : '☆ Bookmark' }}</button>
      <span v-for="t in mark.tags" :key="t" class="inline-flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-full" :style="{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }">
        {{ t }}<button class="opacity-60 hover:opacity-100" :aria-label="`Remove tag ${t}`" @click="removeTag(t)">×</button>
      </span>
      <form class="inline-flex gap-1" @submit.prevent="addTag">
        <input v-model="newTag" placeholder="Add a tag" maxlength="32" class="rounded-lg px-2.5 py-1 text-[13px] border w-32" :style="{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }">
      </form>
    </div>
    <textarea
      v-model="note" rows="2" maxlength="2000" placeholder="A note to remember this drive by"
      class="w-full mt-3 rounded-lg px-3 py-2 text-[13px] border" :style="{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }"
      @blur="saveNote"
    />
    <p v-if="error" role="alert" class="text-[13px] mt-2" style="color: var(--color-danger, #f87171)">{{ error }}</p>
  </section>
</template>
