# Places

The trip page marks where the car stopped, and the Places page gathers those
stops, and every trip start and end, into places you can name and correct.

## Where the data lives

Everything below is in `/var/lib/cairn-ui/` on the server (`NUXT_PLACES_DATA_DIR`).

| File | What | Safe to delete? |
| --- | --- | --- |
| `saved-places.sqlite` | Places you named, places the system learned, spots you rejected, the networks attached to places, and Places settings (beaconDB on or off) | **No.** Nothing else holds these |
| `saved-places.json` | The same, rewritten after every change | No: it is how the database is restored |
| `backups/saved-places-*.json` | A copy kept at most hourly, newest 30 | Yes, but they are your history |
| `places.sqlite` | Lookup cache (names, and beaconDB answers keyed by a scan's sorted BSSIDs), and the visit history | Yes. Names are fetched again; visits are rebuilt from the trips still in cairn-tsdb. Deleting it also forgets which Wi-Fi sets beaconDB was already asked about |

If `saved-places.sqlite` is lost, the next start restores it from
`saved-places.json`. For a copy that survives the server, run
`deploy/backup-data.sh` from a laptop (it only reads), or use Export on the
Places page. Import merges a file back in and skips places already there.

These files hold real locations. They are not in the repository and must not be.

## How a place gets its name

1. **A place you saved or learned** covers every visit inside its circle, past
   and future, and is used before anything else. Nothing about it is sent to a
   lookup service.
2. Otherwise the name comes from the sources below, cached after the first lookup:
   OpenStreetMap (Overpass), Geoapify (needs a key) and a local Foursquare
   extract (`cairn-fsq`). A place both Foursquare and OSM agree on scores higher.

## Learning

When trips are ingested the server records each trip's stops, start and end in a
visit history. A spot that appears on **3 or more trips**, has a specific name
(a business or area, not a street or a bare address) and a confidence of at least
0.5 is saved automatically as **learned**, and shows a Learned badge.

- Edit a learned place, or press Confirm, and it becomes yours.
- Remove a place and that spot is remembered as rejected, so it is not learned
  again.

## What runs when trips arrive

```
bundle -> intake -> CAS -> outbox -> decode -> cairn-tsdb
                                                   |
                          (UI server, every minute, only when trips changed)
                                                   v
             record visits -> name places -> learn repeat places
```

The ingest is idempotent: it replaces a trip's visits as a whole, and trips that
later disappear from cairn-tsdb keep the visits already recorded.

## Kinds and icons

Every place has a kind: Home, Work, Gym, Leisure, Food, Nightlife, Groceries,
Shopping, Fuel, Parking, Auto, Health, Beauty, Pets, School, Friends, Services,
Civic, Worship, Outdoors or Travel, or Unsorted when nothing fits. Unsorted gets a
plain map pin on purpose: no guess. The kind sets the icon on the map
markers, the place list and the trip's stop list, and the catalogue lives in one
file, `ui/shared/utils/placeKinds.ts`, shared by the app and the server.

Picking a kind in the editor is a hint the engine uses:

- it ranks the nearby names so the ones that look like that kind come first
  (choose Gym and the fitness centres move to the front);
- it fills in a name when there is none (Home, Work);
- it is stored with the place, so learned and saved places keep their icon;
- for places nobody has tagged, the kind is worked out from the category the
  lookup returned (`supermarket` is Groceries, `fitness centre` is Gym).
  The first kind whose keyword matches wins, so the specific kinds are tried
  before the broad ones (a pet store is Pets, a post office is Services, not
  Work). Home, Work and Friends are mostly picked by hand, so they come last.

The engine also suggests Home: the spot trips most often start from and end at,
on at least 3 trips. It only suggests, and stops once a Home exists.

## Adding and editing places by hand

**Add a place** (top of the page) starts a new place with its pin in the middle of
the map. Put it where it belongs by clicking the map, dragging the pin, typing
coordinates (`34.0522, -118.2437`) or finding an address. The address search runs
only when you press Find, and goes to Geoapify if a key is set, otherwise to
OpenStreetMap's Nominatim; with `NUXT_PLACES_EXTERNAL=false` it is off and the page
says so. Then give it a name and a kind and save.

Editing any place offers the same: rename, change the kind, set the radius (the
presets or any value from 25 to 500 m), move it, or delete it.

**Home.** There is one Home: a place whose kind is Home. Accepting the engine's
suggestion (“This looks like home”) saves it in one click; **Adjust first** opens the
editor. Marking a second place Home is refused with a message naming the current
one, rather than quietly taking the kind off it: Home is a privacy zone for saved
pictures, and a former home should not stop being one without you deciding so.
Move the existing Home, or give it another kind first.

## Wi-Fi positions

The dongle scans for Wi-Fi access points. When GNSS has no fix (a cold start in a
garage, a parking structure) those scans can still say where the car was. The trip
store (`store/v1.7`) keeps every scan (`wifi_scan`) and the access points in it
(`wifi_ap_obs`: BSSID, signal strength, channel; **network names are never
recorded**), learns where each access point is, per car, from trusted GNSS fixes
taken beside learning scans (`v_wifi_ap_learned`), and lists the scans with no
trusted fix within ±5 s with its own estimate from that map (`v_wifi_scan_unfixed`).

The web layer resolves each of those scans, first match wins:

1. **A saved place** with one of the scan's BSSIDs attached: the place's position,
   its radius as the accuracy (source *place*). With several, the one with the most
   matching networks wins, the strongest signal breaking a tie.
2. **The learned map**: the store's estimate (source *learned*).
3. **beaconDB** ([beacondb.net](https://beacondb.net/)), if it is on (source
   *beaconDB*).

Locally administered addresses (bit `0x02` of the first octet: phone hotspots,
randomised MACs) move with their owner, so they are never matched, attached or sent.

These are **estimates, never fixes**: they are not part of the track, the distance,
the speeds, the stops or the endpoints. The trip page draws them as hollow pink
markers with an accuracy circle, from ten minutes before the trip to ten after
(never reaching into the car's previous or next trip), with a dashed line to the
first GPS fix (or from the last), labelled *Wi-Fi estimate (place / learned /
beaconDB)* and the place's name. Runs of scans at one spot are one marker. **Wi-Fi
estimates** on the map hides them.

### Networks seen here

A saved place lists the access points that are probably there: those the learned map
puts inside its circle (all cars together), and those heard in scans with no fix just
before a trip left the place or just after one arrived (15 minutes either side of the
first or last fix of that boot). Each shows its BSSID, how often it was seen, its
strongest signal and when it was last seen. Tick the ones that belong to the place and
save; at most 64. They are stored with the place and travel with an export.

### beaconDB

beaconDB is a public-domain Wi-Fi location database with an MLS/Ichnaea-compatible
API. It is asked only when neither a saved place nor the learned map knows a scan:

- `POST https://api.beacondb.net/v1/geolocate` with
  `{"considerIp": false, "fallbacks": {"lacf": false, "ipf": false}, "wifiAccessPoints": [{"macAddress": "…", "signalStrength": -60}, …]}`:
  the scan's BSSIDs and signal strengths (the strongest 20), and nothing else; no
  IP-address or cell fallback, so an answer is a Wi-Fi position or nothing.
- At least two access points, as the API requires.
- An identifying `User-Agent`, at most one request a second and 1000 a day.
- Every answer is cached by the scan's sorted BSSID set, so a set is never sent twice.
  `404` ("No location could be estimated") is cached as *unknown*; a failure is not
  cached and is retried after ten minutes (a minute's pause after a `429`).
- Nothing is ever submitted to beaconDB (no geosubmit).

It is on by default. Turn it off on the Places page (**Wi-Fi positions**, kept with
the saved places), or for the whole server with `NUXT_PLACES_BEACONDB=false`;
`NUXT_PLACES_EXTERNAL=false` turns it off too. Answers already cached keep being
used. Pages that show a beaconDB position credit it.

### An older store

Every Wi-Fi query is gated on the store having the objects (checked in
`information_schema` and remembered for a few minutes), so a store before
`store/v1.7` simply shows no Wi-Fi positions and no networks; nothing errors.
