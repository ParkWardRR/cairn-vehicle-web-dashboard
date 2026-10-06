// Everything a person has made in the web layer, in one file: saved and learned places (with the
// spots they rejected) and the marks on trips. Not included, because they can be rebuilt or are
// credentials: the lookup cache and visit history (places.sqlite) and sign-in state (auth.sqlite).
// See "Your data" in the README.
export default defineEventHandler((event) => {
  const day = new Date().toISOString().slice(0, 10)
  setResponseHeader(event, 'content-disposition', `attachment; filename="cairn-data-${day}.json"`)
  return {
    kind: 'cairn-data',
    version: 1,
    exported_at: new Date().toISOString(),
    saved_places: getPlaceResolver().saved.exportAll(),
    trip_marks: getAnnotations().export(),
  }
})
