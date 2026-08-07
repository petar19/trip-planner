# Our Trips — project docs

A generic, multi-trip, multi-city planner. Started as a single static HTML file; growing into
a properly phased build. Hosted on GitHub Pages (or similar static host). Backed by Firebase
(Auth + Firestore, optionally Storage + Functions later) for data and live sync between
whitelisted users.

**Keep this file updated whenever behavior, schema, or a design decision changes.** It's the
source of truth for anyone — human or AI — picking this project back up. When Claude Code
implements something from a phase below, update that phase's status and, if the schema changed,
update the schema section in the same pass.

---

## Stack

- **Frontend**: static HTML/CSS/vanilla JS. No build step, no framework, so deploy is just
  "commit the file." Revisit this only if the app outgrows what vanilla JS can comfortably do.
- **Auth**: Firebase Authentication. Google Sign-In only for now — email/password fallback deferred
  (not worth the extra UI/error-handling surface until it's actually needed).
- **Data**: Firebase Firestore (collections below).
- **Maps/routing**: OpenRouteService (free tier, OSM-based) for walking/driving distance+time
  estimates; Google Maps links (no API key needed) for anything transit-related or for a human
  to just look at and fill in manually. No self-hosted routing engine — not worth the
  infrastructure for two users.
- **Geocoding**: OpenStreetMap Nominatim (free, no key, CORS-enabled) — used by the Places tab's
  coordinate checker. Client-side calls only, respecting their ~1 req/sec usage policy.
- **In-app map**: Leaflet + OpenStreetMap tiles (CDN, no key, no billing) — see "Map + list view".
- **Place photos**: Wikipedia's API (free, no key, CORS-enabled), name+city text search for a
  representative thumbnail — see `places[].photo` in the schema above.
- **Currency conversion**: Frankfurter API (free, keyless, ECB-sourced rates) called client-side
  to convert a place's price into the trip's `defaultCurrency` for display. A place's currency is
  auto-suggested from its city via a static country→currency lookup table (best-effort, not
  exhaustive — always manually overridable). Conversion is display-only and skipped entirely if
  the trip has no `defaultCurrency` set or the rate fetch fails.
- **AI generation**: three tiers, all producing the same JSON shape (see "AI generation model" below).
- **File storage** (not yet enabled): Firebase Storage, gated behind the Blaze plan — see
  "Billing" section before enabling.

## Security model

Two independent layers, doing two different jobs — both required, neither optional:

1. **Firebase Auth** — who can sign in at all. Google Sign-In lets *any* Google account
   authenticate; it is not the access gate by itself.
2. **Firestore security rules** — who can read/write what, checked server-side on every request.
   This is the real gate. A frontend check (e.g. showing an admin panel only to one email) is a
   **UX convenience only** — it hides a button, it does not stop a direct write. Every
   security-relevant check must also exist as a rule, independent of what the UI shows.

**Whitelist is dynamic, not hardcoded in the rules file.** Emails live in a Firestore document
(`config/allowlist`) instead of being pasted into the rules text. Rules read that document via
`get()` to authorize requests, e.g.:

```
allow read, write: if request.auth != null &&
  request.auth.token.email in get(/databases/$(database)/documents/config/allowlist).data.emails;
```

Writing to `config/allowlist` itself is restricted to whoever is in its `admins` array (checked
the same way) — only the admin can grow the whitelist, and the app can show an "invite" UI only
to that account (frontend check, backed by the matching rule).

**`firebaseConfig` (apiKey, projectId, etc.) is intentionally public** — it identifies the
project, it does not grant access. Fine to commit to a public repo. Never do this with a Firebase
**service account key** or an **AI provider API key** — those are real secrets (see "AI generation
model" for how the API-key case is handled).

## Billing

Firebase's Spark (free) plan covers Auth and Firestore at this project's scale indefinitely.
**Storage (file uploads) and Cloud Functions (server-side AI proxy) both require the Blaze
(pay-as-you-go) plan** — Blaze includes the same free quotas as Spark, so realistic usage at
two-person scale should stay at $0, but a card must be linked and there's no hard automatic
spending cutoff (budget alerts are notifications, not a kill switch). Mitigation in use: a
virtual card with a small loaded balance as a hard cap on worst-case exposure. Worth loading a
little above the bare minimum, since card-verification holds are sometimes non-zero.

## Firestore schema

```
trips/{tripId}                     — small index, listed live in the trip picker
  {
    name, startDate, endDate,     // ISO date strings ("YYYY-MM-DD"), either/both optional.
                                   // Mirrors tripData.meta so the picker doesn't need a full
                                   // tripData fetch just to show dates — display string is
                                   // computed client-side (formatDateRange), never stored.
    updatedAt,
    cities: [ "Copenhagen, Denmark", ... ],   // multi-city support
    ownerEmail,
    participants: [ email, ... ]              // who can access this trip (Phase 6)
  }

tripData/{tripId}                  — trip content, fetched once per open, overwritten via
                                      Manage → Import (or, later, the in-app draft flow)
  {
    meta: {
      name, startDate, endDate,   // same as trips/{tripId} above — source of truth, mirrored
                                   // there on every edit via "Edit trip details"
      cities: [ { name, country, dateRangeWithinTrip } ],   // editable after creation too, not
                               // just at New Trip time — "Edit trip details" on the Overview tab
      summary,
      defaultCurrency,        // ISO code, e.g. "EUR" — trip-level (shared by all participants),
                               // not per-user. Optional; conversion display is skipped without it.
      preferences: {
        freeText,              // general notes not covered by the structured fields below
        numPeople,
        // NOTE: base of operations is NOT a preferences field — see places[].cat:["base"] below.
        budget: { max, realistic, perDay },   // plain numbers, in meta.defaultCurrency
        maxStepsPerDay,
        stopsPerRoute,          // target number of stops per generated route (not counting the
                                 // base of operations) — trip-level default, editable per-batch in
                                 // the AI route generation modal same as maxStepsPerDay already is
        travelMethods: [...],  // subset of "walking" / "public transport" / "car"
        wantToSee: [...],      // specific named places already wanted, free text
        placesToAvoid: [...],  // specific named things to avoid, free text
        catWant: [...],        // category-level preference, reuses the same preset+custom
        catAvoid: [...]        // category tags as places[].cat (see below)
      }
    },
    places: [
      {
        id, name, city, area,
        cat: [...],            // free-form category tags, lowercase. A fixed preset list is
                               // offered in the UI (food, museum, park/nature, shopping,
                               // landmark, nightlife) but custom values are freely allowed —
                               // this is how "food places" / "museums" work instead of separate
                               // top-level arrays (see note below). The Places tab filters by
                               // whichever cat values are actually in use. One reserved value,
                               // "base" — NOT offered as a preset chip in the normal place-add
                               // flow, only ever set via "Edit trip details" -> Base of
                               // operations (a Nominatim address search, not free text) — marks
                               // the (at most one) place that's home base for the trip. Stored as
                               // a real place — id:"base-of-operations", name defaults to the full
                               // resolved address (NOT a fixed literal like "Base of operations" —
                               // that collided with unrelated Wikipedia results, e.g. matched a UN
                               // building, and produced a useless Map search), coords/coordsSource
                               // set from the picked result — so it shows in the Places list and
                               // category filter like anything else, rather than a hidden
                               // preferences field. Editable afterward exactly like any other
                               // place (rename to the actual hotel, add links, etc.) — re-saving
                               // Trip Details only touches name/coords/coordsSource, preserving
                               // everything else already on the place. Clearing the search on save
                               // removes the place entirely.
        wantRating,            // 1–10, "how much I want to see this"; >7 ≈ main/required (Phase 4)
        price: { amount, currency, note },  // amount/currency null when there's no fixed price
                               // (e.g. "Pay per stall") — note then carries the free-text case.
                               // currency is auto-suggested from city→country on entry, always
                               // manually overridable. Display converts to meta.defaultCurrency
                               // via the Frankfurter API when the two differ (see "Stack").
        hours: { open, close, note },  // open/close are "HH:MM" 24h picker values, null if unset;
                               // note carries cases a simple range can't ("Always", "Guard change
                               // ~12:00", seasonal closures) — same pattern as price above
        note, certainty,
        wishlist: [ string, ... ],  // specific things wanted AT this place — which exhibits to
                               // see in a museum, which dishes to eat at a restaurant. Distinct
                               // from wantRating (how much you want to visit the place at all).
        coords: { lat, lng }, coordsSource: "ai" | "osm" | "user",  // see "Coordinates" below
        links: [ { label, url } ],  // arbitrary named links: official site, rules, gallery, etc.
                               // A few labels are offered as one-click presets in the place modal
                               // ("Official site", "Thumbnail", "Map") but the label is always
                               // freely editable — these aren't an enum. One label is special:
                               // "Thumbnail" (case-insensitive) is excluded from the normal
                               // clickable-links row in the Places list and used as that place's
                               // photo instead — same list the user already edits, no separate
                               // photo field or dedicated add/edit UI.
        source: { ai, user }   // booleans, not mutually exclusive. Set ai:true on AI-imported
                               // places; editing a place (any place) sets user:true without
                               // clearing ai — an edited AI place shows both. Rendered as small
                               // icons with a tooltip, filterable in the Places tab.
        photoChecked: boolean  // whether Wikipedia auto-lookup has been attempted, independent of
                               // whether it found anything — the result itself lives in links[]
                               // below, not a separate field. Auto-fetched (name+city text search
                               // against Wikipedia's API, free/no key/CORS via origin=*) the first
                               // time the Places list renders a place with photoChecked falsy,
                               // batched into a single write once the whole pending batch settles
                               // rather than one write per place. Deliberately name-based, not
                               // geosearch-by-coords — geosearch can return a merely-nearby
                               // article (e.g. an unrelated event held at the same venue) rather
                               // than one actually about the place, which showed a misleading
                               // photo in testing (worse still for a generic name like the old
                               // literal "Base of operations" — see the note above).
    // No separate `food` array. Restaurants/food stalls are just places with cat:["food"] —
    // same fields (price, hours, wishlist for "dishes to try", etc.) apply either way, and a
    // separate schema/tab would have meant duplicating most of the above for no real benefit.
    // The Places tab's category filter is how "show me the food places" works instead.
    routes: [   // Phase 4 — reusable location sequences, distinct from days
      {
        id, city, label,
        stops: [   // discriminated by type — a stop is either a place to visit or a break.
                   // placeId can be the cat:["base"] place itself — expected as the first and
                   // last entry when the trip has a base of operations set (see "Routing /
                   // planning" below); older routes may not have it, handled defensively there.
          {
            type: "place", placeId,
            note,       // planning note for THIS stop in THIS route specifically — deliberately
                        // separate from the place's own general `note` and from
                        // tripNotes.places[id].note (the Places-tab plan note), since the same
                        // place can appear in two routes with different context each time. Meant
                        // to surface in Phase 5 day-to-day execution once that's built; for now
                        // it's just stored.
            stayDuration,  // number of minutes, approximate — AI-suggested (asked for explicitly
                        // in the generation prompt) or hand-entered, editable in the route editor
                        // either way. null if unknown. Display: formatStayDuration() (hour-aware,
                        // e.g. "2h 15m" — stays run longer than travel legs so plain minutes read
                        // worse here than for travel.time).
            travel: [   // one or more alternative ways to reach the NEXT stop
              { type, distance, time, cost, details }
              // type: one of TRAVEL_LEG_TYPES (walk/metro/bus/train/taxi/ferry/car/bike) or a
              // free-text custom value picked via a "Custom…" option in the editor
              // distance: number of meters or null (display converts to km above 500m)
              // time: number of minutes or null
              // cost: plain number or null, always assumed to be in meta.defaultCurrency — no
              // per-leg currency field
              // details: free text, e.g. line numbers/platform — not meaningfully typeable
              // Routes saved before this became numeric may still have free-text strings here
              // (e.g. "600m") — shown as-is, never parsed/reformatted
            ]
          },
          {
            type: "break",
            note,       // what the break is, e.g. "Lunch at a café"
            duration,   // number of minutes or null — not a clock time, routes aren't tied to real
                        // schedules until Phase 5. Was free text originally; made numeric together
                        // with stops[].stayDuration so route total time (see below) can sum both
                        // consistently — same formatMinutes() display as stayDuration/travel.time
            travel: []  // a break is still a point you travel away from — same shape as above
          }
        ],
        totalWantRating,   // always computed by summing referenced places' wantRating, never
                           // trusted from AI output or hand-entered directly
        generatedBy: "ai" | "algorithm" | "manual",   // original creation method, never changed
        edited: boolean    // set true on any save through the route editor, regardless of
                           // generatedBy — mirrors how editing an AI place sets source.user:true
                           // without clearing source.ai (see places[].source above)
      }
    ],
    // Stops saved by the very first version of AI route generation (before the type field
    // existed) only ever have {placeId, travel} — read defensively everywhere:
    // stop.type || (stop.placeId ? "place" : "break"). No migration needed.
    days: [
      { label, date, city, assignedRoutes: [ routeId, ... ] }
      // Auto-synced to meta.startDate/endDate (syncDaysToTripDates()), not manually managed —
      // extending the trip adds days, shortening it drops them. label defaults to "Day N"
      // (chronological) on creation but is user-editable and persists across re-syncs (matched
      // by date, not array position). city is free text, not auto-inferred from
      // meta.cities[].dateRangeWithinTrip.
      //
      // assignedRoutes order = display/execution order on the Day-by-day tab. Assignment
      // (which day(s) a route belongs to) is edited on the Routes tab per route, not here —
      // toggling a day chip there pushes/splices the route's id into this array directly. No
      // dayIds field on routes[] — a route's day membership is found by scanning tripData.days,
      // not stored redundantly on the route (single source of truth). A route removed by a
      // shrinking date range just drops out of assignedRoutes with the day; the route itself is
      // untouched, no separate cleanup needed anywhere else.
    ],
    events: [ { name, certainty, desc } ],
    budget: [ { category, estimate, note } ]
  }

tripNotes/{tripId}                 — user-editable live state, listened via onSnapshot
                                      (this is what makes cross-device sync live)
  {
    places: {
      [placeId]: {
        done,   // reserved for Phase 5 (execution mode) — not exposed in the Places tab UI,
                // which is a planning/catalog view, not a "have we done this" tracker
        note,   // general planning note (e.g. "book ahead"), editable from the Places tab
        linkedDocs: [ docId, ... ],
        ratings: { [uid]: { value, note } }   // per-person rating+note, Phase 5 — keyed by Firebase
                                               // uid, entered during execution mode, distinct from
                                               // the plan-time `note` above
      }
    },
    routeStops: {
      // Key REVISED from the original `routeId+placeId` to `${routeId}:${stopIndex}` — breaks
      // have no placeId at all, and a place can legitimately appear twice in one route, so
      // position is the only thing that's always unambiguous.
      [`${routeId}:${stopIndex}`]: {
        done,     // shared boolean, any participant can toggle, last-write-wins
        note,     // shared execution-time note — distinct from the route editor's per-stop
                  // planning note (stops[].note) and from each rating's own note below
        ratings: {
          [uid]: { value, note, email }
          // value: 1-10, same scale as places[].wantRating. note: that person's own note.
          // email: denormalized at write time — there's no uid→email lookup for anyone but
          // currentUser, so without this there'd be no way to label whose rating is whose
        }
      }
    },  // Day-by-day tab execution state (Phase 5) — see "Day-by-day" below
    documents: {
      [docId]: { title, type, confirmationNumber, url, note, createdAt }
      // url points to an external link (Drive/email/etc.) today; could point to a Storage
      // download URL later if file uploads are enabled — same field either way.
    }
  }

config/allowlist                   — single doc, admin-managed
  { emails: [...], admins: [...] }

publicTrips/{tripId}               — Phase 7, open read (allow read: if true), written only via
                                      an explicit "Publish" action. A filtered COPY of tripData +
                                      places/notes — never includes tripNotes.documents
                                      (confirmation numbers etc. stay private even when published).
```

`placeId`/`routeId` are slugified strings today, not stable UUIDs — renaming a place orphans its
notes/links. Worth revisiting once the app does more than one person's worth of editing.

### Coordinates

Routing/clustering needs real `lat`/`lng`, not just a Google Maps search string. Process:
AI generation includes an approximate coordinate guess per place → app geocodes independently via
OpenStreetMap Nominatim (free, no key) → validation screen shows **both** side by side so the user
can eyeball whether the difference is meaningful before accepting.

✅ **Implemented, live and map-integrated**: "📍 Check coordinates" button in the Places tab
(badge shows how many need checking — any place with no `coords` at all, or `coordsSource:"ai"`
not yet cross-checked; `"osm"`/`"user"` are treated as settled and skipped). A background loop
geocodes the queue sequentially via Nominatim, ~1/sec per their usage policy (attribution shown
in the review card); geocoding retries once without the `area` term if the first query comes back
empty, since an informal area name can zero out an otherwise findable place. Both the review card
and the "checking next place…" waiting card show a live progress line — "Checked N/total (P%) —
still checking in the background…" — updated after every place the background loop finishes
(auto-confirmed or not), not just ones that reach manual review; the line disappears once the
background loop is done. The user reviews one place at a time in a card next to the list
(`#coords-fixer-card`) — independent of and can't get ahead of the background pace — while the map
shows the old (AI guess, gray) and new (Nominatim, teal) points together with a dashed connecting
line (the closest honest approximation of "an arrow between them" without a Leaflet plugin for
real arrowheads). Each of the old/new coordinate lines also has a "View on map ↗" link, built from
the exact lat/lng (`mapLink('${lat},${lng}')` — Google's search endpoint accepts a raw coordinate
pair as the query, precise in a way a name-based search can't be) — good for the actual "does this
look right" check: the embedded OSM tile map confirms relative position, but a real Google Maps tab
(satellite/street view) is what actually confirms the place. Accept writes
`coords`/`coordsSource:"osm"` immediately for that one place and advances; Skip advances without
writing; Stop halts the background loop too. Runs automatically right after an AI place import,
since freshly-imported places always need this. Places Nominatim can't find at all are auto-skipped
without a review step — there's nothing to decide, so no card interrupts the flow for them — and
listed by name in the end-of-run summary instead, left for manual entry via the place edit form.
Likewise, if the Nominatim result is within `COORDS_AUTO_CONFIRM_THRESHOLD_M` (100m, via haversine
distance) of the existing coordinates, it's auto-confirmed and written silently — same "nothing to
decide" logic, since a sub-100m difference is typically the same building. This write sets
`coordsSource:"osm"` same as a manual Accept, so the place is excluded from `coordsNeedsCheck` (and
thus this queue) on the next run — auto-confirmed places stay confirmed, they don't need re-asking.
A place with no previous coordinates at all is auto-confirmed the same way once Nominatim finds
anything for it — there's nothing to compare against, so a found location is strictly better than
none and isn't worth a yes/no. Auto-confirmed and no-previous-coords places are each named in their
own line in the end-of-run summary. The auto-confirm write is wrapped in try/catch so one failed
write can't kill the rest of the background queue — a failure falls back to a normal manual-review
card instead of silently dropping the place. The "Check coordinates" button guards against
re-entrancy — clicking it again while a run is already active (each place takes ~1.1s+ network
latency, so a run of any real size takes a while) shows an alert instead of starting a second
concurrent loop; two loops sharing the same queue/counters was a real bug that made places look
like they got re-checked over and over without their `coordsSource` ever actually landing.

End state after a full run: every checked place ends up with `coordsSource:"osm"` (auto-confirmed
or accepted) or is left untouched and named in the "not found" summary line — none are left sitting
at `coordsSource:"ai"` unless the user explicitly Skipped or Stopped partway through.

✅ **Per-place re-check**: a "📍 Check coordinates" button next to every place in the Places list
(alongside Edit/Delete) re-checks that one place through the exact same pipeline — same
auto-confirm-if-≤100m-or-no-prior-coords, same manual review card otherwise — but bypasses
`coordsNeedsCheck` entirely, so it works even on a place already `coordsSource:"osm"`/`"user"`.
For when the user edits a place to point at a different real-world location (same restaurant name,
different branch) and wants fresh coordinates without re-running the whole trip. The review card's
"Old: ... (label)" text and the map's gray marker tooltip describe whichever source the previous
coordinates actually came from (`coordsSourceLabel()`) rather than always saying "AI guess", since
this path routinely reviews non-AI-sourced places too.

## AI generation model

Three tiers, deliberately offered as options rather than one fixed path — user picks per trip,
or mixes across sections of the same trip:

1. **Manual** — fill in the same structured fields by hand, no AI involved.
2. **Copy-paste to any AI** — app generates an instruction template (optionally split into
   smaller per-section templates, e.g. places / routes / days, to stay under any given AI's
   output-length limits, and so different sections could even go to different AI tools if the
   user wants). User runs it themselves, pastes the resulting JSON back in, app validates
   structure and shows a preview/edit screen before anything is saved.
   ✅ **Implemented for places**: "✨ Generate with AI" button in the Places tab. Setup (city,
   rough count, plus the full preferences form from "Edit trip details" — people, budget,
   base of operations, travel methods, want/avoid lists, category preferences — prefilled from
   the trip's saved settings but editable here for just this one batch, without writing back to
   the trip) → generated instruction text (includes the full JSON shape spec and the existing
   place names to avoid re-suggesting) with a copy button → paste-back textarea → strict
   validation (every item needs at least
   `name`; malformed items block the whole import with a per-item error list, nothing partial) →
   checklist preview (place + one-line summary, checkbox per item, likely duplicates —
   case-insensitive name match against existing places — pre-unchecked) → "Import selected"
   appends the checked ones to the live trip's `places[]` directly. Note: this is narrower than
   the full Draft flow below — it's an "add more places to an already-saved trip" tool, so it
   writes straight to Firestore after the checklist step rather than staging in `localStorage`
   first. Not yet built for routes/days, and coordinates the AI supplies aren't cross-checked
   against Nominatim yet (see "Coordinates").
3. **In-app direct call** — the app calls an AI API itself. Requires a small serverless proxy
   (Firebase Cloud Function is the natural choice, same project as everything else) that holds
   the AI provider's API key server-side and verifies the caller's Firebase ID token before
   forwarding the request — **the API key must never be embedded in client-side code**, unlike
   `firebaseConfig` this one is a real secret. Tier 3 produces the exact same JSON shape as tier 2;
   it's tier 2 with the copy-paste step automated away. ⬜ Not started — the Places generation
   dialog has a disabled placeholder button for this, since it depends on the Cloud Function +
   Blaze billing described in "Billing", neither of which exist yet.

All three tiers feed the same validation → preview → edit pipeline. The full new-trip Draft flow
below (staging in `localStorage` before an explicit "Save trip") isn't built yet; the places-only
generator above writes directly to an already-saved trip instead.

## Draft flow (Phase 2)

1. User starts a new trip. ✅ **Revised from the original plan**: "New trip" and "Edit trip
   details" are now the same modal (one shared form, a `tripModalIsNew` flag switches Save between
   creating new `trips`/`tripData`/`tripNotes` docs vs. updating the current trip) — so all the
   richer preferences (budget breakdown, people, base of operations, travel methods, want/avoid
   lists, category preferences) are available right away instead of requiring a follow-up edit.
2. Pick a generation tier (above) for content, and later, separately, for routing (Phase 4).
3. Result goes to a preview/edit screen — same screen whether it came from AI or was typed
   manually, and whether starting from scratch or editing existing content.
4. **Everything accumulates in `localStorage` as a draft**, not Firestore, so closing the tab
   doesn't lose progress. A "your drafts" list reads pending drafts out of localStorage.
5. Explicit "Save trip" promotes the draft into real `trips` / `tripData` / `tripNotes` documents
   in Firestore. Only at this point does it become visible to other participants.

## Routing / planning (Phase 4) — current thinking, not locked

Goal: generate several candidate **routes** per city — main locations (rating >7) threaded
through with lower-rated "mini" locations — that are geographically coherent (cluster-then-order,
not "Edinburgh → São Paulo → Tokyo"), then let the user assign routes to days. Routes can repeat
across days and multiple routes can be assigned to one day as explicit alternates (useful for a
weather swap on a leg between two main locations).

**Decision: no custom clustering/TSP algorithm for v1.** The underlying approach (geographic
clustering + nearest-neighbor ordering + local swaps to balance total rating per route) is a
well-trodden, tractable problem at city scale — but it's real engineering effort, and the app
already has working infrastructure for AI-generated JSON with a validate/preview/edit pipeline.
v1 reuses that: feed the AI a rated, coordinate-tagged place list plus the clustering rules, get
candidate routes back in the same three-tier model as content generation. A genuine in-app
algorithm is a fair v2 once it's clear whether AI-generated routes are good enough in practice.

**Decision: every route starts and ends at the trip's base of operations**, if one is set
(`places[]` entry with `cat:["base"]` — see schema above). **Revised from an earlier version of
this doc**: the base was first treated as *implicit* — deliberately excluded from `stops[]`,
shown only as a computed "Start:"/"End:" bookend in the UI, with the AI told not to include it.
In practice this wasn't enough to reliably influence the actual generated routes even when
restated in free text, so it's now the opposite: the base is a real, explicit entry in `stops[]`
(first and last), required by the AI instruction and pre-populated by default when creating a
route manually. `getEligiblePlacesForRoutes()` still excludes it from the "regular" eligible-place
list/count-hint (it isn't a place to *visit*), but it's separately appended to what's actually sent
to the AI and to the manual editor's valid placeId set. Display still falls back to the old
computed bookend for routes saved before this change (`stops[]` without the base in it) via
`isBaseStop()`, so nothing already saved breaks — see the stop-shape schema note above.

✅ **Implemented (generation only)**: a "Routes" tab (between Places and Events) with "✨ Generate
routes with AI", mirroring the Places AI-generation pipeline exactly (setup → instruction template
→ paste-back JSON → validate → checklist preview → import). Setup picks one of the trip's cities
plus max-steps-per-day/travel-methods (prefilled from trip preferences, editable per-batch like the
places generator), a candidate-route count, and a target stops-per-route count (`stopsPerRoute` —
trip-level default, editable per-batch same as max-steps-per-day); a live hint reports how many of
that city's places have coordinates and will be used vs. how many are missing coordinates and will
be skipped (routes need real coordinates to cluster on). The instruction embeds the eligible-place
list (id/name/wantRating/cat/coords) *plus* the base of operations as one more real entry in that
same list, and the clustering rules from this section. Getting an AI to reliably honor "start and
end at the base" needed more than saying it once — the instruction states it as an explicit
`IMPORTANT:` line up front *and* repeats it as a reminder right before the schema, both times
naming the base's exact `id` and requiring it as `stops[0]` and the last entry — repetition being
one of the few practical levers against an LLM quietly dropping a single buried instruction in a
longer prompt, not a hard guarantee. The AI supplies `label`, an ordered `stops` array (each
`{placeId, stayDuration, travel[]}}` — `stayDuration` an approximate-minutes guess the AI is
explicitly asked for, `travel[]` optional distance/time/cost/details, not computed against a real
routing API); everything else (`id`, `city`, `generatedBy:"ai"`, `totalWantRating`) is set by the
app itself, never trusted from the AI's output — `totalWantRating` in particular is computed by
summing the referenced places' `wantRating` (the base contributes 0, having none), since letting
the AI self-report an aggregate invites drift. Validation hard-rejects (blocks the whole import,
same as place-generation) any route whose `stops[].placeId` doesn't exactly match one of the
eligible places' ids *or* the base's id; every validated stop is tagged `type:"place"` (AI
generation stays places-only — breaks are a manual-editor-only concept, see below). The list view
groups routes by city; each card shows the route label, a provenance tag ("✨ AI-generated" or
"✎ Manual", plus " (edited)" once `edited` is true), total want rating, and the stop sequence as
`Start: <base> → stop (stay) → stop → ... → End: <base>` — `Start:`/`End:` label whichever stop
actually *is* the base (`isBaseStop()`) rather than being separately injected, falling back to the
old computed-bookend behavior only when the base genuinely isn't one of the stops — with per-leg
travel info and stay duration shown inline where supplied, break stops rendered as
`☕ Break (duration) — note`, and each place stop linking out via the existing `mapLink()` helper.

✅ **Manual route editor** (`#route-editor-modal`, opened by "+ Add route manually" or by "Edit" on
any existing route card — same dialog either way, AI-generated or manual; wide layout, 1140px, so
form and map both have room): a brand-new route is pre-populated with the base as both the first
and last stop when one is set (removable/reorderable like any other stop, not locked in — editing
an *existing* route doesn't auto-inject it, to avoid silently mutating already-saved data just from
opening the editor). Pick a city, set a label, then build the stop list directly on the left —
search-and-add places (scoped to the selected city, base included as a normal addable result now
that it's a real stop; the search box shows every place in that city on focus even with an empty
query, "in case you forgot the exact name," matching the same space-separated-keywords/AND/
case-insensitive matching as the Places tab search via a shared `placeMatchesKeywords()` helper;
each result shows its category, want rating, and a "Map ↗" link), "+ Add break" for a time/note
break item, per-stop planning note and an editable approximate stay duration (minutes) for place
stops, a travel-to-next-stop row between each pair of stops, up/down buttons to reorder (not
drag-and-drop — simpler and reliable on touch) and a remove button per stop. A live map on the right
shows the
draft route's numbered stops (see below) and updates on every structural change (add/remove/
reorder) — no separate refresh step. Opening the editor collapses any currently-expanded route card
first, since the editor's own map replaces the need for that one to stay open (also avoids two live
Leaflet instances of the same route disagreeing with each other). No validation beyond requiring a
label — unlike the AI paste-back path this is direct hand-editing, not untrusted external input, so
there's nothing to reject. Saving always sets `edited:true` and recomputes `totalWantRating`;
`generatedBy` is set to `"manual"` for brand-new routes and left untouched when editing an
AI-generated one — editing doesn't erase where a route came from. This dialog is the intended
eventual home for an in-app clustering algorithm too (the "generate roughly N routes" decision
below) — not built yet, v1 still has none, but the editor was built so a future "auto-arrange"
action has somewhere to live without restructuring the UI.

