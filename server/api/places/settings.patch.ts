// Settings for the Places page. { beacondb: boolean } turns beaconDB lookups of unknown
// Wi-Fi networks on or off (on unless turned off). Kept with the saved places, so it
// survives a lost database and travels with an export.
export default defineEventHandler(async (event) => {
  requireJson(event)
  const body = await readBody(event)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw createError({ statusCode: 400, statusMessage: 'Send an object' })
  const { saved } = getPlaceResolver()
  if ('beacondb' in body) {
    if (typeof body.beacondb !== 'boolean') throw createError({ statusCode: 400, statusMessage: 'beacondb must be true or false' })
    saved.setSetting(BEACONDB_SETTING, body.beacondb ? 'on' : 'off')
  }
  return { wifi: wifiSettingsForApi() }
})
