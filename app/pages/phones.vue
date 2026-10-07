<script setup lang="ts">
import type { AuthSession } from '~/composables/usePasskeys'

const { signIn } = usePasskeys()
const { data: session } = await useFetch<AuthSession>('/api/auth/session')
const human = computed(() => session.value?.authenticated && session.value.method !== 'service')
const { data: status } = await useFetch<{ configured: boolean, server?: string, tailnet?: string | null, missing?: string[] }>('/api/phones/status', { immediate: Boolean(human.value) })

interface Invite { link: string, svg: string, expires_at: string, name: string }
const name = ref('')
const invite = ref<Invite | null>(null)
const busy = ref(false)
const error = ref('')
const copied = ref(false)
const now = ref(Date.now())

const secondsLeft = computed(() => (invite.value ? Math.max(0, Math.round((Date.parse(invite.value.expires_at) - now.value) / 1000)) : 0))
const clock = computed(() => `${Math.floor(secondsLeft.value / 60)}:${String(secondsLeft.value % 60).padStart(2, '0')}`)

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); if (invite.value && secondsLeft.value === 0) hide() }, 1000) })
onBeforeUnmount(() => clearInterval(timer))

function hide() {
  invite.value = null
  copied.value = false
}

// An invitation lets a phone read every trip, so it needs a passkey used in the last few
// minutes: ask for it, then retry.
async function create() {
  busy.value = true
  error.value = ''
  hide()
  const make = () => $fetch<Invite>('/api/phones/invite', { method: 'POST', body: { name: name.value } })
  try {
    try {
      invite.value = await make()
    } catch (e: any) {
      if ((e?.data?.statusMessage ?? e?.statusMessage) !== 'reauth_required') throw e
      await signIn()
      invite.value = await make()
    }
    now.value = Date.now()
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}

async function copy() {
  if (!invite.value) return
  await navigator.clipboard.writeText(invite.value.link)
  copied.value = true
}
</script>

<template>
  <div>
    <div class="mb-8">
      <h1 class="text-xl font-semibold tracking-tight">Add a phone</h1>
      <p class="text-[13px] mt-1" style="color: var(--color-text-secondary)">
        Make a QR code. Scanning it with the iPhone camera opens Cairn, which then sets the server, trusts its certificate and signs the phone in.
      </p>
    </div>

    <template v-if="human">
      <section v-if="status && !status.configured" class="mb-8 rounded-lg px-4 py-3 text-[13px]" :style="{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }">
        <p class="font-medium mb-1">Not set up on this server yet.</p>
        <p style="color: var(--color-text-secondary)">
          Missing: <span v-for="(m, i) in status.missing" :key="m"><code>{{ m }}</code><span v-if="i < (status.missing?.length ?? 0) - 1">, </span></span>.
          See <em>Enrolling a phone</em> in the vehicle server's deploying guide.
        </p>
      </section>

      <template v-else>
        <section class="mb-8">
          <h2 class="text-sm font-semibold mb-3">New phone</h2>
          <div class="flex gap-2">
            <input v-model="name" maxlength="64" placeholder="Whose phone? (shown in the client list)" class="rounded-lg px-3 py-2 text-sm border flex-1 max-w-xs" style="background: var(--color-bg); border-color: var(--color-border)" @keyup.enter="create">
            <button class="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50" :disabled="busy" style="background: var(--color-accent); color: white" @click="create">
              {{ invite ? 'Make a new code' : 'Make a QR code' }}
            </button>
          </div>
          <p v-if="error" role="alert" class="text-[13px] mt-3" style="color: var(--color-danger, #f87171)">{{ error }}</p>
        </section>

        <section v-if="invite" class="mb-8" aria-live="polite">
          <div class="inline-block rounded-xl p-3" style="background: #ffffff; border: 1px solid var(--color-border)">
            <!-- Rendered by this server from the link, so it holds nothing but our own markup. -->
            <div class="w-64 h-64 [&>svg]:w-full [&>svg]:h-full" role="img" :aria-label="`QR code for ${invite.name}`" v-html="invite.svg" />
          </div>
          <p class="text-[13px] mt-3">
            For <strong>{{ invite.name }}</strong>. Open the iPhone <strong>Camera</strong>, point it at the code and tap the Cairn banner.
          </p>
          <p class="text-[13px] mt-1" style="color: var(--color-text-secondary)">
            Works once and expires in {{ clock }}. Anyone who scans it before then can add a phone, so keep it on this screen.
          </p>
          <div class="flex flex-wrap gap-3 mt-3">
            <button class="px-4 py-2 rounded-lg text-sm font-medium border" style="border-color: var(--color-border)" @click="copy">{{ copied ? 'Link copied' : 'Copy link instead' }}</button>
            <button class="px-4 py-2 rounded-lg text-sm font-medium border" style="border-color: var(--color-border)" @click="hide">Hide</button>
          </div>
        </section>
      </template>
    </template>
    <p v-else class="text-[13px]" style="color: var(--color-text-secondary)">Sign in with a passkey or a Tailnet device to add a phone.</p>
  </div>
</template>