Each route card shows a computed **total time** (`computeRouteTotalTime()`) at the top, above total
want rating — the sum of every place stop's `stayDuration`, every break's `duration`, and every
travel leg's `time` that's actually been entered. Shown as `~<formatMinutes result>` (the `~`
because it's a lower bound, not a guaranteed-complete total — a stop or leg left blank just doesn't
contribute); omitted entirely if nothing in the route has any duration/time entered at all.

**Travel leg fields are now typed, not free text**: `type` is a preset picker (walk/metro/bus/
train/taxi/ferry/car/bike, `TRAVEL_LEG_TYPES`) with a "Custom…" option revealing a free-text input
for anything else; `distance` is a number of meters; `time` is a number of minutes; `cost` is a
plain number, always assumed to be in the trip's `meta.defaultCurrency` (no per-leg currency
field) — free text here was judged too bug-prone (inconsistent units, unparseable later). `details`
stays free text (line numbers, platform info — not meaningfully typeable) and got its own full-width
line in the editor instead of squeezing into the same row as the other four fields. The four typed
fields render as two rows of two inside the editor (`.modal-grid`, reused for its built-in
`label{margin-top:0}` rule) with a persistent `<label>` naming the field and its unit (e.g.
"Distance (meters)") above each input — placeholders alone weren't enough, since a placeholder
disappears the moment a value is typed, leaving bare numbers with no visible unit at a glance.
Display
formatting (`formatLegDistance`/`formatLegTime`/`formatLegCost`, used by both the compact card
sequence and the expanded view) shows meters as-is under 500m and converts to km (1 decimal) above
that, appends "min" to time, and appends the trip's currency to cost if one is set. Routes saved
before this change have free-text strings in these fields (e.g. `"600m"`) — shown as-is rather than
parsed, since regex-guessing units on old free text defeats the point of typing the field; the
editor's numeric inputs simply won't prefill from a non-numeric legacy value. The AI generation
instruction (`routesTravelSchemaDoc()`, now a function of the trip's currency rather than a static
const) asks for the same numeric shape and preset vocabulary; `validateRoutesResponse()` coerces a
numeric-looking string to a number if the AI ignores the instruction, else falls back to `null`
(never a bare 0, which would misrepresent "free"/unknown as an actual zero cost).

