<script setup lang="ts">
const { vehicles, selected, scope, effectiveId } = useVehicle()

// With one car there is nothing to choose, and trip detail is already one car.
const visible = computed(() => scope.value !== 'none' && vehicles.value.length > 1)

// Analysis pages never offer "All vehicles": they show the car they are using.
const value = computed({
  get: () => (scope.value === 'single' ? (effectiveId.value ?? '') : selected.value),
  set: (id: string) => { selected.value = id },
})

function label(v: { name: string; engine_code: string | null; engine_profile_id: string | null; archived: boolean }) {
  const engine = v.engine_code && !v.name.includes(v.engine_code) ? ` (${v.engine_code})` : ''
  // The firmware profile the dongle will use for this car (BLE ENGINE_DECLARATION,
  // contracts/ble/v1 § 0004). Only shown when it adds information beyond the engine_code
  // already in the label.
  const profile = v.engine_profile_id && (!v.engine_code || !v.engine_profile_id.toLowerCase().endsWith(v.engine_code.toLowerCase()))
    ? ` [${v.engine_profile_id}]`
    : ''
  return `${v.name}${engine}${profile}${v.archived ? ' - archived' : ''}`
}
</script>

<template>
  <select
    v-if="visible"
    v-model="value"
    aria-label="Vehicle"
    class="max-w-[16rem] truncate px-3 py-1.5 rounded-lg border text-[13px] font-medium cursor-pointer focus:ring-2 focus:ring-[var(--color-accent)] focus:outline-none"
    :style="{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }"
  >
    <option v-if="scope === 'all'" value="">All vehicles</option>
    <option v-for="v in vehicles" :key="v.id" :value="v.id">{{ label(v) }}</option>
  </select>
</template>
