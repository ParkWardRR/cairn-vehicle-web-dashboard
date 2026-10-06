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
const command = 'sudo cat /var/lib/cairn-ui/bootstrap-code'
const copied = ref(false)
async function copy() {
  try { await navigator.clipboard.writeText(command); copied.value = true; setTimeout(() => { copied.value = false }, 2000) } catch { /* the command is on screen to select */ }
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
        <p class="text-[13px] mb-3">No passkey is set up yet, so the first one has to be created by someone who can prove they run this server.</p>

        <ol class="text-[13px] space-y-3 mb-4 list-decimal pl-5">
          <li>
            On the computer that runs Cairn, run this and copy what it prints:
            <span class="mt-1.5 flex items-center gap-2 rounded-lg px-3 py-2 font-mono text-[12px]" :style="{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }">
              <code class="flex-1 select-all whitespace-nowrap overflow-x-auto">{{ command }}</code>
              <button type="button" class="shrink-0 font-sans text-[12px] font-medium" style="color: var(--color-accent)" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button>
            </span>
            <span class="block mt-1 text-[12px]" style="color: var(--color-text-secondary)">The code is a file called <code>bootstrap-code</code> in Cairn's data folder. Anyone who can read it already controls the server.</span>
          </li>
          <li>
            Paste it here, then create the passkey. Your password manager (1Password, iCloud Keychain, a security key) will offer to save it.
            <input v-model="code" type="password" autocomplete="off" placeholder="One-time code" aria-label="One-time code" class="w-full rounded-lg px-3 py-2 text-sm mt-1.5 border" style="background: var(--color-bg); border-color: var(--color-border)">
          </li>
        </ol>

        <button class="w-full rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50" :disabled="busy || !supported || !code.trim()" style="background: var(--color-accent); color: white" @click="doEnrol">
          Create a passkey
        </button>

        <p v-if="session?.on_tailnet" class="text-[12px] mt-4" style="color: var(--color-text-secondary)">
          This device is on a tailnet, but its Tailscale login is not on this server's allow list, so it was not recognised. Add the login to <code>NUXT_AUTH_TAILNET_USERS</code> to skip the code from this device, or use the code.
        </p>
        <p v-else class="text-[12px] mt-4" style="color: var(--color-text-secondary)">
          No code is needed from an allowed device that reaches this page over your tailnet. If you are at home, the address you used probably arrived over the local network instead, which is why you are seeing this.
        </p>
      </template>

      <p v-if="!supported" class="text-[13px] mt-3" style="color: var(--color-danger, #f87171)">This browser cannot use passkeys here. Passkeys need a secure (https) address.</p>
      <p v-if="error" role="alert" class="text-[13px] mt-3" style="color: var(--color-danger, #f87171)">{{ error }}</p>
    </div>
  </div>
</template>
