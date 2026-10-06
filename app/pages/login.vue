<script setup lang="ts">
import type { AuthSession } from '~/composables/usePasskeys'

definePageMeta({ layout: false })
const route = useRoute()
const { signIn, addPasskey } = usePasskeys()

const { data: session } = await useFetch<AuthSession>('/api/auth/session')
const next = computed(() => safeNext(route.query.next))
const code = ref('')
const busy = ref(false)
const error = ref('')
const supported = ref(true)
onMounted(() => { supported.value = typeof window.PublicKeyCredential !== 'undefined' })

async function run(fn: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try {
    await fn()
    // a full load, so the server renders the next page with the new session
    window.location.assign(next.value)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
const doSignIn = () => run(signIn)
const doEnrol = () => run(() => addPasskey('First passkey', code.value.trim() || undefined))
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
        <p v-if="session.can_enrol" class="text-[13px] mt-5 mb-2" style="color: var(--color-text-secondary)">
          No passkey is set up yet. Create one so this works from your other devices too.
        </p>
        <button v-if="session.can_enrol" class="w-full rounded-lg px-4 py-2 text-sm font-medium border" :disabled="busy || !supported" style="border-color: var(--color-border)" @click="doEnrol">
          Create a passkey
        </button>
      </template>

      <template v-else-if="session && session.passkeys > 0">
        <button class="w-full rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50" :disabled="busy || !supported" style="background: var(--color-accent); color: white" @click="doSignIn">
          {{ busy ? 'Waiting for your passkey…' : 'Sign in with a passkey' }}
        </button>
      </template>

      <template v-else>
        <p class="text-[13px] mb-3">No passkey is set up yet. Enter the one-time code from the server (the file <code>bootstrap-code</code> in the Cairn data directory), or open this page from an allowed Tailnet device.</p>
        <input v-model="code" type="password" autocomplete="off" placeholder="One-time code" class="w-full rounded-lg px-3 py-2 text-sm mb-3 border" style="background: var(--color-bg); border-color: var(--color-border)">
        <button class="w-full rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50" :disabled="busy || !supported" style="background: var(--color-accent); color: white" @click="doEnrol">
          Create a passkey
        </button>
      </template>

      <p v-if="!supported" class="text-[13px] mt-3" style="color: var(--color-danger, #f87171)">This browser cannot use passkeys here. Passkeys need a secure (https) address.</p>
      <p v-if="error" role="alert" class="text-[13px] mt-3" style="color: var(--color-danger, #f87171)">{{ error }}</p>
    </div>
  </div>
</template>