✅ **Expandable route view**: an "Expand ▾"/"Collapse ▴" button per route card reveals a
Places-tab-style split list+map scoped to that one route (`.route-split` — same idea as
`#places-split`, new CSS since there can be many route containers rather than one fixed ID). Each
place stop's row also shows that place's categories and its own general `note` (labeled distinctly
from the stop's route-specific note as "Note for this stop:" so the two don't read as the same
thing) — this view specifically, since it's where there's room, and because an unfamiliar name
(a Danish place name, say) is hard to place from the name alone without that context. Only
one route expanded at a time — expanding a different one (or opening the route editor) tears down
the previous route's Leaflet map instance first (`.remove()`), since each expansion creates its own
`L.map()` bound to a per-route container id. The map shows numbered markers (`L.divIcon`, 1-based,
visiting order) for place-stops that have coordinates — breaks and coordless places are skipped on
the map but still listed — connected by a polyline. No arrowhead plugin: numbered markers plus a
connecting line was chosen deliberately over adding a new Leaflet dependency, consistent with the
coordinate-fixer's compare view already making the same "honest approximation over a plugin"
tradeoff. Clicking a list row pans/zooms the map to its marker and opens its popup; clicking a
marker scrolls to and highlights the matching list row — same bidirectional pattern as
`focusMapOnPlace`/`focusListOnPlace` in the Places tab, just re-implemented per-route
(`focusRouteMapOnStop`/`focusRouteListOnStop`) since the marker/row sets are route-scoped, not
global. Two real bugs surfaced building this: a modal could render behind a map left open on the
page underneath it (Leaflet's own control z-indexes can exceed a low modal z-index — `.modal-backdrop`
is now `z-index:1100`, safely above Leaflet's ~1000 ceiling, and the editor also proactively
collapses any open route map rather than relying on stacking order alone); and a map whose container
was still hidden (`display:none`, pre-open) when markers were added, or whose deferred
`fitBounds`/`setView` callback fired after the map had already been `.remove()`d (e.g. expand then
immediately edit), threw a real Leaflet `_leaflet_pos` error — fixed by always giving a new map a
defined view (`setView([20,0],2)`) before adding markers, only creating/populating a map after its
container is visible, and guarding the deferred fit-view callback with an "is this still the active
map" check.

