<script setup lang="ts">
import type { AuthSession } from '~/composables/usePasskeys'

const { signIn } = usePasskeys()
const { data: session } = await useFetch<AuthSession>('/api/auth/session')
const human = computed(() => session.value?.authenticated && session.value.method !== 'service')
const { data: status } = await useFetch<{ configured: boolean, server?: string, tailnet?: string | null, missing?: string[] }>('/api/phones/status', { immediate: Boolean(human.value) })

interface Phone {
  id: string, name: string, role: string, reach: string, active: boolean, status: string, key_id: string
  enrolled_at: number | null, revoked_at: number | null, revoked_reason: string | null, last_seen_at: number | null, last_via: string | null
}
interface ActivityEvent { at: number, kind: 'phone' | 'trip' | 'history' | 'security', tone: 'ok' | 'info' | 'warn', text: string, detail?: string, via?: string, count?: number, firstAt?: number }
interface Car { id: string, name: string, engine_code: string | null, archived: boolean, bundles: number, boots: number, last_observed_at: string | null }

const { data: phones, refresh: refreshPhones } = await useFetch<{ configured: boolean, phones: Phone[], missing?: string[] }>('/api/phones', { immediate: Boolean(human.value) })
const { data: activity, refresh: refreshActivity } = await useFetch<{ configured: boolean, events: ActivityEvent[] }>('/api/phones/activity', { immediate: Boolean(human.value) })
const { data: cars } = await useFetch<{ vehicles: Car[] }>('/api/vehicles', { immediate: Boolean(human.value) })

const filter = ref<'all' | 'phone' | 'trip' | 'security'>('all')
const shownEvents = computed(() => (activity.value?.events ?? []).filter((e) => {
  if (filter.value === 'all') return true
  if (filter.value === 'trip') return e.kind === 'trip' || e.kind === 'history'
  return e.kind === filter.value
}))
const needsLook = computed(() => (activity.value?.events ?? []).filter(e => e.kind === 'security').reduce((n, e) => n + (e.count ?? 1), 0))

const ago = (ms: number | null) => {
  if (!ms) return 'never'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 45) return 'just now'
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute')
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour')
  return rtf.format(-Math.round(s / 86400), 'day')
}
const exact = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : '')

