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
- **Documents**: a trip's own Google Drive folder (not Firebase Storage) — listed live via the
  Drive API v3 (`files.list`, a plain restricted API key, no OAuth needed since the folder is
  publicly link-shared) and optionally uploaded to via a session-scoped Google OAuth token
  (Firebase's `GoogleAuthProvider` requesting an extra `drive.file` scope at sign-in). See
  "Documents tab" — this is what keeps file storage entirely off the Blaze plan.
- **File storage** (Firebase Storage, not used): superseded by the Google Drive approach above for
  documents — see "Documents tab" and "File uploads" below. Gated behind the Blaze plan; see
  "Billing" section if it's ever needed for something Drive doesn't cover (e.g. place photos a user
  uploads directly rather than a Wikipedia lookup).

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

**Being allowlisted only means "can sign in" — it doesn't mean "can see every trip."** A second,
narrower layer sits on top: each `trips/{tripId}` doc's own `participants` array, enforced in rules
for `trips`/`tripData`/`tripNotes` alike (see "Multi-user sharing" below for the full mechanics).
This was implemented after the fact and closed a real gap — the rules originally only checked
`isAllowed()`, so any allowlisted user could read/write *every* trip regardless of membership.

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

**Two independent cost surfaces once Tier 3 (direct AI generation, see "AI generation model") is
live**: Firebase Blaze itself (Cloud Functions invocations — has its own generous free tier, e.g.
2M invocations/month, so realistic hobby-scale usage of the `generateAiContent` function should
stay $0 regardless of the virtual card's balance) and the AI provider's own billing (Gemini API,
via Google AI Studio — a completely separate quota/account from Firebase billing; staying on
Gemini's free tier means AI usage never touches the Blaze card at all). The virtual-card mitigation
above is about worst-case Firebase-side exposure specifically, not the AI provider.

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
      docsFolderId,           // Google Drive folder ID backing the Documents tab (see "Documents
                               // tab" below) — extracted from a pasted folder share link via
                               // extractDriveFolderId(), editable in "Edit trip details". null/
                               // unset disables folder browsing/upload there (manual links still
                               // work); the folder itself must be shared "Anyone with the link".
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
        stops: [   // NEW shape (post-interstop-unification, see "Routing / planning" below) —
                   // places only, no more break-as-stop. placeId can be the cat:["base"] place
                   // itself — expected as the first and last entry when the trip has a base of
                   // operations set; older routes may not have it, handled defensively there.
          {
            type: "place", placeId,
            note,       // planning note for THIS stop in THIS route specifically — deliberately
                        // separate from the place's own general `note` and from
                        // tripNotes.places[id].note (the Places-tab plan note), since the same
                        // place can appear in two routes with different context each time.
                        // Surfaced in the Day-by-day execution view (Level 3).
            stayDuration  // number of minutes, approximate — AI-suggested (asked for explicitly
                        // in the generation prompt) or hand-entered, editable in the route editor
                        // either way. null if unknown. Display: formatMinutes() (hour-aware,
                        // e.g. "2h 15m").
          }
        ],
        interstops: [   // array with stops.length-1 entries — interstops[i] describes everything
                        // between stops[i] and stops[i+1]. Each entry is an OBJECT wrapping a list
                        // of ZERO OR MORE items — { items: [...] } — NOT a bare array; Firestore
                        // rejects "Nested arrays are not supported" for an array directly inside
                        // another array, and interstops is itself an array, so each gap's list has
                        // to be wrapped in a map value instead. This bit the very first real save
                        // after the interstop model shipped (every manual-editor save and every AI
                        // import failed with that exact error) — unwrapInterstopGap()/
                        // normalizeRoute() (index.html) are the only code that has to know about
                        // the wrapper; everything else works with plain arrays via normalizeRoute().
                        // items: [] means the two stops need no travel note at all (e.g. two shops
                        // right next to each other in the same building), more than one item means
                        // the leg genuinely has multiple parts (e.g. a short walk then a break, or a
                        // bus then a walk). Replaces the older model where a break was its own
                        // interleaved stop and each stop carried at most one travel[0] leg — that
                        // conflated "a thing you visit" with "a thing between two visits" and
                        // couldn't express zero-travel adjacency or a multi-part gap. Each item:
          { type, time, distance, cost, note }
          // type: "break" or one of TRAVEL_LEG_TYPES (walk/metro/bus/train/taxi/ferry/car/bike) or
          // a free-text custom value picked via a "Custom…" option in the editor
          // time: number of minutes or null
          // distance: number of meters or null — only meaningful for non-break types, stored 0 for
          // a break (never hidden as a separate field)
          // cost: plain number or null, always assumed to be in meta.defaultCurrency — no per-item
          // currency field; null means "free"/unknown, never a bare 0
          // note: free text, e.g. "lunch at a café" for a break or a platform/line number for
          // transit — kept as one field for both cases rather than splitting break-note vs.
          // travel-details, since the two never coexist on the same item
        ],
        totalWantRating,   // always computed by summing referenced places' wantRating, never
                           // trusted from AI output or hand-entered directly
        generatedBy: "ai" | "algorithm" | "manual",   // original creation method, never changed
        edited: boolean    // set true on any save through the route editor, regardless of
                           // generatedBy — mirrors how editing an AI place sets source.user:true
                           // without clearing source.ai (see places[].source above)
      }
    ],
    // Routes saved before the interstop unification store the OLD shape instead: stops[]
    // interleaves place/break entries (a break is its own stop with no placeId, discriminated by
    // `type`) and each stop carries at most one `travel[0]` leg describing the trip to the next
    // stop — `{ type, distance, time, cost, details }`, same field meanings as an interstop item
    // above (details ~= note). Not migrated — normalizeRoute(route) is the one place that
    // understands both shapes and reconstructs the equivalent {places, interstops} view on the
    // fly; every renderer and the editor read a route through it rather than touching
    // stops/interstops directly. Saving through the editor always writes the new shape, so an old
    // route only "upgrades" once someone actually edits and saves it. Stops from the very first
    // version of AI route generation (before even the `type` field existed) only ever have
    // {placeId, travel} — read defensively via stop.type || (stop.placeId ? "place" : "break").
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
    expenses: [   // Phase (post-Phase-7 roadmap) — freestanding manual costs not tied to a
                  // specific stop visit. Renamed from the original schema's always-empty
                  // `budget: []` stub, which nothing ever read or wrote — see "Budget tab" below
                  // for how this combines with tripNotes.routeStops[key].ratings[uid].spent
                  // (execution-time spend, already in the schema) into one view.
      {
        id, amount, currency,   // currency defaults to meta.defaultCurrency but is independently
                                 // editable per expense — a manual expense might legitimately be
                                 // logged in a different currency than the trip default (e.g. a
                                 // flight paid at home, or cash spent in the destination's own
                                 // currency — see routeStops[key].ratings[uid].currency below,
                                 // which now follows the same pattern).
        convertedAmount,   // amount converted into meta.defaultCurrency via the Frankfurter API
                           // (see "Stack"), resolved ONCE at save time (saveExpense()) rather than
                           // re-derived live every time the Budget tab renders — so the displayed
                           // conversion reflects the exchange rate when the expense was actually
                           // logged, not whatever rate happens to be current whenever someone
                           // later opens Budget. null when currency matches meta.defaultCurrency
                           // (nothing to convert), no defaultCurrency is set, or the rate fetch
                           // failed at save time — renderBudget() falls back to a live getRate()
                           // call only in that last case.
        category,   // single free-form tag, reusing CATEGORY_PRESETS + custom exactly like
                    // places[].cat — but singular, not an array: one expense is one category,
                    // not several tags the way a place can be
        note, date,          // date is an ISO string, optional
        paidByEmail,         // optional — who paid, defaults to currentUser at entry time but not
                              // enforced afterward
        relatedPlaceId       // optional — links the expense to a places[] entry
      }
    ]
  }