✅ Assigning routes to days is implemented — see "Day-by-day tab" below (day-assignment chips live
on each route card here, on the Routes tab).

⬜ **Deliberately deferred**: real distance/time via OpenRouteService (numbers are still AI-suggested
or hand-entered estimates, not computed against a routing API). A genuine in-app clustering
algorithm remains a fair v2 once it's clear whether AI-generated routes are good enough in practice
(the manual editor is where it would plug in).

⬜ **Known limitation, deferred**: `travel[]` is stored on the "from" stop and describes the leg to
whichever stop is next — it belongs to the *edge* between two stops, not to either stop itself.
Reordering in the manual editor (`route-stop-up`/`route-stop-down`) now clears the travel data on
every stop whose adjacency actually changed (`clearStopTravel()` — up to 3 stops around a swap: the
one before it and the swapped pair; 1 stop on remove: the new predecessor of whatever follows), so
a reorder can no longer leave *wrong* distance/time/cost silently attached to a leg that no longer
exists — the field goes blank instead, prompting re-entry. What's still missing is *recomputing* a
correct value automatically instead of just clearing it. Doing that well needs either the AI to
work out every affected leg (expensive/slow for a paste-back workflow) or, once Tier 3 (direct
in-app AI calls, see "AI generation model") exists, an on-demand per-edge recalculation triggered
by each reorder with the result cached against the (fromPlaceId, toPlaceId) pair so the same
requery isn't repeated. Not worth building before Tier 3 exists, and reordering isn't expected to
be a frequent action in practice — flagged here rather than solved now.

