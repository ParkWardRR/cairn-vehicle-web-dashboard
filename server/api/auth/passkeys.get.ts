export default defineEventHandler((event) => {
  requireHuman(event)
  return {
    passkeys: authStore().credentials().map(c => ({
      id: c.id, name: c.name, created_at: c.created_at, last_used_at: c.last_used_at, transports: c.transports,
    })),
  }
})
