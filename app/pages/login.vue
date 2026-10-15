<script setup lang="ts">
import { safeNext, errorText } from '~/composables/usePasskeys'

definePageMeta({ layout: false })
const route = useRoute()

const { data: session } = await useFetch<{ authenticated: boolean; method: string | null }>('/api/auth/session')
const next = computed(() => safeNext(route.query.next))
const passphrase = ref('')
const busy = ref(false)
const error = ref('')

async function doLogin() {
  busy.value = true
  error.value = ''
  try {
    await $fetch('/api/auth/login-passphrase', {
      method: 'POST',
      body: { passphrase: passphrase.value },
    })
    window.location.assign(next.value)
  } catch (e: any) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-6" style="background-color: var(--color-bg)">
    <div class="w-full max-w-sm rounded-2xl p-6" :style="{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }">
      <h1 class="text-lg font-semibold tracking-tight">Cairn</h1>
      <p class="text-[13px] mt-1 mb-5" style="color: var(--color-text-secondary)">Sign in to see your drives.</p>

      <template v-if="session?.authenticated">
        <p class="text-[13px] mb-4">
          You are signed in<span v-if="session.method === 'tailnet'"> through this Tailnet device</span>.
        </p>
        <a :href="next" class="block text-center rounded-lg px-4 py-2 text-sm font-medium" style="background: var(--color-accent); color: white">Continue</a>
      </template>

      <template v-else>
        <form @submit.prevent="doLogin">
          <input
            v-model="passphrase"
            type="password"
            autocomplete="current-password"
            placeholder="Passphrase"
            aria-label="Passphrase"
            class="w-full rounded-lg px-3 py-2 text-sm mb-3 border"
            style="background: var(--color-bg); border-color: var(--color-border)"
          >
          <button
            type="submit"
            class="w-full rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            :disabled="busy"
            style="background: var(--color-accent); color: white"
          >
            {{ busy ? 'Signing in...' : 'Sign in' }}
          </button>
        </form>
      </template>

      <p v-if="error" role="alert" class="text-[13px] mt-3" style="color: var(--color-danger, #f87171)">{{ error }}</p>
    </div>
  </div>
</template>