## Day-by-day tab (Phase 4 assignment + Phase 5 execution)

**Resolved from an earlier version of this doc**: Phase 4 and Phase 5 were described separately
without saying how they map onto the UI. They don't split into two tabs — the "Day-by-day" nav tab
is specifically the *execution* surface (Phase 5: completion, ratings, notes), not a planning tool.
**Assignment** (which day(s) a route belongs to) happens on the **Routes tab** instead — a route is
already being evaluated there, so tagging it with a day is contextual; **ordering**, for a day with
more than one route, happens on the Day-by-day tab, since that's the one place a day's full route
list is visible together.

✅ **Implemented**, as a three-level drill-down rather than all days rendered at once (deliberately
— there's no reason to load a whole trip's worth of checklists/maps when only one day matters at a
time):

- **Level 1 — day picker** (`#days-day-select`): every `tripData.days` entry, `renderDays()`
  auto-selecting whichever `date` matches today (`todayIso()`) the first time it runs, else the
  first day — always overridable, works for past/future days too.
- **Level 2 — route overview**: empty state if the day has no assigned routes; loads directly if
  it has exactly one; a button-row picker (reusing the `.cat-chip` visual, `isRouteComplete()`
  defaulting to the first not-fully-done route) if it has more. Reuses the Routes tab's expandable-
  view machinery (`renderExpandedRouteHtml`/`initExpandedRouteMap`'s patterns, `.route-split`/
  `.route-stop-row`, numbered markers + polyline) rather than rebuilding it, with two differences:
  completed stops get a `.stop-done` modifier (moss background + ✓), and *every* stop row is
  clickable into Level 3 — not just ones with coordinates, since marking something done doesn't
  need a map marker. Map pane is `position:sticky` (`.day-route-map-pane`) since a day's stop list
  can run long. The route picker's up/down buttons reorder `days[].assignedRoutes` directly
  (immediate write, no draft/save step); "Remove" splices a route out of the day without deleting
  the route itself.
