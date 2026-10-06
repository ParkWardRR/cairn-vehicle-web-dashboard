<script setup lang="ts">
import type { AuthSession } from '~/composables/usePasskeys'

const { signIn, addPasskey, signOut } = usePasskeys()
const { data: session, refresh: refreshSession } = await useFetch<AuthSession>('/api/auth/session')
const human = computed(() => session.value?.authenticated && session.value.method !== 'service')
const { data: keys, refresh: refreshKeys } = await useFetch<{ passkeys: Array<{ id: string; name: string; created_at: number; last_used_at: number | null }> }>('/api/auth/passkeys', { immediate: Boolean(human.value) })
const { data: trail, refresh: refreshTrail } = await useFetch<{ audit: Array<{ id: number; ts: number; actor: string; method: string; action: string; target: string | null }> }>('/api/auth/audit', { immediate: Boolean(human.value) })

const name = ref('')
const busy = ref(false)
const error = ref('')
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : 'never')

// Changes to sign-in methods need a passkey used in the last few minutes: ask for it, then retry.
async function withFresh(fn: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try {
    try {
      await fn()
    } catch (e: any) {
      if ((e?.data?.statusMessage ?? e?.statusMessage) !== 'reauth_required') throw e
      await signIn()
      await fn()
    }
    await Promise.all([refreshKeys(), refreshTrail(), refreshSession()])
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
const add = () => withFresh(async () => { await addPasskey(name.value.trim() || `Passkey ${(keys.value?.passkeys.length ?? 0) + 1}`); name.value = '' })
const remove = (id: string) => withFresh(() => $fetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }))
</script>

<template>
  <div>
    <div class="mb-8">
      <h1 class="text-xl font-semibold tracking-tight">Security</h1>
      <p class="text-[13px] mt-1" style="color: var(--color-text-secondary)">
        Signed in {{ session?.method === 'tailnet' ? 'through this Tailnet device' : session?.method === 'passkey' ? 'with a passkey' : '' }}.
      </p>
    </div>

    <template v-if="human">
      <section class="mb-8">
        <h2 class="text-sm font-semibold mb-3">Passkeys</h2>
        <ul class="space-y-2 mb-4">
          <li v-for="k in keys?.passkeys" :key="k.id" class="flex items-center justify-between rounded-lg px-4 py-3 text-[13px]" :style="{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }">
            <span>{{ k.name }} <span style="color: var(--color-text-secondary)">· added {{ when(k.created_at) }} · last used {{ when(k.last_used_at) }}</span></span>
            <button class="font-medium disabled:opacity-50" :disabled="busy" style="color: var(--color-danger, #f87171)" @click="remove(k.id)">Remove</button>
          </li>
          <li v-if="!keys?.passkeys.length" class="text-[13px]" style="color: var(--color-text-secondary)">No passkeys yet.</li>
        </ul>
        <div class="flex gap-2">
          <input v-model="name" placeholder="Name this device" class="rounded-lg px-3 py-2 text-sm border flex-1 max-w-xs" style="background: var(--color-bg); border-color: var(--color-border)">
          <button class="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50" :disabled="busy" style="background: var(--color-accent); color: white" @click="add">Add a passkey</button>
        </div>
        <p v-if="error" role="alert" class="text-[13px] mt-3" style="color: var(--color-danger, #f87171)">{{ error }}</p>
      </section>

      <section class="mb-8">
        <h2 class="text-sm font-semibold mb-3">Recent activity</h2>
        <p class="text-[13px] mb-2" style="color: var(--color-text-secondary)">Who changed what, and when. Values are never recorded.</p>
        <ul class="text-[13px] space-y-1">
          <li v-for="a in trail?.audit" :key="a.id">{{ when(a.ts) }} · {{ a.actor }} ({{ a.method }}) · {{ a.action }}<span v-if="a.target"> · {{ a.target }}</span></li>
        </ul>
      </section>

      <button v-if="session?.method === 'passkey'" class="rounded-lg px-4 py-2 text-sm font-medium border" style="border-color: var(--color-border)" @click="signOut">Sign out</button>
    </template>
  </div>
</template>