// Revoking stops a phone for good, so it asks first, and needs a fresh passkey like the invitation does.
const confirming = ref<string | null>(null)
const revokeReason = ref('')
const revoking = ref(false)
const revokeError = ref('')
async function revoke(p: Phone) {
  revoking.value = true
  revokeError.value = ''
  const go = () => $fetch(`/api/phones/${p.id}/revoke`, { method: 'POST', body: { reason: revokeReason.value } })
  try {
    try {
      await go()
    } catch (e: any) {
      if ((e?.data?.statusMessage ?? e?.statusMessage) !== 'reauth_required') throw e
      await signIn()
      await go()
    }
    confirming.value = null
    revokeReason.value = ''
    await Promise.all([refreshPhones(), refreshActivity()])
  } catch (e) {
    revokeError.value = errorText(e)
  } finally {
    revoking.value = false
  }
}

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
let poll: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => { now.value = Date.now(); if (invite.value && secondsLeft.value === 0) hide() }, 1000)
  // Phones come and go while this page is open (one just enrolled from the QR code on it).
  poll = setInterval(() => { if (human.value) { refreshPhones(); refreshActivity() } }, 20_000)
})
onBeforeUnmount(() => { clearInterval(timer); clearInterval(poll) })

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
    refreshActivity()
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
      <h1 class="text-xl font-semibold tracking-tight">Phones</h1>
      <p class="text-[13px] mt-1" style="color: var(--color-text-secondary)">
        Add a phone, stop one that is lost, and see what phones, cars and trips have been doing.
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
          <h2 class="text-sm font-semibold mb-1">Add a phone</h2>
          <p class="text-[13px] mb-3" style="color: var(--color-text-secondary)">Make a QR code. Scanning it with the iPhone camera opens Cairn, which then sets the server, trusts its certificate and signs the phone in.</p>
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

      <section class="mb-8">
        <h2 class="text-sm font-semibold mb-3">Your phones</h2>
        <p v-if="phones && !phones.configured" class="text-[13px]" style="color: var(--color-text-secondary)">The list is not set up on this server yet.</p>
        <p v-else-if="!phones?.phones.length" class="text-[13px]" style="color: var(--color-text-secondary)">No phones have enrolled yet.</p>
        <ul v-else class="space-y-2">
          <li v-for="p in phones.phones" :key="p.id" class="rounded-lg px-4 py-3 text-[13px]" :style="{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', opacity: p.active ? 1 : 0.7 }">
            <div class="flex items-start justify-between gap-3">
              <div>
                <span class="font-medium">{{ p.name }}</span>
                <span class="ml-2 text-[11px] px-1.5 py-0.5 rounded" :style="{ background: p.active ? 'rgba(52,211,153,.15)' : 'rgba(248,113,113,.15)', color: p.active ? '#34d399' : '#f87171' }">{{ p.active ? 'Working' : 'Revoked' }}</span>
                <span v-if="p.role === 'admin'" class="ml-1 text-[11px] px-1.5 py-0.5 rounded" style="background: rgba(96,165,250,.15); color: #60a5fa">Admin</span>
                <div class="mt-1" style="color: var(--color-text-secondary)">
                  Sees {{ p.reach }} ·
                  <template v-if="p.active">last used <span :title="exact(p.last_seen_at)">{{ ago(p.last_seen_at) }}</span><span v-if="p.last_via"> over the {{ p.last_via }}</span></template>
                  <template v-else>stopped <span :title="exact(p.revoked_at)">{{ ago(p.revoked_at) }}</span><span v-if="p.revoked_reason"> · {{ p.revoked_reason }}</span></template>
                  · added <span :title="exact(p.enrolled_at)">{{ ago(p.enrolled_at) }}</span> · key {{ p.key_id }}
                </div>
              </div>
              <button v-if="p.active && confirming !== p.id" class="font-medium disabled:opacity-50 shrink-0" :disabled="revoking" style="color: var(--color-danger, #f87171)" @click="confirming = p.id; revokeReason = ''">Revoke</button>
            </div>
            <div v-if="confirming === p.id" class="mt-3 pt-3" style="border-top: 1px solid var(--color-border)" role="group" :aria-label="`Revoke ${p.name}`">
              <p class="mb-2"><strong>Stop {{ p.name }}?</strong> It is refused on its very next request and can’t be switched back on. To use it again it has to be added as a new phone.</p>
              <div class="flex flex-wrap gap-2">
                <input v-model="revokeReason" maxlength="80" placeholder="Why? (optional, kept in the record)" class="rounded-lg px-3 py-2 text-sm border flex-1 max-w-xs" style="background: var(--color-bg); border-color: var(--color-border)" @keyup.enter="revoke(p)">
                <button class="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50" :disabled="revoking" style="background: #dc2626; color: white" @click="revoke(p)">{{ revoking ? 'Revoking…' : 'Revoke this phone' }}</button>
                <button class="rounded-lg px-4 py-2 text-sm font-medium border disabled:opacity-50" :disabled="revoking" style="border-color: var(--color-border)" @click="confirming = null">Keep it</button>
              </div>
            </div>
          </li>
        </ul>
        <p v-if="revokeError && confirming" role="alert" class="text-[13px] mt-3" style="color: var(--color-danger, #f87171)">{{ revokeError }}</p>
      </section>

      <section v-if="cars?.vehicles.length" class="mb-8">
        <h2 class="text-sm font-semibold mb-3">Cars and their trips</h2>
        <ul class="space-y-2">
          <li v-for="c in cars.vehicles" :key="c.id" class="rounded-lg px-4 py-3 text-[13px]" :style="{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }">
            <span class="font-medium">{{ c.name }}</span><span v-if="c.engine_code" class="ml-2" style="color: var(--color-text-secondary)">{{ c.engine_code }}</span>
            <span v-if="c.archived" class="ml-2 text-[11px] px-1.5 py-0.5 rounded" style="background: rgba(148,163,184,.2)">Archived</span>
            <div class="mt-1" style="color: var(--color-text-secondary)">
              {{ c.boots }} {{ c.boots === 1 ? 'trip' : 'trips' }} recorded · last seen {{ c.last_observed_at ? ago(Date.parse(c.last_observed_at)) : 'never' }}
            </div>
          </li>
        </ul>
      </section>

      <section class="mb-8">
        <h2 class="text-sm font-semibold mb-1">Recent activity</h2>
        <p class="text-[13px] mb-3" style="color: var(--color-text-secondary)">The last week: phones joining and stopping, trips carried to the server, and anything refused. Nothing here holds a trip’s contents.</p>
        <div class="flex flex-wrap gap-2 mb-3" role="tablist" aria-label="Filter activity">
          <button v-for="f in [{ k: 'all', l: 'Everything' }, { k: 'phone', l: 'Phones' }, { k: 'trip', l: 'Trips' }, { k: 'security', l: needsLook ? `Needs a look (${needsLook})` : 'Needs a look' }]" :key="f.k"
                  role="tab" :aria-selected="filter === f.k" class="px-3 py-1.5 rounded-full text-[12px] font-medium border"
                  :style="{ borderColor: 'var(--color-border)', background: filter === f.k ? 'var(--color-accent)' : 'transparent', color: filter === f.k ? 'white' : 'inherit' }"
                  @click="filter = f.k as any">{{ f.l }}</button>
        </div>
        <p v-if="!shownEvents.length" class="text-[13px]" style="color: var(--color-text-secondary)">Nothing to show for this filter yet.</p>
        <ul v-else class="text-[13px] space-y-1.5">
          <li v-for="(e, i) in shownEvents" :key="i" class="flex gap-3">
            <span class="shrink-0 w-24" style="color: var(--color-text-secondary)" :title="exact(e.at)">{{ ago(e.at) }}</span>
            <span>
              <span :style="{ color: e.tone === 'warn' ? '#fbbf24' : e.tone === 'ok' ? '#34d399' : 'inherit' }">●</span>
              {{ e.text }}<span v-if="e.detail" style="color: var(--color-text-secondary)"> — {{ e.detail }}</span><span v-if="e.via" style="color: var(--color-text-secondary)"> · {{ e.via }}</span><span v-if="e.count && e.count > 1" style="color: var(--color-text-secondary)" :title="`from ${exact(e.firstAt ?? null)} to ${exact(e.at)}`"> · ×{{ e.count }}</span>
            </span>
          </li>
        </ul>
      </section>
    </template>
    <p v-else class="text-[13px]" style="color: var(--color-text-secondary)">Sign in with a passkey or a Tailnet device to add a phone.</p>
  </div>
</template>