- **Level 3 — single-stop view**: opened by clicking a stop row. No map. Full stop detail (place
  categories/description, the route's per-stop planning note, stay duration; or a break's
  note/duration) plus the actual execution controls — a completion checkbox, "Your rating" (1-10 +
  your own note, prefilled from `ratings[currentUser.uid]`), a read-only line for any other
  participants' ratings (via the denormalized `email`), and a shared execution note. All fields
  auto-save on `change` (same "no separate save step outside modals" convention as the rest of the
  app) via `db.collection('tripNotes').doc(currentTripId).set({routeStops:{[key]:{...}}},
  {merge:true})` — same merge-write pattern already used for `tripNotes.places[id].note`.
  "← Back to route" returns to Level 2.

**Real bug found and fixed while building this**: `isoDatesInRange()` originally built each date
with `new Date(iso+'T00:00:00').toISOString().slice(0,10)` — `toISOString()` converts to UTC,
which silently shifts the date back a day for anyone in a timezone ahead of UTC (local midnight is
still "yesterday" in UTC). Fixed to read back the date with the same local getters
(`getFullYear`/`getMonth`/`getDate`) used to construct it, matching how `todayIso()` already did
this correctly — never mix `toISOString()` with locally-constructed dates in this codebase.

⬜ **Deliberately deferred**: reaching Level 3 is manual (tap the stop) — no auto-navigation into
the next undone stop's detail, and no Next/Previous buttons within Level 3 to walk a route without
returning to Level 2 each time. A real transition leg between two routes assigned to the same day
is shown as a plain divider, not an editable/fillable gap. `tripData.places[placeId].done`/
`ratings` (place-level, route-independent tracking, separate from `routeStops`) stays unbuilt.