tripNotes/{tripId}                 — user-editable live state, listened via onSnapshot
                                      (this is what makes cross-device sync live)
  {
    places: {
      [placeId]: {
        done,   // reserved for Phase 5 (execution mode) — not exposed in the Places tab UI,
                // which is a planning/catalog view, not a "have we done this" tracker
        note,   // general planning note (e.g. "book ahead"), editable from the Places tab
        ratings: { [uid]: { value, note } },  // per-person rating+note, Phase 5 — keyed by Firebase
                                               // uid, entered during execution mode, distinct from
                                               // the plan-time `note` above. Still unbuilt — place-
                                               // level, route-independent, separate concept from
                                               // routeStops[key].ratings below (which IS built).
        wishlistChecked: { [wishlistIndex]: boolean }
                // Day-by-day Level 3 only — lets a place's wishlist (places[].wishlist) act as a
                // checklist of mini-goals ("try the rye bread", "see the old oven") rather than
                // just a read-only list. Keyed by array index into that place's wishlist, not the
                // item text itself — simplest possible key, at the cost of drifting if the wishlist
                // is later reordered/edited; judged an acceptable tradeoff since that's rare.
                // Shared across all participants and all routes that visit this place (a place's
                // wishlist doesn't belong to any one route), same as `note` above.
      }
    },
    routeStops: {
      // Key REVISED from the original `routeId+placeId` to `${routeId}:${stopIndex}` — breaks
      // have no placeId at all, and a place can legitimately appear twice in one route, so
      // position is the only thing that's always unambiguous.
      [`${routeId}:${stopIndex}`]: {
        done,     // shared boolean, any participant can toggle, last-write-wins. NOT a manual
                  // checkbox in the UI — auto-set true by the app the moment this stop's `ratings`
                  // entry (below) gets a value, non-empty note, or a spent amount, on the theory
                  // that any of those is itself strong evidence you did it. Only ever set to true,
                  // never back to false, so clearing a review can't silently un-mark a stop someone
                  // already confirmed. `note` (a separate shared execution-time note) was dropped
                  // entirely — see ratings[uid].note below.
        ratings: {
          [uid]: { value, note, spent, currency, convertedAmount, paidByEmail, email }
          // value: 1-5 (stars) — a DIFFERENT scale from places[].wantRating's 1-10, deliberately:
          // wantRating answers "how much do I want to go", this answers "how was it", and forcing
          // them onto the same scale would conflate two different questions. Rendered as a
          // full-width row of 5 tappable stars (mobile-first), not a number input. A compact
          // average-rating summary (`stopRatingSummaryHtml()`) also shows in the Day-by-day Level 2
          // list next to each stop, so a rating is visible without drilling into Level 3.
          // note: this person's own review — the ONE place to write text about a visited stop.
          // Used to be two separate fields (this personal one, plus a shared non-personal `note`
          // on the routeStops entry itself) that read as duplicates with no clear reason to pick
          // one over the other; the shared field was removed and this one relabeled "review" in
          // the UI. spent: plain number or null — logged per-person since whoever fills in the
          // review is generally who'd know the amount; the Budget tab (see "Budget tab") is what
          // actually aggregates this across stops. currency: the currency `spent` was actually
          // entered in — REVISED from an earlier version where this field didn't exist at all and
          // `spent` was simply assumed to be in meta.defaultCurrency; a `<select>` next to the
          // amount now lets it be logged in local currency instead (e.g. paying in DKK on a trip
          // whose default is EUR), defaulting to the trip's own currency but listing the stop's
          // place's local currency (via city→country) right after it for convenience. Absent on
          // entries saved before this shipped — still treated as meta.defaultCurrency, the
          // original convention. convertedAmount: `spent` converted into meta.defaultCurrency,
          // resolved ONCE at save time (saveDayStopRating(), via the Frankfurter API — see
          // "Stack") rather than re-derived live every time Budget renders, same reasoning and
          // same field name as tripData.expenses[].convertedAmount above — so a review logged in
          // DKK today keeps showing today's rate even if rates move before anyone opens Budget.
          // null when currency matches the default, no default is set, or the rate fetch failed.
          // paidByEmail: who actually paid — independent of who's logging the review (the
          // reviewer isn't necessarily the payer), a <select> of trip participants defaulting to
          // the current user, same "paid by" field and default the Budget tab's manual-expense
          // modal has. Added after `spent` shipped, so older entries won't have it — Budget's
          // collectStopLinkedExpenses() falls back to `email` (the reviewer) when absent. email:
          // denormalized at write time — there's no uid→email lookup for anyone but currentUser, so
          // without this there'd be no way to label whose rating (or spend) is whose
        }
      }
    },  // Day-by-day tab execution state (Phase 5) — see "Day-by-day" below
    // Two kinds of entry share this map, distinguished by `source` — see "Documents tab" below
    // for the full design (a trip's own Google Drive folder, listed live, layered with this
    // Firestore metadata; no Storage/Blaze involved).
    documents: {
      [docId]: {
        source,   // "manual" for a plain pasted link, absent/undefined for metadata on a file
                  // that's actually listed live from the trip's Drive folder (meta.docsFolderId)
        title, type, url,   // only meaningful for source:"manual" — a Drive-backed entry's name/
                             // type/view-link always come from the live Drive listing itself
                             // (never stored, so they can't go stale if the file is renamed),
                             // fetched by docId = the Drive file's own id
        note, confirmationNumber,   // shared by both kinds — free text either way
        relatedPlaceId,   // optional — links this document to a places[] entry (see
                           // "Documents tab"); many documents can point at the same place
        createdAt
      }
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

**Real bug fixed**: the main "📍 Check coordinates" button was wired directly as
`addEventListener('click', startCoordsFixer)`, so the click `Event` itself got passed through as
`startCoordsFixer`'s `explicitPlaces` parameter — truthy, so it skipped the "check everything"
branch, then crashed on `explicitPlaces.map is not a function` since an `Event` isn't an array. This
parameter was added later for the per-place re-check button below, which correctly wraps its call
(`startCoordsFixer([place])`) — the main button's listener was never updated to match and broke
outright. Fixed by wrapping it the same way: `addEventListener('click', ()=>startCoordsFixer())`.

✅ **Per-place re-check**: a "📍 Check coordinates" button next to every place in the Places list
(alongside Edit/Delete) re-checks that one place through the exact same pipeline — same
auto-confirm-if-≤100m-or-no-prior-coords, same manual review card otherwise — but bypasses
`coordsNeedsCheck` entirely, so it works even on a place already `coordsSource:"osm"`/`"user"`.
For when the user edits a place to point at a different real-world location (same restaurant name,
different branch) and wants fresh coordinates without re-running the whole trip. The review card's
"Old: ... (label)" text and the map's gray marker tooltip describe whichever source the previous
coordinates actually came from (`coordsSourceLabel()`) rather than always saying "AI guess", since
this path routinely reviews non-AI-sourced places too.

✅ **Paste coordinates directly**: a "📋 Paste coordinates" button next to "📍 Check coordinates" on
every place row reveals a small inline text field for exactly what Google Maps' right-click "Copy
coordinates" puts on the clipboard — a single `"lat, lng"` string, e.g.
`"55.672894869554874, 12.59440710268119"` — rather than requiring the full place-edit modal's two
separate latitude/longitude fields. Added because the modal round-trip (open Google Maps → right
click → copy → switch back to the app → open Edit → scroll to the lat/lng fields → split the
clipboard value across two inputs by hand) was slow for something that's really just "paste one
string." `parseLatLngPaste()` splits on the comma, validates both halves are finite numbers within
real lat/lng ranges (`±90`/`±180`), and rejects anything else — deliberately narrow, no N/S/E/W
suffixes or degree-minute-second support, since that's not what this specific paste source ever
produces. Enter in the field submits the same as clicking Save. A valid paste writes directly
(`coords` + `coordsSource:"user"`, preserving every other field on the place) the same narrow way
`writeConfirmedCoords()` already does for the coordinate checker's Accept action; an invalid paste
shows an inline error next to the field rather than a blocking `alert()`.

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
   case-insensitive name match against existing places — pre-unchecked, plus an optional card
   review — see below) → "Import selected" appends the checked ones to the live trip's `places[]`
   directly. Note: this is narrower than the full Draft flow below — it's an "add more places to an
   already-saved trip" tool, so it writes straight to Firestore after the checklist step rather than
   staging in `localStorage` first. Not yet built for routes/days, and coordinates the AI supplies
   aren't cross-checked against Nominatim yet (see "Coordinates").

   **Checklist rows** (`renderAiPreview()`) now carry the same richness the real Places tab list
   does, not just a name and one-line summary: a thumbnail (see the Wikipedia pre-fetch below, blank
   while still loading, blank-with-no-photo once checked and nothing found — same
   `.place-thumb`/`.place-thumb-loading`/`.place-thumb-blank` classes the Places tab itself uses), a
   "Map ↗" link, the place's first non-thumbnail link if the AI supplied one (labeled whatever the
   AI called it — usually the official site, but not assumed to be, since the AI schema doesn't
   guarantee that label), and a "🖼 View card" button that jumps straight into the card review dialog
   at that specific place. **Revised from a `<label>`-wrapped row**: once links and a button needed
   to live inside each row, a `<label>` wrapping everything meant any click — including on a link or
   the expand button — also toggled the checkbox (the exact label-click-forwarding conflict this
   codebase has already hit and solved elsewhere, e.g. the advanced route search's `.rs-place-row`).
   Fixed the same way: a plain `<div class="ai-preview-row">` with its own click handler that bails
   out on `e.target.closest('a, button, input')` before toggling the checkbox.

   **Optional card review** (`#ai-card-review-modal`, "🖼 Review as cards" button on the checklist
   screen, or "🖼 View card" on any individual row — both funnel through `openAiCardReview(startIdx)`,
   the row version just opens at that place instead of index 0): the checklist stays the
   default/primary interaction — this is a bigger, roomier secondary dialog that opens *on top of*
   the checklist for looking at candidates one at a time instead of scanning a compact list, not a
   replacement flow. Each card shows a large photo (see the Wikipedia pre-fetch below — a
   dashed-border placeholder only for a place actually checked and found to have none, not simply
   "not fetched yet") at full card width, then name/wantRating/certainty, city/area, category tags,
   price, hours, a coordinates-provided/not-provided line (useful context for the coordinate-check
   step that follows import), the place's note, wishlist, and links — **always starting with "Map
   ↗"** — all in a single-column, generously-spaced layout that also works on mobile
   (`.ai-card-review-box`, capped at 640px/94vw). Three always-colored decision buttons — **✕
   Reject** (red), **? Maybe** (mustard), **✓ Approve** (moss) — fill solid once selected for the
   card on screen. Deciding is really just "check/uncheck the corresponding checklist checkbox"
   (Reject/Approve) plus membership in an `aiPreviewMaybe` `Set` for "Maybe" (which halves that
   place's `wantRating` — `Math.max(1, Math.round(rating/2))` — at import time, on the theory that
   "maybe" means uncertain-but-not-a-no). Deciding on the *last* card closes the dialog and returns
   to the checklist automatically, rather than leaving the user stranded on the last card needing an
   explicit "Done" click; deciding on any earlier card just advances to the next one. The "Done —
   back to list" button and a backdrop click both still work as a manual "I'm done early" exit too.
   `sanitizePlaceItem()` — the per-item validation body extracted out of `validateAiResponse()` — is
   the shared function behind this pipeline and the JSON Import feature below, so there's one
   definition of "what a valid place object looks like" rather than two that could drift apart.

   **Real bug: Reject appeared to do nothing** (checked places stayed checked). The checklist's
   checked state was never tracked anywhere except the live DOM checkbox's own `.checked` property —
   fine until `renderAiPreview()` (called every time the card dialog closes, to reflect whatever was
   decided) rebuilds `#ai-preview-list`'s *entire* `innerHTML` from scratch, recomputing each row's
   checkbox purely from duplicate-detection (`isDup`). That silently reset every checkbox back to
   "checked unless a likely duplicate," discarding every Reject/Approve decision made in the card
   view the moment the user returned to the checklist — the exact same bug class (checked state not
   tracked independent of a `.innerHTML`-rebuilding render) the Routes checklist had already hit and
   fixed via `routesPreviewChecked`. Fixed the same way: an `aiPreviewChecked` `Set`, seeded from the
   duplicate check right after validation, is now the actual source of truth — `renderAiPreview()`
   reads from it instead of recomputing, and `setAiPreviewChecked(idx, checked)` (mirroring this
   app's `setRouteSearchCheck()`) is the one place that updates it, keeping the `Set` and the DOM
   checkbox in sync regardless of which one triggered the change (a row click, a direct checkbox
   click, or a card-view decision). `ai-import`'s "Import selected" now reads `aiPreviewChecked`
   directly rather than querying `.ai-preview-check:checked` in the DOM, since the `Set` is the
   thing guaranteed to be current. Verified live (not just by reasoning about the render order):
   rejecting a place, then forcing a `renderAiPreview()` rebuild, then checking that place's actual
   DOM checkbox — confirmed unchecked, where before the fix it would have reverted to checked.

   **Photos fetched before import, not just after** (`fetchAiPreviewPhotos()`): the real Places
   tab's Wikipedia lookup (`fetchPlacePhotoUrl()`, see "Place photo thumbnails" below) only ever ran
   post-import, so every candidate in both the checklist and card review showed no photo at all —
   not the point of a "big photo" card review. Reused directly against the in-memory
   `aiPreviewPlaces` draft array (nothing written to Firestore, same `photoChecked`/`links:
   [{label:"Thumbnail"}]` shape a saved place gets) as soon as validation succeeds, in the
   background — re-renders whichever of the checklist/card view happens to be open as results land,
   same "don't block on it" pattern `fetchMissingPhotos()` already uses. Because the fetched
   `photoChecked`/`links` carry straight through into the actual imported place object (`toAdd` in
   the import handler references the same `aiPreviewPlaces[i]`), the real `fetchMissingPhotos()`
   correctly skips re-fetching what was already found here — not a duplicated lookup, just done
   earlier than before.

   **Two setup-screen shortcuts** (`#ai-build-and-direct-call`, `#routes-build-and-direct-call`,
   next to "Generate instructions"): build the same instruction text (still shown on the
   instructions screen exactly as clicking "Generate instructions" would — nothing about that step
   is skipped, just not waited on) and immediately fire the Tier 3 call by simulating a click on the
   instructions screen's own "✨ Generate via AI directly" button, rather than requiring the extra
   click once there. The Routes version only shows in AI (paste-back) mode — Algorithm mode has no
   instructions/direct-call step at all (see `setRoutesGenMethod()`).

   **Real bug found and fixed**: neither `ai-build`→`ai-step-instructions` nor
   `ai-validate`→`ai-step-preview` (nor their Routes equivalents) ever hid the *previous* step when
   advancing — only the initial `openAiModal()`/`openRoutesModal()` and the Cancel buttons reset
   visibility. Every step's content stayed in the DOM and visible, stacking vertically as the user
   progressed — reported as "the card review button is bugged, shown below the validate-and-preview
   button, partially visible," which is exactly what three unhidden steps stacked on top of each
   other looks like (the setup form, then the full paste-back textarea and its own Validate button,
   *then* the checklist with the card-review button, all on screen at once, several scrolls down).
   Confirmed via a live DOM check (`classList.contains('hidden')` on all three step divs after
   simulating each button click) before and after the fix, not just by reasoning about the CSS.
   Fixed by explicitly hiding the step being left at every forward transition, in both modals.

   **"Back" buttons, not just Cancel** (`#ai-back-2`/`#ai-back-3`, `#routes-back-2`/`#routes-back-3`,
   next to Cancel on the instructions and preview steps of both modals): previously the only way off
   the instructions or preview screen was Cancel, which closes the *whole* modal and discards
   everything — no way to step back one screen while keeping what's already been built/pasted.
   Back steps back exactly one screen (preview → instructions → setup); Cancel still fully closes,
   unchanged. The Routes preview step's Back button has to know *which* path got there, since
   Algorithm mode skips the instructions screen entirely (setup → preview directly) — it checks
   `routesGenMethod` and returns to setup instead of instructions when the route was algorithm-
   generated.

   **"🖼 View card" moved to the row's far-right edge**: previously grouped inline with the Map/
   official-site links below the place name: now its own flex item at the end of `.ai-preview-row`
   (`align-self:center`, row's middle `<div>` carries `flex:1` so it consumes the remaining space
   and the button sits flush against the row's right edge) — a clearer "primary row action, always
   in the same place" position, standard for this kind of list-row-with-action-button layout.

   **"Done — back to list" positioning, revised twice**: originally relied on `.modal-actions`'s
   usual `position:sticky; bottom:0`, same as every other modal's action bar — reported showing
   above the card content instead of pinned below it. First fix tried `position:fixed; bottom:24px;
   right:24px`, sidestepping sticky's scroll-container/content-height fragility entirely — but
   `fixed` positions relative to the *viewport*, not this dialog, so it rendered outside the
   dialog's own bounds on an actual screen, and the now-empty `.modal-actions` bar was still there
   underneath it, an empty sticky strip overlapping `#ai-card-controls`. **Final fix**: no
   `.modal-actions` bar in this dialog at all — the button is `position:absolute; top:24px;
   right:30px` inside `.ai-card-review-box` (which carries `position:relative` to anchor it),
   landing in the dialog's own top-right corner next to the "Review places" title (`h3` given
   `padding-right:170px` so a longer title would wrap around the button rather than run under it).
   Immune to scroll position and to the fixed-vs-dialog coordinate confusion, since it's positioned
   relative to the dialog itself either way. **Needed its own copy of `.btn-save`'s look**: that
   button's actual background/padding/border-radius/font-weight all live under the scoped rule
   `.modal-actions .btn-save`, not a bare `.btn-save{...}` — moving the button out of
   `.modal-actions` silently stripped all of that, leaving an unstyled browser-default button
   ("missing css"). Fixed by giving `#ai-card-done` its own explicit copy of the same declarations
   rather than depending on that parent-scoped rule. `.ai-card-review-box` was also given
   `max-height:95vh` (up from the base `.modal-box`'s `85vh`) — this dialog's content (a large photo
   plus full place detail) routinely needs the extra room before a scrollbar should kick in.
3. **In-app direct call** — the app calls an AI API itself. Tier 3 produces the exact same JSON
   shape as Tier 2; it's Tier 2 with the manual "run it yourself and paste back the result" step
   automated away, not a separate code path — `buildAiInstruction()`/`buildRoutesInstruction()`,
   `validateAiResponse()`/`validateRoutesResponse()`, and the whole preview/checklist pipeline are
   all unchanged and fully shared with Tier 2.

   ✅ **Implemented, provider: Google Gemini**. A small Firebase Cloud Function
   (`functions/index.js`, `generateAiContent`, a callable function) holds the Gemini API key
   server-side (Cloud Secret Manager via `defineSecret('GEMINI_API_KEY')` — never sent to or
   embedded in the client, unlike `firebaseConfig`/`DRIVE_API_KEY`/`ORS_API_KEY` which are
   intentionally public) and forwards a prompt to `generateContent` on `gemini-3.5-flash-lite`
   (free-tier eligible as of this writing — bump the model id in the function if Google
   retires/renames it; check ai.google.dev/gemini-api/docs/pricing for current free-tier options).
   **Revised within days of first deploy**: originally shipped as `gemini-2.5-flash-lite`, which
   started 404ing for this key almost immediately — "This model models/gemini-2.5-flash-lite is no
   longer available to new users. Please update your code to use models/gemini-3.5-flash-lite."
   Google's own error response named the exact fix, so the model id is now `gemini-3.5-flash-lite`.
   Worth treating `GEMINI_MODEL` as something to actually check periodically rather than "set once
   and forget" — this suggests Gemini's free-tier model lineup churns faster than the constant's own
   original comment assumed.
   **Why Gemini over OpenRouter or Anthropic directly**: no separate account/billing surface beyond
   Firebase's own (Google AI Studio key, same Google account), a real free tier with generous
   limits for a 2-person hobby app (~15 RPM / 1000 requests/day on Flash-Lite), and it's a
   purpose-built model rather than OpenRouter's rotating pool of smaller free community models. The
   tradeoff, made knowingly: Gemini's *free* tier lets Google use submitted content to improve its
   products (human-reviewable) — the *paid* tier doesn't. Worth revisiting if that becomes a
   concern; the Cloud Function's provider call is isolated to one small file, so swapping providers
   later doesn't touch the client.

   **Auth/authorization, not just "signed in"**: a callable function (`onCall`, not a plain HTTPS
   endpoint) gets `request.auth` populated automatically once the Firebase client SDK's ID token is
   verified — but per "Security model" above, being signed in via Firebase Auth doesn't mean being
   *allowed*; the allowlist is the real gate, normally enforced by `firestore.rules`, which doesn't
   protect a Cloud Function at all. So `generateAiContent` re-checks the caller's email against
   `config/allowlist` itself (a `get()` via the Admin SDK, which bypasses security rules — the same
   cross-document pattern `firestore.rules` already uses) before doing anything else, mirroring the
   Firestore-side check rather than trusting "signed in" alone.

   **Response handling**: Gemini sometimes wraps JSON in a ` ```json ` fence despite the prompt's
   explicit "no markdown, no code fences" instruction — a human pasting by hand into Tier 2 can just
   delete it, but there's no human in this loop, so the function strips a wrapping fence
   defensively (`stripCodeFence()`) before returning text, rather than pushing that special case
   onto the client's existing `JSON.parse()`-based validators. A non-`STOP` `finishReason` (safety
   block, hit `MAX_TOKENS`, etc.) is surfaced as a specific error rather than returning a truncated
   string that would just fail validation with no useful explanation.

   **Client side**: a "✨ Generate via AI directly" button next to "Copy to clipboard" on the
   instructions screen (both Places and Routes generation) calls `generateAiContent` with the same
   instruction text already built for Tier 2, drops the returned text straight into the same
   paste-back textarea, and clicks the same Validate button programmatically — landing on the exact
   same preview/checklist/card-review screen a manual paste would. On any failure (not
   signed in/allowlisted, network error, Gemini error) the button re-enables and shows a message;
   the paste-back textarea and manual flow are still right there as a fallback, always. While
   waiting, the status line next to the button shows a small CSS spinner (`.spinner`, a bordered
   circle animated via `@keyframes spin`) plus "Generating with AI…" — cleared on both the success
   path (overwritten by the "Generated — reviewing the response now." message) and the error path
   (explicitly cleared before the error message is written to the separate error line, so a failure
   can't leave it spinning forever). One `callAiDirect()` implementation backs both the
   instructions-screen button and the setup-screen shortcut below, so the spinner covers both entry
   points automatically.

   **Deploy**: `firebase.json`/`.firebaserc` at the repo root point at the `functions/` codebase
   (Node 22 runtime). Required, one-time, outside this repo: (1) the Firebase project on the Blaze
   plan (see "Billing" — Cloud Functions cannot run on Spark at all), (2) a Gemini API key from
   Google AI Studio, set as a Cloud Functions secret via `firebase functions:secrets:set
   GEMINI_API_KEY` (run interactively, so the raw key value never has to be pasted anywhere else),
   then `firebase deploy --only functions`. Both are done — **deployed and live**
   (`generateAiContent`, v2 callable, `us-central1`, Node 22 — confirmed via `firebase
   functions:list`). Also ran `firebase functions:artifacts:setpolicy` (1-day image retention) once
   deployed, since Gen 2 functions otherwise accumulate container images in Artifact Registry
   indefinitely — a small but real ongoing storage cost the CLI itself warns about post-deploy.

   **Real bug caught at first deploy attempt**: `admin.firestore()` (the old namespaced
   `firebase-admin` API) threw `TypeError: admin.firestore is not a function` during Firebase's
   pre-deploy source analysis — `firebase-admin` v14 (the version actually installed) dropped that
   surface in favor of the modular API. Fixed by switching to `const { initializeApp } =
   require('firebase-admin/app')` / `const { getFirestore } = require('firebase-admin/firestore')`.
   Worth remembering for any future Cloud Function in this project: don't assume the classic
   `admin.X()` namespaced style still works, check which major version is actually installed.

   Verified end-to-end before handing back for in-browser testing: `node --check` on the function
   file; an initial `firebase deploy --only functions` attempt (before Blaze/the secret existed)
   correctly got as far as the Blaze-plan gate, confirming `firebase.json`/`.firebaserc`/
   `functions/package.json` were valid; after the fix above, deploy succeeded; and an
   **unauthenticated smoke test** (`curl` directly against the function's HTTPS trigger URL, no ID
   token) correctly returned `401` / `{"error":{"status":"UNAUTHENTICATED"}}` rather than crashing
   — confirms the deployed code runs and the auth check works. A full authenticated generation
   (as a signed-in, allowlisted user, through the actual UI) still needs manual testing in the
   browser — that part needs a real Firebase Auth session, which can't be done from the CLI.

⬜ **Idea, blocked on Tier 3 — "Ask AI about this place"**: a per-place action, visible both in the
Places tab and in Day-by-day's single-stop execution view (Level 3, the review screen), that lets
the user ask the AI to say more about the place or fact-check the data already saved for it (hours,
price, whether it's still open, etc.) — a live, on-demand call, so it needs Tier 3's Cloud Function
proxy to exist first; doesn't fit the paste-back model. Not designed beyond the concept yet — open
questions: what UI (a modal? an inline expand?), what gets sent to the AI (just the place's saved
fields, or also live web search/grounding — a real fact-check needs the latter, since the AI's own
training data can't confirm current hours), and how a response should be surfaced (freeform text?
specific flagged discrepancies against the saved fields?).

⬜ **Idea, blocked on Tier 3 — "What's nearby?"**: an ad-hoc query for when the user wants to do
something off-route or spontaneous, reachable from Day-by-day (and possibly Places) — free text like
"I want to eat burgers or pizza nearby" or "I want to see X", answered by combining two sources: (1)
the trip's own saved places within a configurable radius (default e.g. 1km, adjustable) of wherever
the user currently is in the plan, and (2) live AI-suggested general options nearby, not limited to
what's already saved (same web-search/grounding question as "Ask AI about this place" above). Results
get an "add to route" and/or "add to places" action. Not designed beyond the concept — open
questions: exact UI entry point, how "current location" is derived when the user isn't mid-route,
and how a chosen result gets reconciled into `places[]`/a route's `stops[]` (a new place entry?
inserted directly as a stop?).

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
`{placeId, stayDuration}` — `stayDuration` an approximate-minutes guess the AI is explicitly asked
for) *plus* a separate `interstops` array (see schema above) — the instruction explains the
zero-or-more-items-per-gap model explicitly and tells the AI to leave a gap's array empty when two
stops need no travel note (rather than forcing exactly one leg per gap the way the old schema did),
and to use more than one item when a leg genuinely has multiple parts (a short walk then a break, a
bus then a walk); none of it is computed against a real routing API. The AI is shown and outputs the
simple bare-array shape (`interstops[i]` = a plain array of items) — `validateRoutesResponse()` is
what wraps each gap into the Firestore-safe `{ items: [...] }` object on ingest (see schema above),
so the AI-facing contract stays simple and doesn't need to know about a storage-only detail.
Everything else (`id`, `city`, `generatedBy:"ai"`, `totalWantRating`) is set by the app itself,
never trusted from the AI's output — `totalWantRating` in particular is computed by summing the
referenced places' `wantRating` (the base contributes 0, having none), since letting the AI
self-report an aggregate invites drift. Validation hard-rejects (blocks the whole import, same as
place-generation) any route whose `stops[].placeId` doesn't exactly match one of the eligible
places' ids *or* the base's id; a missing/malformed `interstops` gap is instead handled leniently —
it just becomes an empty array rather than failing the whole route, since missing travel notes
shouldn't block an otherwise-valid import. The list view groups routes by city; each card shows the
route label, a provenance tag
("✨ AI-generated" or "✎ Manual", plus " (edited)" once `edited` is true), total want rating, and
the stop sequence via `routeStopSequenceLine()` — one stop per line (small thumbnail via
`routeStopThumbHtml()` when the place has one, name, stay duration), with each gap's interstop
item(s) rendered as their own indented, muted line beneath (`.route-gap-line`) rather than joined
into one paragraph. Joining everything into a single `→`-separated string used to read as unbroken
text once a route had more than a couple of stops with travel info — this was the actual
readability complaint that prompted the rewrite. `Start:`/`End:` label whichever stop actually *is*
the base (`isBaseStop()`) rather than being separately injected, falling back to the old
computed-bookend behavior only when the base genuinely isn't one of the stops, and each place stop
links out via the existing `mapLink()` helper. The AI-preview checklist (`renderRoutesPreview()`)
reuses the exact same `routeStopSequenceLine()` call — it used to just join stop names with `→` and
had the identical readability problem, one level removed since it wraps in a `<label>` for the
checkbox; a thumbnail click there calls `preventDefault()` before opening the lightbox so it
doesn't also toggle the checkbox.

✅ **Editing a candidate route before import**: each preview row has an "Edit" button (a real
`<button>`, so — same label-click-forwarding exclusion relied on elsewhere — clicking it doesn't
also toggle the row's checkbox) that opens the *same* manual route editor in a third mode,
`openRouteEditor(idx, 'preview')`, pre-filled from `routesPreviewList[idx]` exactly like editing an
already-saved route is pre-filled from `tripData.routes[idx]`. The save handler branches on this
mode: instead of writing to Firestore, it writes the edited result straight back into
`routesPreviewList[idx]` (setting `edited:true`, same as any other save) and calls
`renderRoutesPreview()` to refresh the still-open preview screen — `#routes-modal` is never closed
while the editor is open on top of it, so the two stack (the editor's later DOM position naturally
paints it above the preview at the same z-index) and the user lands back on the preview to keep
comparing or editing other candidates. The preview's own "Import selected" stays the actual commit
step, unchanged. **Checked state now survives re-render**: `renderRoutesPreview()` used to hardcode
every checkbox to `checked`, which was fine when it only ever ran once right after validation, but
re-rendering after an edit would have silently re-checked anything the user had already unchecked —
fixed by tracking checked indices in a separate `routesPreviewChecked` `Set` that the render reads
from and a `change` listener keeps in sync, reset to "all checked" only when a fresh validation
produces a new `routesPreviewList`.

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
results are sorted by a **weighted proximity+variety score** against the last stop already in the
route (`scoreRouteSearchCandidate()`) — see below — each result shows its category, want rating,
distance from the last stop when scored, and a "Map ↗" link), a full-size thumbnail
(`routeStopThumbHtml()` — routes aren't responsible for triggering the Wikipedia photo fetch, the
Places tab already owns that, but a place with no thumbnail yet still gets a same-size blank box
(`.place-thumb-blank`) rather than nothing at all, so stop rows stay aligned in a list where only
some places have a photo — an actual gap here, not a blank space, was the original behavior and it
misaligned every text line next to a photo-less row) next to each stop card's name, per-stop
planning note and an editable approximate stay
duration (minutes) for each place, up/down buttons to reorder (not drag-and-drop — simpler and
reliable on touch) and a remove button per stop. Editing state mirrors
the normalized `{places, interstops}` view directly (`routeEditorPlaces`/`routeEditorInterstops`,
populated via `normalizeRoute()` when opening an existing route) rather than the old flat
stops-with-interleaved-breaks array. A live map on the right shows the draft route's numbered
place stops (see below) and updates on every structural change (add/remove/reorder) — no separate
refresh step. Opening the editor collapses any currently-expanded route card first, since the
editor's own map replaces the need for that one to stay open (also avoids two live Leaflet
instances of the same route disagreeing with each other). No validation beyond requiring a label —
unlike the AI paste-back path this is direct hand-editing, not untrusted external input, so
there's nothing to reject. Saving always sets `edited:true` and recomputes `totalWantRating`;
`generatedBy` is set to `"manual"` for brand-new routes and left untouched when editing an
AI-generated one — editing doesn't erase where a route came from. This dialog is the intended
eventual home for an in-app clustering algorithm too (the "generate roughly N routes" decision
below) — not built yet, v1 still has none, but the editor was built so a future "auto-arrange"
action has somewhere to live without restructuring the UI.

✅ **Weighted proximity+variety sort** for the add-place search: raw distance sort put a
same-category place right next door ahead of a more useful, more varied option a little further
away (e.g. a second restaurant 10m from the last stop beating a landmark 60m away) — bucketing and
penalizing fixes that without ignoring distance outright. `scoreRouteSearchCandidate()`: distance to
the *last place already in the route* (haversine, `haversineMeters()` — reused from the coordinate
fixer) is bucketed into a `band = floor(distance / ROUTE_SEARCH_BAND_SIZE_M)` (default 100m per
band); a candidate sharing any `cat[]` tag with the last stop gets
`+ROUTE_SEARCH_CATEGORY_PENALTY_BANDS` (2) added to its band, and a candidate already somewhere in
the route gets `+ROUTE_SEARCH_ALREADY_ADDED_PENALTY_BANDS` (4) — deliberately larger than the
category penalty, so an already-added place always sorts behind a same-category-but-not-yet-added
one at comparable distance rather than the two penalties trading places depending on exact meters.
Results sort by `(effectiveBand asc, sameCategory asc, alreadyInRoute asc, distance asc)` — ties
within a band still favor variety and not-yet-added places before falling back to raw distance.
With no stop in the route yet (or the last one lacks coordinates), there's no reference point to
measure from, so results keep their original unsorted order exactly as before this — not "sorted by
nothing," just nothing to sort by. Each scored result shows its distance from the last stop
(`formatLegDistance()`) next to its category/want-rating; unscored results (first pick, or a
candidate missing coordinates) show neither. Hand-verified in-browser before trusting it: last stop a restaurant, candidates a landmark at 60m,
a restaurant at 10m, a landmark at 200m, and a park at 150m — expected and actual order is
landmark(60m) → park(150m) → landmark(200m) → restaurant(10m), the very-close same-category option
sorting last despite being nearest; and, at one shared band, an already-added candidate sorting
behind both a same-category-not-added and a different-category-not-added candidate at similar
distance.

✅ **Advanced search dialog** (`#route-search-modal`, opened via a "🔍 Advanced search" button next
to the inline search): a Places-tab-style split list+map for picking several places at once, with
more context than the inline search's one-line-per-result affords. Each list row shows the same
full place detail as Day-by-day (`placeDetailHtml()`, see "Day-by-day tab" below — thumbnail, want
rating, badges, price/hours, categories, note, wishlist, and *every* link, not just Map) plus its
distance from the route's last stop when one exists (same weighted sort as the inline search,
factored into `orderedRouteSearchResults()` and shared by both). A category filter chip row
(`renderRouteSearchCatFilter()`, same pattern as the Places tab's `renderCatFilter()`) narrows the
list alongside the keyword search.

**Revised from the first version of this dialog**: selection was originally a literal `<input
type="checkbox">` in a `<label>` wrapping the row — replaced with the whole row being the click
target (`.rs-place-row`, a plain `<div>` with a click handler, not a `<label>`) and a colored left
border/background that matches the map pin colors (harbor-teal unpicked, moss-green picked)
instead of a checkbox glyph, so the selection state reads as one visual language across the list
and the map rather than a checkbox plus a separately-colored pin. `setRouteSearchCheck(placeId,
checked)` stays the single source of truth either way — row class, marker color, and (see below)
the map viewport all go through it, so a toggle from the row, a toggle from clicking the marker
itself, and the underlying `routeSearchChecked` `Set` can never drift out of sync. The row-click
handler bails out on `e.target.closest('a')` before toggling, so a link click opens normally
without also (de)selecting the row; a thumbnail click still gets the `preventDefault()` +
lightbox treatment used everywhere else, since an `<img>` isn't a labelable/interactive element and
(now that the row itself carries the click handler, not a `<label>`) would otherwise register as a
plain row click too.

**The route's current last stop is pulled out of the regular candidate list** and shown separately
instead — a small banner (thumbnail + name, `renderRouteSearchLastStopBanner()`) pinned above the
list, and a third-colored map marker (`ROUTE_SEARCH_MARKER_COLOR_LAST_STOP`, mustard) distinct from
the harbor/moss picked-state colors of every other marker — a fixed reference point for judging
distance/direction while picking the *next* stop, not itself a thing you're picking from. Other
already-in-route places stay in the regular list (just deprioritized by the weighted score, per the
existing "revisiting a place is sometimes deliberate" reasoning) — only the literal last stop is
special-cased out, since it's the one place already shown elsewhere on screen.

**Checking a place now pans/zooms the map to it and brings its marker to front**
(`marker.bringToFront()` + `map.setView(marker.getLatLng(), Math.max(currentZoom, 15))`, inside
`setRouteSearchCheck()`, only on the checked-on transition) — with many candidates clustered close
together, a newly-picked marker could otherwise end up hidden underneath its neighbors with no
visual confirmation the click landed. Unchecking doesn't move the map, to avoid a jarring jump on
every click.

All three map/pin colors (`ROUTE_SEARCH_MARKER_COLOR_UNCHECKED`/`_CHECKED`/`_LAST_STOP`) are literal
hex values, not `var(--harbor)`/`var(--moss)`/`var(--mustard)` — Leaflet sets `fillColor` as an SVG
presentation attribute, which (unlike an inline `style` property) doesn't resolve CSS custom
properties. `routeSearchChecked` (a `Set` of place ids) persists across search/category filter
changes, so checking a place and then filtering it out of view doesn't lose the selection — "Add
selected" re-reads every checked id directly off `tripData.places` (filtered to the route's city)
rather than off whatever's currently rendered, in a stable city-array order rather than click/check
order.

Each route card shows a computed **total time** (`computeRouteTotalTime()`) at the top, above total
want rating — the sum of every place stop's `stayDuration` and every interstop item's `time` that's
actually been entered. Shown as `~<formatMinutes result>` (the `~` because it's a lower bound, not
a guaranteed-complete total — a stop or interstop item left blank just doesn't contribute); omitted
entirely if nothing in the route has any duration/time entered at all.

**Breaks and travel legs are unified into one "interstop" concept, stored separately from stops**
(see schema above) — each gap between two consecutive stops holds zero or more interstop items
rather than a stop carrying at most one travel leg with a break as its own interleaved stop. In the
editor, each gap between two place rows renders its own "+ Add travel or break" control (labeled in
plain terms rather than the internal "interstop" name, which only means something to someone who's
read this doc) and a card per existing item; a gap with no items renders with nothing between the
two stop cards (the visual cue for "right next to each other, no travel note needed"). Each item has a type picker — "Break" or
one of `TRAVEL_LEG_TYPES` (walk/metro/bus/train/taxi/ferry/car/bike) or a "Custom…" option revealing
a free-text input — plus `time` (minutes) always shown, and `distance`/`cost` shown only when the
type isn't "break" (`.interstop-dc-fields`, toggled live via a direct classList swap on the type
select's `change` handler — no full re-render, so the rest of the gap's form state survives the
toggle); switching to "break" resets `distance` to 0 and `cost` to null since neither is meaningful
for one. `cost` is always assumed to be in the trip's `meta.defaultCurrency` (no per-item currency
field) — free text here was judged too bug-prone (inconsistent units, unparseable later). `note`
stays free text (a break's description, or line numbers/platform info for transit) and got its own
full-width line. Display formatting (`formatLegDistance`/`formatLegTime`/`formatLegCost`/
`formatInterstopItem`/`formatInterstopGap`) shows meters as-is under 500m and converts to km (1
decimal) above that, appends "min" to time, and appends the trip's currency to cost if one is set;
multiple items in one gap are joined with " · then · ". Routes saved before this change have
free-text strings in the old per-stop `travel[]` shape (e.g. `"600m"`) — shown as-is rather than
parsed (via `normalizeRoute()`'s legacy-shape reconstruction), since regex-guessing units on old
free text defeats the point of typing the field. The AI generation instruction
(`routesTravelSchemaDoc()`, a function of the trip's currency) asks for the same numeric shape,
preset vocabulary, and zero-or-more-per-gap model; `validateRoutesResponse()` coerces a
numeric-looking string to a number if the AI ignores the instruction, else falls back to `null`
(never a bare 0, which would misrepresent "free"/unknown as an actual zero cost), and defaults a
missing/malformed gap to `[]` rather than rejecting the route.

Reordering (`route-stop-up`/`route-stop-down`) and removing a stop in the editor clears the
interstop data for every gap whose adjacency actually changed, rather than leaving stale
distance/time/cost silently attached to a leg that no longer exists — up-swap of `places[i-1]`/
`places[i]` clears gaps `[i-2,i-1,i]`; down-swap of `places[i]`/`places[i+1]` clears gaps
`[i-1,i,i+1]`; removing the first place drops gap `0`; removing the last place drops the
now-final gap; removing a middle place merges its two adjacent gaps into one empty gap
(`interstops.splice(i-1, 2, [])`) rather than guessing which of the two survives. The field goes
blank instead of showing a wrong number, prompting re-entry — recomputing a correct value
automatically instead of just clearing it is still not built (see the deferred note below).

✅ **Expandable route view**: an "Expand ▾"/"Collapse ▴" button per route card **replaces** that
card's compact summary (total want rating, the stop-sequence line) with a Places-tab-style split
list+map scoped to that one route (`.route-split` — same idea as `#places-split`, new CSS since
there can be many route containers rather than one fixed ID), rather than showing both stacked on
top of each other — an accordion, not an inline addition. The route label, provenance tag, total
time, and Edit/Expand/Delete actions stay visible either way. Each place stop's row shows a
full-size thumbnail (same `routeStopThumbHtml()` as the manual editor) alongside that place's
categories, its own general `note` (labeled distinctly from the stop's route-specific note as "Note
for this stop:" so the two don't read as the same thing), and a "Map ↗" link (`mapLink()`, same as
the compact card's stop sequence and every other place-in-a-route view — expanding shouldn't lose a
link the collapsed view already had) — this view specifically, since it's where there's room, and
because an unfamiliar name (a Danish place name, say) is hard to place from the name alone without
that context. Only one route expanded at a time — expanding a different one (or opening the route editor) tears down
the previous route's Leaflet map instance first (`.remove()`), since each expansion creates its own
`L.map()` bound to a per-route container id. The map shows numbered markers (`L.divIcon`, 1-based,
visiting order) for place-stops that have coordinates — coordless places are skipped on the map but
still listed, and each gap's interstop item(s) render as their own line between the two stop rows —
connected by a polyline. No arrowhead plugin: numbered markers plus a
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

✅ Assigning routes to days is implemented — see "Day-by-day tab" below. **Revised from an earlier
version of this doc**: this used to live here on the Routes tab as day-assignment chips on each
route card; moved to the Day-by-day tab instead (a persistent "+ Add routes" checklist on Level 2)
after actually using it — see the reasoning under "Day-by-day tab" below.

✅ **Implemented: OpenRouteService integration for real leg distance/time**. A "🧭 Calculate times &
distances" button in the manual route editor (`#route-editor-modal`, next to the stop search) runs
`calculateRouteTravel(places, interstops)` against the editor's own in-memory `{places, interstops}`
state (same bare-array gap shape `normalizeRoute()` returns) and mutates it directly — same
"nothing writes to Firestore until Save" rule every other editor action follows, so a bad
calculation is trivially discardable by just closing the editor without saving. Works for both
AI-generated and algorithm-generated (or hand-built) routes equally — it operates purely on
coordinates and interstop item types, with no notion of provenance.

**Key/config**: `ORS_API_KEY` — a placeholder constant (`'PASTE_YOUR_ORS_API_KEY_HERE'`) near
`DRIVE_API_KEY`, same "not a secret, just a rate-limited public key" trust model, filled in the same
way (`orsApiKeyConfigured()` checks it's set and doesn't still start with `'PASTE_'`, mirroring
`driveApiKeyConfigured()`). Free at openrouteservice.org/dev (sign up → Dashboard → request a
"Standard" token, no billing/card). Calculating with no key configured throws a clear error shown in
the editor's status line rather than failing silently or looking like a network problem.

**Profile mapping** (`ORS_PROFILE_BY_TYPE`): walk→`foot-walking`, bike→`cycling-regular`, car and
taxi→`driving-car` (taxi treated identically to car — same road network, same realistic travel
time). metro/bus/train/ferry/break/custom types have no ORS profile and are left exactly as they
were — AI-estimated or hand-entered, same as before this existed.

**One Matrix API call per distinct profile actually used in the route**, not one Directions call
per leg — `orsMatrixForProfile()` sends every stop's coordinates as `locations` and reads back the
full distance/duration matrix, then picks out just the consecutive-stop pairs each gap needs. A
route mixing walk and car legs costs exactly 2 calls regardless of how many legs of each there are.
Every ORS call funnels through `orsRateLimitedFetch()`, a shared queue pacing requests 1.6s apart
(comfortably under the free tier's 40/minute cap) — mirrors the Nominatim coordinate-checker's
existing throttled-queue pattern; a single "Calculate" click rarely actually waits on it (1-2 calls),
it mainly guards a hypothetical future bulk "recalculate every route" action against bursting.

**Session-only cache** (`orsLegCache`, keyed `fromPlaceId|toPlaceId|profile`, directional — A→B
cached separately from B→A since real streets aren't symmetric) avoids re-fetching a pair already
looked up earlier in the same sitting (e.g. the same two places sharing a leg across more than one
route); if every pair a profile needs is already cached, `calculateRouteTravel()` skips the network
call for that profile entirely. Not persisted — the real source of truth after a Save is whatever
ends up written into the route's own `interstops`, same as any other editor field.

**Per-gap behavior**: an existing interstop item whose `type` maps to a profile gets recalculated
onto that same item (`time`/`distance` overwritten, `cost`/`note` left untouched — ORS has no notion
of cost); a completely empty gap gets exactly one *new* item created using
`defaultOrsLegType()` (the trip's preferred travel methods if any map to a profile, else `'walk'`);
a gap whose only item(s) are breaks/transit/custom types is left alone entirely, and a gap missing
coordinates on either endpoint is skipped and counted separately (`missingCoords`) rather than
silently ignored — the status line reports updated/skipped/missing-coords counts after every run so
none of that is invisible.

Verified with a standalone Node harness (mocked `fetch`, synthetic places/trip data) before wiring
into the UI: throws cleanly with no key configured; fills an empty gap with the right default type
and numbers; leaves a `metro` leg (no ORS profile) completely untouched while still counting it as
skipped; recalculates an existing `car` leg's time/distance while preserving its `cost`/`note`;
correctly skips and counts a gap where one endpoint has no coordinates; serves an identical
second call entirely from cache (zero additional fetches); and a route mixing walk + car legs
issues exactly 2 matrix calls, not one per leg.

⬜ **Deliberately not wired in for this pass**: auto-running this right after AI or algorithm route
generation, rather than requiring an explicit editor click. Judged too risky to make automatic
before real end-to-end use with an actual (non-placeholder) API key — a manual button is
inspectable, reversible (nothing saves without Save), and degrades obviously (a clear error, not a
silent no-op or a surprise burst of network calls) if the key isn't configured yet or something's
misrouted. Worth revisiting as a default-on convenience once the manual path has seen real use.

✅ **Implemented: in-app geographic clustering algorithm (v1)** — an alternative to AI-generated
routes, not a replacement. The existing "Generate routes with AI" button/modal now opens a generic
"Generate routes" dialog with a method toggle at the top of setup: **✨ AI (paste-back)** (the
original flow, unchanged) or **🧮 Algorithm (automatic, no AI)** — picking Algorithm hides the
AI-only fields (travel methods, batch notes, neither of which the algorithm reads) and changes the
action button from "Generate instructions" to "Generate routes", which runs entirely client-side
and drops straight into the *same* `#routes-step-preview` checklist/import step the AI path uses —
`generateRoutesByAlgorithm()` returns the same `{routes: [...]}` shape `validateRoutesResponse()`
does (`generatedBy:'algorithm'` instead of `'ai'`), so nothing downstream (preview checklist, the
"Edit" button opening the same route editor in `'preview'` mode, the import step, the saved-route
provenance tag — now "🧮 Algorithm" alongside "✨ AI-generated"/"✎ Manual") needed to know which
method produced a route.

Pipeline: (1) **`kMeansCluster()`** — deterministic k-means (greedy farthest-point seeding instead
of random, so re-clicking "Generate routes" against the same data reproduces the same clusters; a
fixed 12 Lloyd's-algorithm iterations, no convergence check needed at this place-count scale) on
`getEligiblePlacesForRoutes(city)`, `k = min(desired route count, ceil(eligible.length /
stopsPerRoute))` so it never proposes more clusters than there's material for. (2)
**`nearestNeighborOrder()`** — greedy nearest-neighbor within each cluster, starting from whichever
member is closest to the base of operations (mirrors "every route starts/ends at base"; falls back
to an arbitrary start when no base is set — verified this doesn't error, see below). (3)
**`twoOptImprove()`** — a bounded path 2-opt cleanup pass (reverses a sub-segment whenever doing so
shortens total distance, capped at 20 passes — converges well before that at the ~5-10 stop cluster
sizes this deals with). (4) **`repairCategoryAdjacency()`** — the requested category-adjacency rule:
`ROUTE_ALGO_BREAK_LIKE_CATS = ['food']` (a plain constant, not user-configurable in v1) flags which
categories read as a "break" rather than a destination; if two adjacent stops both carry a
break-like category, a local swap with the stop two positions over is tried, kept only if it
actually resolves the adjacency without creating a new one right next to it — not a global
re-optimization, just enough for the realistic case (a handful of same-category places scattered
through a short route). If a base is set, it's prepended/appended as the literal first/last stop
(same rule AI-generated routes follow) with all `interstops` gaps left empty (`{items:[]}`) — the
algorithm doesn't guess travel type/time/cost, and `stayDuration` is left `null` for every stop for
the same reason (unlike the AI path, there's no basis here to estimate either one; both are
editable afterward in the route editor, same as always).

**Deliberately NOT built in v1** (matches the original design sketch): rating-balancing across
clusters — a route can still end up hoarding the higher-`wantRating` places in its geographic area,
since k-means clusters purely on distance. Left for a follow-up once it's clear from actual use how
lopsided that turns out to be in practice; the manual editor is already the safety net for
rebalancing by hand in the meantime.

Verified with a standalone Node harness against synthetic Copenhagen-shaped data (two geographic
groups, food places deliberately placed adjacent in raw input order) before wiring into the UI:
correct cluster count, every route bookended by the base, zero adjacent same-category-food stops
across either generated route, no duplicate stops within a route, correct `interstops` shape, a
graceful `{error}` (not a throw) for a city with fewer than 2 eligible places, and correct behavior
with no base of operations set at all (falls back to an arbitrary cluster-member start, no crash).

⬜ **Known limitation, deferred**: interstops now live on the actual *edge* between two stops
(fixing the earlier "`travel[]` stored on the from-stop" ambiguity — see the schema note above), so
a reorder/remove clears exactly the affected gap(s) rather than guessing (see the reorder/remove
math above). What's still missing is *recomputing* a correct value automatically instead of just
clearing it. **Revised now that OpenRouteService integration exists** (see above): the pieces this
needs — a distance/time lookup keyed by `(fromPlaceId, toPlaceId, profile)` and a cache to avoid
re-querying — already exist (`orsMatrixForProfile()`/`orsLegCache`); what's not built is the
*automatic trigger* wiring a reorder/remove straight into a recalculation instead of requiring the
existing manual "🧭 Calculate times & distances" click afterward. Left as a manual step deliberately
for now (same "not worth being automatic before it's seen real use" reasoning as the OpenRouteService
section above) — reordering isn't expected to be a frequent action in practice, and a manual button
after the fact is one extra click, not a real workflow cost.

## Day-by-day tab (Phase 4 assignment + Phase 5 execution)

**Resolved from an earlier version of this doc**: Phase 4 and Phase 5 were described separately
without saying how they map onto the UI. They don't split into two tabs — the "Day-by-day" nav tab
covers both **assignment** (which day(s) a route belongs to, Phase 4) and *execution* (Phase 5:
completion, ratings, notes).

**Assignment moved here from the Routes tab, reversing an earlier version of this doc.** The
original reasoning was that a route is already being evaluated on the Routes tab, so tagging it
with a day there is contextual — but in practice the Routes tab doesn't have a day's full context
(what else is already on that day, how full it is), and cluttered every route card with a full row
of day chips regardless of whether you were thinking about assignment at all. Level 2 below now has
a persistent "+ Add routes" button instead: a checklist modal (`#add-routes-modal`, mirrors the
Copy-trip places-checklist pattern — `renderCopyPlacesChecklist()`/`renderAddRoutesChecklist()`) of
every route not already on the selected day, grouped by city, with Select all/Select none; "Add
selected" appends the checked route ids to that day's `assignedRoutes` (immediate write, no
draft/save step) and closes. Only unassigned-to-*this*-day routes are listed, so there's nothing to
dedup against — a route already on the day was never offered as a checkbox in the first place. A
route already assigned to one or more *other* days can still be listed and added here too (explicit
alternates are a supported pattern, see below), but is flagged ("Already on: Day 1, Day 3") and
sorted to the bottom of its city group, so a deliberate re-add is still possible without it reading
as an accidental double-booking or crowding out the untouched options. **Ordering**, for a day with
more than one route, still happens here too (up/down buttons on the Level 2 picker), since that's
the one place a day's full route list is visible together — this part didn't change.

**Checkbox layout, same bug class as `.publish-check-row`'s history**: `.ai-preview-row` (the
checklist-row class shared by this modal, the Copy Trip places checklist, and both AI-generation
preview checklists) had its `display:flex` silently lose to the pre-existing
`.modal-box label{display:block}` rule on specificity, stacking each checkbox above its row content
instead of beside it — reported as "checkbox is above, looks weird" on this specific checklist, but
the bug affected all four checklists that share the class. Fixed once, at the CSS root, by
requalifying as `.modal-box .ai-preview-row{...}` (0,2,0), same fix pattern as before.

✅ **Implemented**, as a three-level drill-down rather than all days rendered at once (deliberately
— there's no reason to load a whole trip's worth of checklists/maps when only one day matters at a
time):

- **Level 1 — day picker** (`#days-day-select`): every `tripData.days` entry, `renderDays()`
  auto-selecting whichever `date` matches today (`todayIso()`) the first time it runs, else the
  first day — always overridable, works for past/future days too.
- **Level 2 — route overview**: empty state if the day has no assigned routes; loads directly if
  it has exactly one; a button-row picker (reusing the `.cat-chip` visual, `isRouteComplete()`
  defaulting to the first not-fully-done route) if it has more — **one route per line**
  (`.days-route-picker{flex-direction:column}`, a dedicated class rather than reusing `.cat-picker`,
  whose `flex-wrap` laid these rows out side by side like category chips instead of a list). Reuses
  the Routes tab's expandable-view machinery (`renderExpandedRouteHtml`/`initExpandedRouteMap`'s
  patterns, `.route-split`/`.route-stop-row`, numbered markers + polyline) rather than rebuilding
  it, with the differences: each stop row shows full Places-tab-level detail via the shared
  `placeDetailHtml()` (thumbnail, want rating, badges, city/area/price/hours, categories, the
  place's own note, wishlist, links — the same richness `renderPlaces()` shows, factored out so the
  two don't duplicate markup), passing the route's per-stop planning note as `opts.routeNote` so it
  renders directly beneath the place's own note (see note-differentiation below); completed stops
  get a `.stop-done` modifier (moss background + ✓) plus a compact rating summary
  (`stopRatingSummaryHtml()`, `.mini-stars`) next to the checkmark — average rating and review
  count (e.g. "★ 4.5 (2 reviews)"). **Revised twice**: v1 showed every participant's individual star
  string side by side, which didn't scale past a couple of reviewers (a route with several people
  rating every stop turned into a wall of stars). v2 replaced that with the average/count plus an
  explicit "✓ You reviewed" / "you haven't reviewed yet" flag for the current user — closer, but the
  flag text read as too wordy for a compact list row, and the *positive* case ("you reviewed") isn't
  actually worth saying anything about — your own review, once given, doesn't need a prompt. Final
  version: only the not-yet-reviewed case renders anything extra, as a lone hollow star (`☆`,
  tooltip "You haven't reviewed this yet") right after the average — nothing appears once the
  current user has rated it. Keyed off `currentUser.uid`, simply omitted on the unauthenticated
  share view (`renderShareView()`, where `currentUser` is null) either way — a rating is visible
  from the list without drilling into Level 3; and *every* stop row is
  clickable into Level 3 — not just ones with coordinates, since marking something done doesn't need
  a map marker (a click inside a link or button within the row is excluded from that, so opening a
  place's link doesn't also navigate into Level 3). Price conversion for these rows uses a separate
  `updateDayPriceConversions()` keyed by `data-place-id` rather than the Places tab's
  `data-idx`-keyed `.price-convert` spans, so the two can't collide despite sharing a class name.
  Map pane is `position:sticky` (`.day-route-map-pane`) since a day's stop list can run long. The
  route picker's up/down buttons reorder `days[].assignedRoutes` directly (immediate write, no
  draft/save step); "Remove" splices a route out of the day without deleting the route itself.
- **Level 3 — single-stop view**: opened by clicking a stop row. No map. The same
  `placeDetailHtml()` full detail as Level 2's rows (`opts.routeNote` again, plus
  `opts.interactiveWishlist:true` — see below), stay duration, and, for any stop after the first, a
  "Getting here:" line showing the interstop item(s) in the gap immediately before it
  (`normalizeRoute(route).interstops[stopIdx-1]`) — so how to get to this stop is visible without
  going back to Level 2. A Prev/Next nav bar cycles through the route's place-stops (interstop items
  aren't navigable targets — navigation is stop-to-stop) with an "N / M" counter, disabled at either
  end; navigating updates the "Getting here" line for the newly-shown stop the same way clicking a
  row would.

  **Execution controls, revised from the first version of this view**: a manual "Mark as done"
  checkbox and two separate free-text fields (a shared "Note" plus a personal "rating note") have
  been replaced with rating + review + spent + paid-by, all staged locally and written together by
  one **"Save review" button** — revised again from an initial save-per-field version (see below for
  why). "Your rating" is five full-width, large-tap-target star buttons (`starRatingHtml()`,
  `.star-rating`/`.star-btn`) — mobile-first, and deliberately a 1-5 scale, not 1-10: this answers
  "how was it" post-visit, a different question from `places[].wantRating`'s 1-10 "how much do I
  want to go", so reusing that scale would have conflated the two. Clicking a star only updates the
  staged value shown on screen, nothing is written yet. "Your review" is one `<textarea>`
  (`#day-stop-review`). "Amount spent here" (`#day-stop-spent`, plain number, plus a currency
  `<select>` next to it, `#day-stop-spent-currency`) captures `ratings[uid].spent`/`currency` —
  aggregated by the Budget tab (see "Budget tab" below). **Revised to add the currency picker**:
  originally `spent` had no currency field at all and was simply assumed to be
  `meta.defaultCurrency`; a trip to Copenhagen with an EUR default but cash spent in DKK had no way
  to record that correctly. The currency select needs no network fetch (unlike paid-by's
  participants), so it's built directly in the synchronous render rather than a post-render populate
  call — no race-condition risk there. Defaults to the trip's own currency, with the stop's place's
  local currency (via city→country, the same lookup Places' price field already uses) surfaced right
  after it for the common case of paying in local cash — one click away, never silently substituted
  for the trip default. Saving resolves the amount into `meta.defaultCurrency` once, via the
  Frankfurter API, storing the result as `convertedAmount` (see the routeStops schema note above) —
  an "≈ X" hint shows underneath when the two currencies differ. "Paid by" (`#day-stop-paid-by`, a
  `<select>` of the trip's participants,
  defaulting to the current user) captures `ratings[uid].paidByEmail` — independent of who's logging
  the review, since the reviewer isn't necessarily who actually paid; shares its options-fetch with
  the Budget tab's manual-expense modal via one function, `populatePaidBySelect(selectId,
  selectedEmail)`. `selectedEmail` distinguishes `undefined` ("never set" — default to the current
  user) from `null`/`''` (an explicit past choice of "Unspecified", which must stay Unspecified, not
  silently fall back to you) from an actual email — collapsing the first two with a bare `||` was a
  real bug caught in testing, since a stored `null` and a genuinely-never-set field are meaningfully
  different states here.

  **"Save review" replaced save-per-field after two rounds of race-condition bugs.** The original
  design wrote each field the instant it changed (a star click, a blur on the review textarea, a
  paid-by change) and re-rendered/re-fetched participants every time. Two real, user-reported bugs
  came out of this: first, `populatePaidBySelect()` grabbed its `<select>` element *before* awaiting
  the participants fetch, which could capture `null` (the element didn't exist in the DOM yet on a
  fresh render) and throw once the fetch resolved — fixed by querying the DOM only after the
  `await`. Second, and worse: because *every* interaction fired its own fetch-then-write-then-rerender
  cycle, picking "Unspecified" (which saves and instantly re-renders) could have the *original* fetch
  — issued when the stop first opened, before any choice was made, still defaulting to the current
  user — resolve *after* the newer one and silently overwrite the correct selection. A per-selectId
  sequence guard (`paidBySelectSeq`, discarding a stale call's result once a newer one has been
  issued) fixed that specific race, but it was still just patching one symptom of "this whole panel
  re-fetches and re-renders on every keystroke and click." The actual fix was removing the trigger
  entirely: nothing in this panel writes to Firestore anymore except the "Save review" button, so
  there's only ever one write-then-rerender cycle per explicit save, not one per field interaction —
  the whole class of overlapping-async-cycle races is gone, not just the one instance of it that got
  reported. A "Last saved \<date/time\>" label (`formatPublishedAt()`, reused from the Publish
  modal's staleness indicator — see "Static/public sharing") sits next to the button, reading
  "Not yet saved" until `ratings[uid].updatedAt` (new field, set on every save) has a value, so it's
  never ambiguous whether your edits actually went through.

  `done` is no longer a checkbox at all: `saveDayStopRating()` sets it to `true` automatically on
  save if the value/note/spent being saved is non-empty (never back to `false` — clearing a review
  can't silently un-mark a stop), and a small read-only "✓ Marked done" line shows when it's set.

  **Every review for this stop renders as its own card** (`reviewCardHtml()`, `.review-card`) below
  the save button — **revised from a single "other participants" line** that excluded the current
  user's own rating entirely (no visible confirmation a save had landed beyond the "Last saved"
  timestamp above), joined everyone else with `<br>`, and silently dropped the currency a spend was
  actually logged in. Each card: name (`"You"` for the current user's own, sorted first, so seeing
  your own save land doesn't require scanning past everyone else's) plus star rating on one line;
  the review text on its own full-width line below (`.review-text`); a spend badge
  (`.spent-badge`, mustard background) floated to the right of the name/stars row showing the
  amount in whatever currency it was actually logged in, the converted amount alongside when that
  differs from `meta.defaultCurrency` (e.g. "100 DKK (≈ 13.4 EUR)"), and who paid; and a
  last-saved date/time line (`formatPublishedAt()`, same formatter used elsewhere) at the bottom.
  A card with no review text or no spend just omits those lines rather than showing empty ones. All
  writes go through
  `db.collection('tripNotes').doc(currentTripId).set({routeStops:{[key]:{...}}}, {merge:true})` —
  same merge-write pattern already used for `tripNotes.places[id].note`. Navigating away (Prev/Next,
  Back to route, switching stops) without saving discards whatever's staged — no unsaved-changes
  warning, a deliberate scope cut rather than an oversight. "← Back to route" returns to Level 2.

  **Wishlist as a checklist**: when `opts.interactiveWishlist` is set (Level 3 only — Level 2 and
  every other `placeDetailHtml()` caller still get the plain comma-joined summary), a place's
  `wishlist` renders as one checkbox per item (`.wishlist-item`, `tripNotes.places[id].wishlistChecked`,
  see schema above) instead of read-only text — "mini goals" for that specific place (which exhibit
  to see, which dish to try), shared across every route/day that visits it, independent of any one
  visit's rating/review.

**Real bug found and fixed while building this**: `isoDatesInRange()` originally built each date
with `new Date(iso+'T00:00:00').toISOString().slice(0,10)` — `toISOString()` converts to UTC,
which silently shifts the date back a day for anyone in a timezone ahead of UTC (local midnight is
still "yesterday" in UTC). Fixed to read back the date with the same local getters
(`getFullYear`/`getMonth`/`getDate`) used to construct it, matching how `todayIso()` already did
this correctly — never mix `toISOString()` with locally-constructed dates in this codebase.

✅ **Implemented: "🔍 Nearby places"** (`#nearby-places-modal`, next to "+ Add routes" on Level 2) —
for something spontaneous, off the planned route, not requiring AI. Finds the trip's own saved
places within an adjustable radius (default 1km) of a location, optionally narrowed by a
multi-select category filter, live map (numbered-marker style reused from the advanced route
search: mustard for the search location, harbor-tinted circle for the radius, moss markers for
matches — clicking the map moves the search location). **Location defaults to the browser's own
geolocation** (`navigator.geolocation`, tried automatically on open) — the one place in the app
that uses real device location rather than a saved coordinate, since "what's near me right now"
is the actual question being asked, unlike everywhere else in the app which reasons about saved
place coordinates. Falls back to the trip's base of operations if permission is denied/unavailable,
and always overridable by clicking anywhere on the map.

**Reuses `tripData.routes[]` as-is for the result — no new data structure.** A route doesn't require
a minimum stop count (a 1-stop route simply has zero `interstops` gaps), so "+ Add to today" on a
result creates a plain route with that single place as its only stop
(`generatedBy:'manual'`) and appends its id to the current day's `assignedRoutes`, exactly the same
mechanism every other route uses. Rating/review, done-marking, and Day-by-day's Level 2/3 rendering
all already work on this without any special-casing, since none of that code assumes a route has
more than one stop — `tripNotes.routeStops["<routeId>:0"]` is the review entry for it, same shape
as any route stop. The dialog deliberately stays open after adding (no auto-close) — a spontaneous
"what's around me" search often wants more than one result added in one sitting — with each row
getting its own inline "✓ Added" instead.

⬜ **Deliberately deferred**: reaching Level 3 the first time is still manual (tap a stop) — no
auto-navigation into the next undone stop's detail on entry, only Prev/Next once already inside
Level 3. A real transition leg between two routes assigned to the same day is shown as a plain
divider, not an editable/fillable gap. `tripData.places[placeId].done`/`ratings` (place-level,
route-independent tracking, separate from `routeStops`) stays unbuilt.

## Budget tab

✅ **Implemented.** Combines two independent data sources into one view, without ever duplicating
either: manual `tripData.expenses[]` entries (see schema above) plus every non-null
`tripNotes.routeStops[key].ratings[uid].spent` already captured during Day-by-day execution
(`collectStopLinkedExpenses()`) — a stop-linked entry is read-only here, tagged "From Day-by-day";
editing one happens back at the stop itself (`#day-stop-spent`), never a second copy to keep in
sync. A stop-linked entry's category comes from its place's first `cat[]` tag, its currency comes
from `ratings[uid].currency` (falling back to `meta.defaultCurrency` for entries saved before that
field existed — see the routeStops schema note above; **revised** from the original "always
`meta.defaultCurrency`, no per-entry currency field" convention once Day-by-day gained its own
currency picker), its paid-by comes from `ratings[uid].paidByEmail` — `'paidByEmail' in r ? r.paidByEmail :
(r.email || null)`, trusting the key as-is (even `null`) if it's present at all and only falling
back to the reviewer's `email` when the key is genuinely absent (entries saved before the field
existed). **Real bug, reported as "picking Unspecified in Day-by-day shows the reviewer as payer
in Budget"**: this used to be `r.paidByEmail || r.email || null` — the exact same
undefined-vs-null collapse already fixed once in `populatePaidBySelect()`'s history (see "Day-by-day
tab"), made again here independently. An explicit `paidByEmail: null` (Unspecified) is falsy, so
`||` fell through to `r.email` and silently credited the reviewer as if they'd paid — verified in
the database the field really was `null`, so a Day-by-day repro that looked "still broken" after
several rounds of fixes there turned out to be a completely different bug in the Budget tab's own
aggregation, not a regression of the earlier fix. Its day comes from whichever day the stop's route
is assigned to (`tripData.days[].assignedRoutes`). Since a
route can be assigned to more than one day (explicit alternates — see "Routing / planning"), and
there's no record of which specific day a visit actually happened, this picks the earliest assigned
day as a best-effort label rather than leaving the entry unlabeled — a known simplification, not a
guarantee.

**Combined stats** (`renderBudgetStats()`): total spent, by category, by day, and a simple paid-by
total per person, all computed after resolving every entry into `meta.defaultCurrency` where
possible. **Revised**: both `saveExpense()` (manual expenses) and `saveDayStopRating()` (stop-linked
spend, since it gained its own currency field) now resolve and store a `convertedAmount` once, at
save time, via the Frankfurter API — see the schema notes above — so `renderBudget()`'s own
`getRate()` call is only a fallback for whichever entries don't already have one (saved before this
existed, or the save-time fetch failed), not the primary path for every render. Conversion is
skipped entirely (raw amounts summed as-is) when the trip has no `defaultCurrency` set, same
"display-only, skipped without a default" rule Places price
conversion already follows. Total is compared against `meta.preferences.budget.realistic` when set,
with an "Over"/"Within" flag. **By-person grouping buckets a missing/`null` `paidByEmail` under its
own visible "Unspecified" row** (same pattern as `byCategory`'s "Uncategorized" bucket) rather than
silently dropping that spend out of the "Paid by" breakdown entirely — the original version did
`if(!e.paidByEmail) return;`, which excluded real spend from the view rather than surfacing it as
its own bucket; still correctly excluded from any *person's* total, just no longer invisible from
the breakdown as a whole. **By-day grouping resolves a manual expense's raw `date` against
`tripData.days` to find that date's day label** (`budgetDayLabel()`) rather than bucketing by the
literal date string — found as a real bug while testing: a manual expense dated the same day as a
stop visit was landing in its own `"2026-09-01"` bucket instead of merging into `"Day 1"` alongside
the stop-linked entries for that day, since the two entry types started out keyed differently
(`dayLabel` vs raw `date`). Fixed by resolving both through the same day-label lookup.

**Manual expense modal** (`#expense-modal`, `openExpenseModal()`): amount, currency (select,
`meta.defaultCurrency` prioritized first same pattern as the place price-currency select),
category (single-select chip picker — deliberately different from a place's multi-select `cat[]`
chips, since one expense is one category, not several tags; clicking an already-active chip clears
it instead of toggling to a second selection), date, related place (a `<select>` of the trip's
places, not free-text search — simpler and unambiguous since multiple places can share a name),
paid-by (a `<select>` of the trip's participants, fetched one-off via
`populatePaidBySelect(selectId, selectedEmail)` — shared with the Day-by-day stop rating's own
paid-by field, same one-off `trips/{tripId}.get()` pattern as `openCollabModal()`, defaulting to
`currentUser.email`), and a note. Only amount is required (must
be greater than 0). Save/delete write directly to `tripData.expenses` and re-render the tab; no
draft/preview step, consistent with how places/routes are edited directly once a trip exists.

The vestigial `budget: []` field from the original schema doc (never read or written by any code)
is dropped in favor of `expenses[]`, updated at all three trip-creation sites (`loadTrip()`'s
not-found fallback, New/Copy trip save, and `startOwnTripFromShare()`) — see the schema section
above.

## Documents tab

✅ **Implemented**, revised from the original Phase-7-era plan of one-manual-link-per-document.
Instead, a trip can point at a single shared **Google Drive folder** and the app lists whatever's
actually in it — discussed and confirmed with the user as a way to avoid Firebase Storage/Blaze
entirely (see "Billing" and "File uploads" below).

**Setup**: "Edit trip details" gets a "Documents folder" field — paste a Drive folder share link
(or a bare folder ID; `extractDriveFolderId()` accepts either) into `meta.docsFolderId`. The folder
must be shared "Anyone with the link can view" — same trust model the app already assumed for any
Drive link a user pasted in before this existed. Clearing the field disables folder browsing/upload
for that trip (existing document notes aren't deleted) — manual links (see below) work either way,
with or without a folder set.

**Reading the folder**: Drive API v3 `files.list` (`listDriveFolder()`, `q: "'<folderId>' in
parents and trashed = false"`) called with a plain **API key** (`DRIVE_API_KEY`, a placeholder
constant near `firebaseConfig` until filled in), no OAuth — the folder's already publicly
link-shared, so a key is all `files.list` needs. This key is not a secret the way the AI provider
key is (see "AI generation model") — it only grants read access to a folder already set to "anyone
with the link," so it's safe to embed client-side, same trust model as `firebaseConfig`. Must be
locked down in Google Cloud Console (same project as Firebase): **API-restricted** to Drive API
only, **referrer-restricted** to the app's real origin(s) + localhost. No billing/Blaze requirement
for read calls at this scale. **Not live-synced** — Drive's API has no free push-based equivalent
to Firestore's `onSnapshot`, so this is a fetch-on-demand mirror of the folder (on opening the
Documents tab, or "🔄 Refresh"), not instant the way the rest of this app's Firestore-backed data
is; a file someone adds directly in Drive shows up on next open/refresh. Cached per folder
(`docsListCache`/`docsListCacheFolderId`) so switching tabs back and forth doesn't re-hit the API
every time.

**Writing (upload) — tried, removed for v1.** The original design requested an extra OAuth scope
(`drive.file`) on the existing Google sign-in and uploaded via Drive API's `files.create`
(multipart), entirely client-side, no backend. Two real bugs came out of testing it against a real
account: `signInWithPopup()` could resolve successfully but return no usable access token for an
already-signed-in account (Google silently reusing the session instead of re-prompting for the new
scope — worked around with `provider.setCustomParameters({ prompt: 'consent' })`), and then a
second, browser-level issue — the upload button opened the native file chooser *before* requesting
Drive permission, and browsers refuse a popup opened immediately after a file chooser closes
(`auth/popup-blocked`, "window.open blocked due to active file chooser"), which needed reordering
so permission was requested first. After both fixes, upload still failed unreliably enough in
practice that the user asked to drop it rather than keep debugging it — **uploading a file directly
in Google Drive, then having it show up in the app's live listing, works fine and is good enough
for v1.** All upload code (`ensureDriveAccessToken()`, `uploadFileToDriveFolder()`, the "⬆ Upload
file" button) has been removed; only the read side (`listDriveFolder()`) remains. Revisiting upload
is a fair future call if it turns out to matter enough to debug further — flagged here rather than
silently forgotten.

**The merged list** (`renderDocuments()` → `renderDocsList()`): every live Drive file plus every
manual link, one card each (`.doc-row`). A `tripNotes.documents[docId]` entry is a manual link if
it carries `source:"manual"` (title/type/url stored directly there); otherwise, if its key matches
a file id from the live listing, it's metadata (`note`/`confirmationNumber`/`relatedPlaceId`)
layered onto that file — the file's own name/mimeType/view-link always come from the live listing,
never stored, so they can't go stale if the file is renamed in Drive. A metadata entry for a file
no longer in the listing (deleted from Drive, or the folder changed) simply doesn't render — a
known simplification, not handled specially. Each row shows a type icon (`docTypeIcon()`, by
mimeType), a **"Preview" toggle** for previewable types (`docIsPreviewable()` — PDFs, images, and
native Google Docs/Sheets/Slides) that inserts an `<iframe>` pointed at Drive's own embeddable
viewer (`https://drive.google.com/file/d/<id>/preview`) directly into the row — genuinely displayed
in-app, not just linked out, reusing Drive's own renderer rather than building a PDF viewer from
scratch — plus a "View in Drive ↗" / "Open ↗" fallback link either way. "Edit details" opens one
shared modal (`#doc-modal`) for both kinds — a Drive file's edit hides the title/type/url fields
(not this app's to rename), a manual link's edit shows them; only manual links get a "Delete"
button, since deleting a Drive file isn't something a metadata-edit action in this app should do —
that happens in Drive itself, outside the app, consistent with "we mirror the folder, we don't
manage it."

**Related place — settable from either side.** From the Documents tab: a `<select>` of the trip's
places (`populateDocPlaceSelect()`, same pattern as the Budget tab's expense-place select) sets
`relatedPlaceId` on either kind of document. Many documents can point at the same place (a hotel's
booking confirmation, a receipt, a floor-plan PDF all linked to one place) — the relationship is
document → place, not the reverse, so there's no per-place list of document ids to keep in sync; a
place's documents are found by filtering. ✅ **From the place side too**: the place Add/Edit modal
has a "Related documents" checklist (`renderPlaceDocsChecklist()`, reusing `getMergedDocsList()` —
the same Drive+manual merge the Documents tab itself renders from, seeded with whatever's in
`docsListCache`; if the Documents tab hasn't been opened yet this session that cache is empty and
only manual links show there — a known simplification, not a live re-fetch triggered from the place
modal). Saving a place diffs the checked state against each document's current `relatedPlaceId` and
writes only what actually changed (`{relatedPlaceId: place.id}` for newly checked, `{relatedPlaceId:
null}` for unchecked-but-was-linked) in one merge write — a Drive file with no prior metadata entry
at all just gets a fresh minimal one.

**Documents show as ordinary place links, everywhere a place does.** `relatedDocLinksHtml(placeId)`
— shared by `placeDetailHtml()` and the Places tab's own row renderer (`renderPlaces()`, which
predates `placeDetailHtml()` and never got migrated onto it, so it needed the same fix applied
separately) — renders each linked document in the same link row as Map/other links, so it's one
click away wherever the place shows up: the Places tab, Routes, and Day-by-day while actually
executing the plan, not just from the Documents tab. A Drive-linked entry has no friendly filename
available in this context (that only exists in the Documents tab's live-fetched listing, not in
`tripNotes.documents`), so it's labeled generically **"View in Drive ↗"** rather than guessing a
name that could be wrong — the user confirmed this is preferable to the earlier-considered
alternative (denormalizing a name snapshot that could drift). A manual link already has a real
title, so that's used instead. The Drive URL itself is constructed directly from the doc id
(`https://drive.google.com/file/d/<id>/view`), no live listing needed for this to work.

`tripNotes.documents` is (and remains) the one thing **never** included in a published trip
snapshot (see "Static/public sharing") — confirmation numbers and any other document metadata stay
private always, regardless of what a Publish modal checkbox says.

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
briefly highlights the corresponding list row, clearing active category/source/coords/search filters
first if they'd otherwise hide it (revealing the list pane if currently maximized-map). Not yet
generalized to other tabs/content — this is Places-specific, not the fully generic Phase 6 view.
The list pane's "Places" header shows a live count next to it — just `(N)` normally, `(N of total)`
while a category/source/coords/search filter narrows the list. A search box above the category
chips filters by space-separated keywords (all must match — AND, not OR), case-insensitive, against
`JSON.stringify(place).toLowerCase()` rather than named fields — simplest way to search
"everything" (name, city, area, note, wishlist, links, category tags, etc.) without hand-picking
and maintaining a field list. A third chip row, **"📍 No coordinates (N)"** (`placesCoordsFilter`,
`#coords-filter`), narrows the list to places with no `coords` at all — self-hides when every place
has coordinates. Distinct from the coordinate-checker's own broader `coordsNeedsCheck()` (which also
flags `coordsSource:"ai"` places as needing a check) — this filter is specifically "completely
missing," for spotting places that need a first pass, not a re-verification.

A **"Sort by"** dropdown (`placesSortBy`, `#places-sort`) above the filters picks the list order,
independent of whatever filters are active: **Want rating** (high→low, the original always-on
default), **Name** (A→Z), **Price** (low→high, a place with no price amount sorts last either way —
raw `price.amount`, not currency-converted, so it's only truly "cheapest first" within one currency;
a trip mixing currencies won't sort perfectly by real cost), and **Recently added** (newest first —
`places[]` is always insertion-ordered since new places are only ever appended, never reordered, so
a place's array index doubles as its "added" order with no separate `createdAt` field needed).

## Multi-user sharing (Phase 7)

✅ **Access control, implemented**: a trip's `participants` array (emails) gates access to that
specific trip document — separate from, and narrower than, the global `config/allowlist`
(allowlist = "can ever sign in and use the app at all"; `participants` = "can see this particular
trip"). **This was a real gap until this pass** — `firestore.rules` previously let any allowlisted
user read/write *every* trip (no `participants` check anywhere), and `loadTripIndex()` queried
`trips` with no filter, so every allowlisted user's picker showed every trip regardless of
membership. Fixed on both sides: `loadTripIndex()` now queries with
`.where('participants', 'array-contains', currentUser.email)`, and the rules require
`request.auth.token.email in resource.data.participants` for `trips/{tripId}` read/update/delete
(and the matching check on `request.resource.data.participants` for create). `tripData/{tripId}`
and `tripNotes/{tripId}` don't store `participants` themselves, so their rules check via
`isParticipant(tripId)`, a helper that does `get(/databases/$(database)/documents/trips/$(tripId))`
— the same cross-document pattern already used for `config/allowlist`. The `trips` update rule also
requires `ownerEmail` to stay unchanged and stay present in `participants` on every write, so a trip
can never end up ownerless from an edit.
**Operational note**: combining `array-contains` with `orderBy` on a different field requires a
Firestore composite index — not automatic, and the very first real run of this query hits a
`failed-precondition` error until one exists (Firestore's own error includes a direct
"create it" console link; building takes a minute or two after clicking it). `loadTripIndex()`'s
error handler used to only handle `permission-denied` explicitly and silently swallow everything
else via a bare `console.error()` — a missing-index failure looked indistinguishable from "you have
no trips," with nothing in the UI hinting why. Now surfaces a specific alert for
`failed-precondition` (pointing at the console link) and a generic one for any other unexpected
error, instead of failing invisibly.
- ✅ **"Manage collaborators"** (Overview tab, next to Edit/Copy/Delete): any current participant
  can invite (append an email to `participants` — resolves the open question below in favor of "any
  participant," not owner-only, since once you're a participant you're already fully trusted with
  the trip's actual content). Only `ownerEmail` can remove someone else; anyone can remove
  themselves ("Leave"); the owner can neither be removed nor leave — no ownership-transfer UI for
  v1, so an owner's only way out is deleting the trip. This "who can remove whom" nuance is
  UI-only, not enforced in rules (see the `isParticipant()` comment in `firestore.rules`) — the
  rules-layer boundary is coarser ("are you a participant at all"), matching the no-roles
  "everyone's fully trusted once invited" model. The modal does a one-off
  `db.collection('trips').doc(currentTripId).get()` for `ownerEmail`/`participants` rather than
  keeping a persistent client-side trip index just for this. Inviting someone not yet on the global
  `config/allowlist` shows a hint that they won't be able to sign in until an admin adds them too —
  the two layers are independent, invited-but-not-allowlisted is a real, expected intermediate state.
- ✅ **Admin: allowlist management** — a header "Admin" button, shown only once
  `checkAdminStatus()` confirms `currentUser.email` is in `config/allowlist.admins` (a UX
  convenience; the real gate is the existing `isAdmin()` rule restricting `config/allowlist` writes).
  Opens a modal: per-email row with an "Admin" toggle checkbox and a Remove button, plus an
  add-email form with an "also make admin" checkbox. Removing an email drops it from both `emails`
  and `admins`. Guards against ever reaching zero admins (which would lock everyone out of this
  panel with no way back short of hand-editing Firestore) — both the toggle-off and the Remove path
  refuse the action if it's the last remaining admin.
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
  **Bug fixed**: routes were always dropped (hardcoded `routes: []` regardless of mode) even though
  the checklist only ever applied to places — copy mode now deep-clones `tripData.routes` as-is. A
  copied route can end up referencing a place the user left unchecked in the checklist; not
  hard-filtered, since the existing renderers already handle a dangling `placeId` gracefully
  ("(unknown place)"). `days[]` is deliberately still *not* copied — day entries are bound to the
  *source* trip's calendar dates, meaningless for a copy with its own date range;
  `syncDaysToTripDates()` regenerates them fresh once the copy's own dates are set, and the copied
  routes are there to reassign once it does.

## Static/public sharing (Phase 7)

✅ **Implemented.** "Publish / Share…" (Overview tab) writes a filtered, **point-in-time copy** of
the trip to `publicTrips/{tripId}` — openly readable (`allow read: if true` in `firestore.rules`),
so a link works for anyone, signed in or not, allowlisted or not. It is *not* a live mirror:
editing the trip afterward doesn't change what the shared link shows until "Publish" is clicked
again — chosen deliberately over making the real trip doc conditionally public, since Firestore
rules gate access to a whole document, not individual fields, so there'd be no clean way to
guarantee `tripNotes.documents` (confirmation numbers) never leaks through a "sometimes public"
rule on the same collection that holds every private trip. A separate copy is the only way to make
that guarantee airtight. Also chosen over generating a downloadable static HTML file — a live
Firestore doc needs no hosting/regeneration story and no Storage/Blaze dependency, where a static
export would need somewhere to live and would go stale exactly the same way, for more effort.

The publish modal offers three content checkboxes — Places, Routes & Days, Ratings & reviews
(default **off**). **Revised twice from the first version**: v1 was a plain `<label
style="display:flex;...">` per row, which read as visually broken once actually used — labels and
boxes didn't line up as a column. v2 tried fixing that inline but hit two real CSS specificity
bugs at once: (1) the pre-existing `.modal-box input{width:100%}` rule stretched the unsized
checkboxes into large boxes, since nothing explicitly sized them; (2) the pre-existing
`.modal-box label{display:block}` rule (specificity 0,1,1) silently beat a bare `.publish-check-row
{display:flex}` rule (0,1,0), so the row never actually became a flex row despite the CSS looking
correct in isolation — found via `getComputedStyle()` showing `display:"block"` when the source
said `flex`. Fixed for good with a dedicated `.publish-check-row` class, requalified as
`.modal-box .publish-check-row{...}` (0,2,0) to win over the label rule, `justify-content:
space-between` so every row's `<span>` label sits flush left and its checkbox sits flush right in
one aligned column, and an explicit `width:18px; height:18px` on `.publish-check-row
input[type="checkbox"]` to stop the stretch. Verified via `getBoundingClientRect()`: all checkbox
right edges and all label left edges land on the same pixel across every row. **Revised from the
first version**: the two preset buttons ("Share as template" / "Share full trip") were removed —
with only three checkboxes, a preset shortcut added a layer of indirection without saving
meaningful effort, and users found them confusing rather than helpful. Routes reference `placeId`s, so checking
"Routes & Days" still force-checks and disables "Places" in the UI (`syncPublishPlacesLock()`)
rather than silently including places behind the checkbox's back. `tripNotes.documents` is never
written to the public copy under any combination — no checkbox controls it, it's simply never
touched by the write, so there's nothing to leak regardless of what's clicked. Re-opening the modal
on an already-published trip now reflects what's *actually* currently published (read back from the
`publicTrips` doc) rather than always resetting to the defaults — editing your last choices instead
of re-declaring them from scratch. A "Copy link" button next to the published URL uses
`navigator.clipboard.writeText()` (same pattern as the AI-instruction copy button elsewhere), with a
"Could not copy automatically" fallback alert if the browser blocks it. Un-publishing deletes the
`publicTrips/{tripId}` doc; the source trip is completely untouched by either action.

Both sides of a share link show **when** that snapshot was published (`formatPublishedAt()`, off
the same `updatedAt` millis timestamp already written on every publish) — the publisher sees
"Published \<date/time\>" in the Publish modal's status line, and the viewer sees the same line
under the trip header on the `?share=` page. Since a share link is a point-in-time copy, not a live
mirror (see above — this is also the direct answer to "why don't newly-added ratings show up on an
already-shared link": they don't, until the trip is published again), this doubles as an at-a-glance
staleness indicator for both sides rather than requiring either party to guess.

A fourth checkbox, **"Let viewers start their own trip from this"** (`allowCopy` on the published
doc), is independent of the three content ones — it controls whether the *read-only viewer* gets a
"Start my own trip from this" button, not what's included in the snapshot itself. This is what turns
"share as template" from view-only into something a recipient can actually build on, addressing the
three-modes distinction directly: **invite as collaborator** (existing "Manage collaborators" —
same trip, full edit access) vs. **share as snapshot** (`allowCopy` off — view only) vs.
**share as template** (`allowCopy` on — view, plus a one-click way to start their own independent
copy). The button itself (`#share-start-own-trip`) originally carried `class="primary"`, which
turned out to have zero effect outside `header.hero button.primary` — it rendered with no styling
at all ("looks out of place... like it has no CSS"). Fixed with a dedicated `.share-cta-btn` class
matching the app's existing `.btn-save` look (dark fill, white text, rounded).

Clicking it opens `#start-own-trip-modal` — a small confirmation dialog, not an immediate copy —
pre-filled with the source trip's name in an editable text input (`openStartOwnTripModal(snap)`,
storing the snapshot as `startOwnTripSnap`). This exists because the first version cloned the
trip under its original name unconditionally, which is confusing once you have two trips called
the same thing; now the viewer explicitly confirms (or changes) the name before anything is
created, with empty-name validation blocking the create. Confirming calls
`startOwnTripFromShare(snap, newName)` — signs the viewer in if they aren't already
(`auth.signInWithPopup()`, same Google provider as the main auth screen) and then creates a
brand-new `trips`/`tripData`/`tripNotes` doc set seeded from the snapshot's `places`/`routes`,
using `newName` for the created trip's `meta.name`/`trips` doc `name` instead of blindly reusing
the source name — owned solely by them, exactly like Copy Trip's own create logic, just sourced
from a `publicTrips` doc instead of a live trip they already participate in. **Deliberately never**
seeded from the snapshot's `tripNotes` even when the publisher included reviews — someone else's
personal ratings/reviews aren't something a fresh trip should start with. Hands off into the normal
authenticated app afterward (`location.href = location.pathname`, dropping `?share=`) rather than
duplicating the whole post-sign-in bootstrap inline in the share view.

⬜ **Known limitation, not yet resolved**: viewing a shared snapshot never requires allowlist
membership, but *creating* a trip always does — the `trips` `create` rule requires `isAllowed()` the
same as every other write (see "Security model"). So "start my own trip" only actually works for a
viewer who's already on the app's global allowlist; anyone else hits `permission-denied`, shown as
"You'll need to be added to this app's allowlist..." rather than a raw Firebase error, but still a
dead end for a genuinely outside recipient. Loosening the `create` rule specifically for this path
(e.g. letting anyone authenticated, not just allowlisted users, create a trip) would be a real
expansion of who can write to this app at all, not a decision to make silently — flagged here for a
future call rather than resolved.

`?share=tripId` in the URL is checked at script boot, before the normal `auth.onAuthStateChanged`
listener is even registered — a fully separate, unauthenticated path (`renderShareView()`) rather
than a branch inside the authenticated app flow, so an ambient signed-in session from a previous
visit can't flash the normal app UI over the share view. It reuses the same rendering helpers the
authenticated app uses (`placeDetailHtml()`, `formatDateRange()`, ...) by populating the same global
`tripData`/`tripNotes` they already read from — this path never writes anything back (aside from the
opt-in "start my own trip" action above), and only ever reads `publicTrips/{tripId}`, never the real
`trips`/`tripData`/`tripNotes` docs. A missing/unpublished trip shows a plain "not published"
message rather than an error page. **Routes render differently depending on whether reviews were
included**: without `tripNotes` in the snapshot, falls back to the same compact
`routeStopSequenceLine()` used everywhere else (`shareRouteHtml()`, `hasReviews=false` branch); with
`tripNotes` present, renders full per-stop detail via `placeDetailHtml()` plus a done-checkmark
(`stopRatingSummaryHtml()` — the same compact star-string helper Day-by-day Level 2 uses) and the
actual review text (`shareStopReviewHtml()`, a new helper — `stopRatingSummaryHtml()` alone only
ever showed an average rating and review count, not what anyone actually wrote, which was the whole
point of choosing to share reviews at all).

## File uploads (Phase 8, mostly superseded by "Documents tab")

Real document upload **is** implemented — via the trip's own Google Drive folder (see "Documents
tab"), not Firebase Storage, so it never needed the Blaze plan at all. Firebase Storage requires
Blaze for any usage as of Feb 3, 2026 (previously had its own free tier; see "Billing"), which was
the actual reason this phase was deferred in the first place — the Drive approach sidesteps that
requirement entirely rather than waiting on it.

What's still genuinely unbuilt: a place *photo* the user uploads directly (as opposed to the
existing Wikipedia auto-lookup) — that would still most naturally be a plain `imageUrl` field
pointing at any public image, and doesn't need Drive's folder-listing machinery since a photo
belongs to one specific place, not a trip-wide document pool. Not started; Storage/Blaze remains
the fallback path if Drive ever turns out to be the wrong fit for that specific case (e.g. wanting
tighter access control than "anyone with the folder link").

## Preloaded location data (Phase 9, stretch)

**Revised from the original plan**: rather than an offline script producing a bundled static JSON
of popular places, this is now planned as an **on-demand, in-browser live query** — same three
sources, but queried directly from the client at the moment the user asks for suggestions for a
specific city, feeding into the same import/preview pipeline the AI-generation flow already has.
No precomputed dataset to maintain or go stale, no separate build/publish step.

Confirmed viable client-side (spiked against Copenhagen, 2026-08-13): both the Wikidata SPARQL
endpoint (`query.wikidata.org/sparql`) and the Wikimedia pageviews REST API
(`wikimedia.org/api/rest_v1/metrics/pageviews/...`) send `Access-Control-Allow-Origin: *`, so a
plain browser `fetch()` works, no proxy needed — same trust model as the existing Wikipedia photo
lookup. **Query shape matters a lot**: a naive query walking the full administrative hierarchy
(`wdt:P131*` — "everything transitively located within Copenhagen") timed out at 65s. Switching to
a **geographic bounding-box query** (the `wikibase:box` service, corner coordinates instead of an
administrative-hierarchy walk) fixed that — 30 places for Copenhagen (museums, parks — Rosenborg
Castle, Frederiksberg Gardens, Rundetaarn, Carlsberg Museum, etc.) in ~14.5s, clean results, no
junk. Still too slow for a snappy in-app "click and wait" UX as-is (~14.5s for one city, one batch
of types) — needs a follow-up pass (smaller bounding box, fewer `VALUES` types per query, or
splitting into parallel per-type requests) to get comfortably under ~4s before this is worth
wiring into the UI. Pageviews-per-article lookup (the popularity signal) is fast (~0.25s/article)
and also CORS-open. GeoNames (city/country data + autocomplete) still needs its own free-tier
viability check — not yet spiked.

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
- **Modals**: `.modal-actions` (Cancel/Save row) is `position:sticky; bottom:0` within `.modal-box`'s
  own scroll area, not just a trailing element that scrolls away — added after a tall modal (the
  route editor, the advanced search dialog) required scrolling all the way down just to find the
  Save button. Applies to every `.modal-box`/`.modal-actions` pair automatically, not something to
  opt into per modal. Clicking the backdrop closes the modal, but only past a margin
  (`MODAL_OUTSIDE_CLICK_MARGIN_PX`, 60px, `isClickPastModalMargin()`) beyond the dialog's actual
  edge — a click landing right at the boundary (a near-miss on content close to the edge, or a
  scrollbar) used to close it immediately same as a deliberate click way out on the backdrop, which
  read as accidental dismissal. Every backdrop-click-to-close handler in the app goes through this
  helper; add new ones the same way rather than a bare `e.target.id === '...-modal'` check.
- **Note differentiation**: several distinct "note" concepts used to all render as the same plain
  `.place-meta` line, making them impossible to tell apart at a glance. Each now has its own
  treatment: a structured field's own qualifier (`price.note`, `hours.note` — "Pay per stall",
  "Guard change ~12:00") renders as a small inline pill right next to the value it annotates
  (`.field-note-chip`, via `noteChipHtml()`), not joined into the same text with " · "; a place's
  general description (`places[].note`) gets its own italicized, lightly-backgrounded block
  (`.place-general-note`); a route's per-stop planning note (`routes[].stops[].note`) renders
  directly beneath that with no label at all (`.route-stop-note`, a different background color is
  the only thing distinguishing it) — previously both showed a text label ("Planning note:"/"Note
  for this stop:") that then had to be manually kept in sync across every place these render
  (`placeDetailHtml()`, the Routes tab's expanded view, the Places tab list). `placeDetailHtml()`
  takes the route note as `opts.routeNote` rather than the caller appending its own separately-
  styled line after the call, so the two notes always end up adjacent and consistently styled
  regardless of caller.
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
  flagged checklist preview, plus an optional bigger one-at-a-time card review with colored
  Reject/Maybe/Approve) and Tier 3 (a "✨ Generate via AI directly" button calls a Firebase Cloud
  Function backed by the Gemini API — same instruction/validation pipeline as Tier 2, just without
  the manual copy-paste step) for both Places and Routes generation — see "AI generation model".
  **Deployed and live** (`generateAiContent`, v2 callable, `us-central1`, Node 22) — smoke-tested
  unauthenticated (correctly returns 401/`UNAUTHENTICATED` rather than crashing); a full
  authenticated end-to-end generation still needs manual in-browser testing as a signed-in
  allowlisted user. Artifact Registry cleanup policy set (1-day image retention) to avoid
  accumulating container-image storage costs across future deploys.
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
- ✅ Delete trip and Copy trip live in the Overview tab, next to "Edit trip details". Delete
  (confirm, removes all three docs; the existing `trips` onSnapshot listener handles picking a new
  active trip or showing the empty state afterward) is a plain red button, no "danger zone" framing.
  Copy trip: see "Duplicate trip" under Phase 7 above.
- ✅ **Import / Export (JSON)**: the old "Manage / Import" nav tab (always just a stub) is gone —
  replaced by an "Import / Export…" dialog on the Overview tab (`#importexport-modal`), mirroring
  the Publish/Share modal's checkbox pattern (Places / Routes & Days / Ratings & reviews) for both
  directions instead of a dedicated tab. **Export**: builds a downloadable JSON snapshot client-side
  (same shape as a Publish snapshot — `tripNotes.documents` never included, same rule Publish/Share
  follows) — "Copy to clipboard" or "Download .json" (`Blob`/`URL.createObjectURL`, no server
  involved). **Import**: paste a JSON snapshot, "Validate" parses it and reports which sections were
  found, then per-section checkboxes (disabled for sections not present) pick what actually merges
  into the *live* trip via "Import selected". Places are validated through `sanitizePlaceItem()` —
  extracted from the AI place-import validator (`validateAiResponse()`) into a shared function so
  there's one definition of "what a valid place object looks like" rather than two that could drift;
  unlike the AI-tier2 path (which always stamps `source:{ai:true,user:false}`), a JSON-imported
  place preserves its own `source`/`coordsSource` when present (re-importing a previously-exported,
  already-`coordsSource:"osm"`-verified place shouldn't demote it back to needing another coordinate
  check). Routes are deep-cloned with **freshly generated ids** (collision safety, e.g. importing
  into the same trip it was exported from) — `stops[].placeId` references are left as-is and simply
  render as "(unknown place)" if dangling, the same tolerance Copy Trip's routes already rely on.
  **Days are deliberately never imported** (checkbox and all) — same reasoning as Copy Trip not
  copying days, they're bound to a specific date range and `syncDaysToTripDates()` regenerates them
  fresh already; the "Routes & Days" checkbox label only ever affects `routes` on the import side,
  despite matching Publish/Share's wording for export-side consistency. Ratings & reviews import
  merges into `tripNotes.places`/`tripNotes.routeStops` by key (`{merge:true}`), same as any other
  `tripNotes` write.
- ✅ Routes tab (Phase 4): route generation via either AI (paste-back, mirroring the Places
  AI-generation pipeline) or an in-app clustering algorithm (no AI, k-means + nearest-neighbor +
  2-opt + a category-adjacency rule — see "Routing / planning" for the full breakdown), picked via a
  toggle in the same "Generate routes" modal — both feed the same checklist preview/import pipeline.
  A manual route editor with a live map (also used to edit AI- or algorithm-generated routes —
  add/remove/reorder stops, per-stop planning notes, unified "interstop" items — break or typed
  travel leg, zero-or-more per gap between stops, unit-aware distance/time/cost — a weighted
  proximity+variety sort on the add-place search, and an advanced search dialog with checkboxes and
  recoloring map pins for picking several places at once, see "Routing / planning"). Generated
  candidate routes (either method) can be edited (same editor, a `'preview'` mode) before the
  "Import selected" commit step. List grouped by city with Edit/Delete, and an expandable per-route
  list+map view (numbered markers + connecting line, bidirectional list/map focus), with a
  provenance tag per card ("✨ AI-generated" / "🧮 Algorithm" / "✎ Manual"). The stop sequence
  (compact card, preview checklist, expanded view, editor, Day-by-day Level 3) renders one stop per
  line with each gap's interstop item(s) on their own indented line beneath, and shows each place's
  thumbnail where one exists (`routeStopThumbHtml()`) — see "Routing / planning". `normalizeRoute(route)` reads
  either the old interleaved-stops-with-per-stop-travel shape or the new places+interstops shape and
  returns a uniform `{places, interstops}` view — every renderer, the editor, and the Day-by-day tab
  go through it, so old routes display correctly without a migration step and only "upgrade" to the
  new shape once edited and saved.
- ✅ Real travel-time lookups: a "🧭 Calculate times & distances" button in the route editor calls
  OpenRouteService (Matrix API, one call per distinct travel profile in the route, rate-limited +
  session-cached) to fill in real distance/time for walk/bike/car/taxi interstop legs — see
  "Routing / planning". Requires `ORS_API_KEY` to be filled in (free signup, still a placeholder by
  default); auto-running this right after route generation is deliberately not wired up yet
- ✅ Day-by-day tab (Phase 4 assignment + Phase 5 execution): a "+ Add routes" checklist assigns
  routes to the selected day (moved here from the Routes tab, see "Day-by-day tab" above), plus a
  "🔍 Nearby places" dialog next to it (browser geolocation + radius + category filter over the
  trip's saved places, adds a result as a single-stop route on the current day — no new data
  structure needed, see "Day-by-day tab" above) → route
  overview (one assigned-route row per line, list+sticky map reusing the Routes tab's
  expandable-view code, with reorder/remove, full Places-tab-level detail per stop via the shared
  `placeDetailHtml()`) → single-stop execution view (same full detail plus an interactive wishlist
  checklist, Prev/Next navigation with an "N / M" counter, a 1-5 full-width star rating + one review
  textarea replacing the old numeric rating/two-note-fields/manual-done-checkbox combo — done is now
  auto-set from rating/review) — see "Day-by-day tab" above. `days[]` auto-syncs to the trip's date
  range. Reaching a stop's detail view the first time is still manual (no auto-advance to the next
  undone stop on entry)
- ✅ Multi-user access control (Phase 7): the trip picker and Firestore rules now both filter by
  `participants`, closing a real gap where every allowlisted user could see every trip — see
  "Multi-user sharing" above. "Manage collaborators" (invite/remove/leave) on the Overview tab, and
  an admin-only allowlist panel (header "Admin" button) for `config/allowlist`
- ✅ Static/public sharing (Phase 7): "Publish / Share…" writes a filtered, point-in-time copy to
  `publicTrips/{tripId}` (openly readable, checkboxes for what to include, `tripNotes.documents`
  never included) and `?share=tripId` renders it read-only with no sign-in — see "Static/public
  sharing" above
- ✅ Budget tab: combines manual `tripData.expenses[]` entries with live-read
  `tripNotes.routeStops[key].ratings[uid].spent` (the latter read-only, editable back at the
  Day-by-day stop) into one list plus totals by category/day/paid-by, compared against
  `meta.preferences.budget.realistic` — see "Budget tab" above
- ✅ Documents tab: a trip's own Google Drive folder (`meta.docsFolderId`), listed live via a
  restricted API key (no Blaze) and inline Preview via Drive's own embeddable viewer; manual
  (non-Drive) links work independent of a folder being set. In-app upload was tried and removed
  after real-account testing (see "Documents tab" above) — dropping a file into the Drive folder
  directly and seeing it in the app's listing is the v1 workflow. Documents can be linked to places
  from either side (the Documents tab's own relate-a-place picker, or a "Related documents"
  checklist on the place Add/Edit modal), and show as ordinary clickable links wherever that place
  renders (Places tab, Routes, Day-by-day) — see "Documents tab" above
- ⬜ Everything else in this file is planned, not built

An earlier draft of `index.html` (superseded) had a trip picker, tabs, and per-place done+note
editing built against an ad-hoc schema (`stars`/`q` fields, no `routes` collection) that predated
the schema finalized in this doc. That draft was scrapped in favor of rebuilding against the
current schema from the ground up, starting with the shell + auth.

## Open questions (genuinely undecided — flag if implementing, don't just guess)

- Exact JSON size/complexity where template-splitting (Phase 2) actually becomes necessary —
  no real number tested yet.

## How to request changes

Describe the desired behavior in plain language; a screenshot of current UI helps for anything
visual. After implementing a change, update this file's relevant section (schema, phase status,
or open questions) in the same pass — don't let it drift out of sync with the code.
