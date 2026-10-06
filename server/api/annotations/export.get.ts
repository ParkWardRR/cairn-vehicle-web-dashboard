export default defineEventHandler((event) => {
  const day = new Date().toISOString().slice(0, 10)
  setResponseHeader(event, 'content-disposition', `attachment; filename="cairn-trip-marks-${day}.json"`)
  return getAnnotations().export()
})