## Map + list view (Phase 6)

Split/resizable view, list and map simultaneously, either can be minimized. For the actual
embedded map (not just "open in Google Maps" links, which stay as-is for real navigation):
**Leaflet + OpenStreetMap tiles**, not the Google Maps JS API — Leaflet needs no API key and no
billing account at this scale; Google's embed API now also requires Cloud Billing attached even
for free-tier usage, no reason to take on that requirement for an in-app overview map.

✅ **Implemented, scoped to Places**: the Places tab is a split view — list + map (Leaflet + OSM
tiles, CDN, no key) side by side on desktop (map pane `position:sticky` so it stays in view while
the list scrolls), map pinned sticky above the list on narrower screens too (media query, not a
drag handle — "resizable" above is aspirational for a future generic version) at a compact height
by default. Either pane has a maximize button that collapses the other — on mobile this doubles as
minimize/maximize for the map (maximize-list hides the map entirely, maximize-map grows it to
65vh). Map plots every place with `coords`, popup with
name/city/area/wantRating. Clicking a place row focuses/pans the map to its marker and opens the
popup (revealing the map pane if currently maximized-list); clicking a marker scrolls to and
briefly highlights the corresponding list row, clearing active category/source/search filters first
if they'd otherwise hide it (revealing the list pane if currently maximized-map). Not yet
generalized to other tabs/content — this is Places-specific, not the fully generic Phase 6 view.
The list pane's "Places" header shows a live count next to it — just `(N)` normally, `(N of total)`
while a category/source/search filter narrows the list. A search box above the category chips
filters by space-separated keywords (all must match — AND, not OR), case-insensitive, against
`JSON.stringify(place).toLowerCase()` rather than named fields — simplest way to search
"everything" (name, city, area, note, wishlist, links, category tags, etc.) without hand-picking
and maintaining a field list.

## Multi-user sharing (Phase 7)

- A trip's `participants` array (emails) gates access to that specific trip document — separate
  from, and narrower than, the global `config/allowlist` (allowlist = "can ever sign in and use
  the app at all"; `participants` = "can see this particular trip"). Rules for `trips`/`tripData`/
  `tripNotes` check membership in that trip's `participants`, not just global allowlist membership.
- "Add collaborator" appends an email to `participants` — restricted to the trip's `ownerEmail`
  to avoid uncontrolled invite chains, open question below on whether to loosen this.
- "Duplicate trip" copies a trip's content into a new document owned solely by the duplicating
  user, severing the live connection — this is the "send someone my draft without inviting them
  to my live trip" case.
  ✅ **Implemented** (ahead of the rest of Phase 7, as a standalone "Copy trip" in the Overview
  tab): reuses the Trip Details modal in a third mode alongside new/edit — prefilled from the
  current trip like editing, including the Base of operations field (shown and editable here too,
  not hidden — transparent that a base is coming along, and changeable for just this copy). A
  places checklist also appears (checkbox per place, Select all/Deselect all, all checked by
  default) covering everything else, including the base place itself as a normal row — but the
  base field stays authoritative: on save, the base-of-operations block runs on top of whatever
  the checklist produced, so changing the address adds/updates the base place even if its
  checklist row was left unchecked, and clearing the field removes it even if the row was checked
  (same "existing fields preserved, only name/coords/coordsSource overwritten" merge as edit mode
  — see "Coordinates" schema note above). Save creates fresh `trips`/`tripData`/`tripNotes` docs —
  owned solely by whoever clicked Copy (`ownerEmail`/`participants`, not inherited from the
  original); `tripNotes` starts empty, nothing carries over from the source trip's live state.

## Static/public sharing (Phase 7)

"Publish" copies a filtered subset (places, routes/days, notes — **not** `tripNotes.documents`,
since those may hold confirmation numbers) into `publicTrips/{tripId}`, an openly readable
collection. The app checks the URL for a share parameter (`?share=tripId`) on load and, if
present, skips sign-in and renders that trip read-only straight from the public collection.
Un-publishing = deleting that one document; nothing else is exposed. Chosen over generating a
downloadable static HTML file, since a live link is simpler UX than emailing a file of unknown
rendering fidelity.

## File uploads (Phase 8, not yet enabled)

Documents currently store a *link* to a file kept elsewhere (Drive, email, etc.), not the file
itself — Firebase Storage requires the Blaze plan for any usage as of Feb 3, 2026 (previously
had its own free tier; see "Billing"). When enabled: real PDF upload via Firebase Storage,
gated by the same allowlist/participants rules pattern as Firestore; the `documents.url` field
then just points at a Storage download URL instead of an external link — no schema change needed,
same field either way. Location *photos* don't need this at all — a plain `imageUrl` field
pointing at any public image works without touching Storage or billing.

## Preloaded location data (Phase 9, stretch)

An offline script (not part of the live app) queries free sources — Wikidata/Wikipedia for
notable places with a popularity signal (pageviews), GeoNames for city/country data — to build a
static starting-point dataset for popular cities, bundled as a separate lazily-fetched JSON
(not inlined into the HTML, to avoid bloating initial load). Same source (GeoNames) also backs
city/country **autocomplete**: a preloaded list for instant, offline, rate-limit-free suggestions,
falling back to a live Nominatim query for anything obscure not in the preloaded set.

## Offline persistence

**Correction from an earlier version of this doc**: this was previously described as a limitation.
It isn't — Firestore's SDK supports it, it just needs one call to turn on:
`firebase.firestore().enablePersistence()` (or `enableIndexedDbPersistence()` on the modular SDK),
called once right after creating the `db` instance. Once enabled: reads serve instantly from a
local IndexedDB cache and work fully offline; writes made offline queue locally and sync
automatically on reconnect, in order. Should be turned on, not treated as a non-goal. Enable
multi-tab support alongside it, since both people may have the app open in more than one tab.

## Design system

- **Colors** (CSS custom properties): `--paper`/`--ink` = background/text base; `--harbor` (teal)
  = water/transit; `--mustard` = food; `--moss` = outdoor/parks; `--red` = alerts/danger/delete.
- **Fonts**: Fraunces (serif, headers) / Inter (sans, body) / JetBrains Mono (data, labels).
- **Components**: rounded cards (`.card`), pill tags (`.tag`, `.badge`), sticky tab nav, day-stop
  vertical timeline with a dashed connector.
- Keep new UI consistent with these rather than introducing new colors/fonts per feature.

## Current status

- ✅ App shell + Firebase Auth wired up, Google Sign-In working end-to-end
- ✅ `firestore.rules` deployed (dynamic allowlist per "Security model" above), `config/allowlist`
  doc created — Firestore access confirmed working end-to-end
- ✅ Trip picker (trips/tripData/tripNotes wired up against the finalized schema), New Trip modal
- ✅ Places tab: add/edit/delete against the finalized schema, structured price + currency
  conversion (see "Stack"), city autocomplete + default-city/currency suggestion, plan-time notes
  (no "done" toggle — that's Phase 5, see tripNotes schema note above), per-place wishlist
- ✅ Category system: preset + custom `cat` tags per place, filter bar in the Places tab. No
  separate Food tab/schema — food places are just `cat:["food"]` places (see schema note above)
- ✅ AI place generation, Tier 2 (instruction template + paste-back JSON + validation + duplicate-
  flagged checklist preview) — see "AI generation model". Tier 3 (direct API call) is not built
- ✅ Place source tracking (AI vs user, see places[].source above), filterable
- ✅ "Edit trip details" (Overview tab): editable dates/cities/currency after creation (fixes AI
  generation being stuck with no city to pick if none was set at New Trip time) plus the full
  rich preferences structure, which the AI instruction builder now pulls in automatically
- ✅ Coordinate checker/fixer via Nominatim, live map-integrated one-at-a-time review, auto-runs
  after AI import — see "Coordinates"
- ✅ Places tab is a split list+map view (Leaflet + OSM tiles) with maximize toggles and two-way
  row/marker focus, sticky-and-compact on mobile — see "Map + list view". Places-specific, not the
  fully generic Phase 6 view
- ✅ "New trip" and "Edit trip details" are now one shared modal — see "Draft flow"
- ✅ Base of operations: Nominatim address search (debounced), stored as a `cat:["base"]` place
  rather than a preferences field — see schema note above and "Routing / planning"
- ✅ Place photo thumbnails via Wikipedia, expandable to a lightbox, lives in `links[]` as a
  "Thumbnail" entry rather than a separate field — editable there for any place, auto-found or
  not — see `places[].links` and `photoChecked` above
- ✅ Delete trip and Copy trip live in the Overview tab, next to "Edit trip details" (not Manage /
  Import — those are trip-level actions, not import/export). Delete (confirm, removes all three
  docs; the existing `trips` onSnapshot listener handles picking a new active trip or showing the
  empty state afterward) is a plain red button, no "danger zone" framing. Copy trip: see
  "Duplicate trip" under Phase 7 above. Manage / Import tab itself is still just a stub — Import
  from JSON is not built
- ✅ Routes tab (Phase 4): AI route generation mirroring the Places AI-generation pipeline, a manual
  route editor with a live map (also used to edit AI-generated routes — add/remove/reorder stops,
  break items, per-stop planning notes, typed travel legs with unit-aware distance/time/cost and a
  preset+custom type picker), list grouped by city with Edit/Delete, per-route day-assignment chips,
  and an expandable per-route list+map view (numbered markers + connecting line, bidirectional
  list/map focus) — see "Routing / planning" above. Real travel-time lookups and an in-app
  clustering algorithm are explicitly deferred
- ✅ Day-by-day tab (Phase 5): day picker → route overview (list+sticky map, reusing the Routes tab's
  expandable-view code) → single-stop execution view (completion checkbox, per-person 1-10 rating +
  note, shared note) — see "Day-by-day tab" above. `days[]` auto-syncs to the trip's date range.
  Reaching a stop's detail view is manual (no auto-advance to the next undone stop yet)
- ⬜ Everything else in this file is planned, not built

An earlier draft of `index.html` (superseded) had a trip picker, tabs, and per-place done+note
editing built against an ad-hoc schema (`stars`/`q` fields, no `routes` collection) that predated
the schema finalized in this doc. That draft was scrapped in favor of rebuilding against the
current schema from the ground up, starting with the shell + auth.

## Open questions (genuinely undecided — flag if implementing, don't just guess)

- Should "add collaborator" be owner-only, or can any participant invite others?
- If only one person rates a place, does that count, or does the UI nudge for both?
- Exact JSON size/complexity where template-splitting (Phase 2) actually becomes necessary —
  no real number tested yet.
- Whether Phase 4's AI-generated routes end up good enough that the "real algorithm" v2 is ever
  worth building at all.

## How to request changes

Describe the desired behavior in plain language; a screenshot of current UI helps for anything
visual. After implementing a change, update this file's relevant section (schema, phase status,
or open questions) in the same pass — don't let it drift out of sync with the code.
