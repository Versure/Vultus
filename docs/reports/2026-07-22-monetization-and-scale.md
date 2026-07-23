# Monetization & Scale Report — 2026-07-22

> Point-in-time analysis (codebase + market research, July 2026). Answers three
> questions: does the sync design carry 100,000 users, what does a user cost,
> and what should the app charge? The scalability fixes identified here are
> specced as **0100 (indexed dispatch lookups)** and **0101 (sync-pipeline
> sharding)**. Market/pricing facts are as-researched on 2026-07-22 and will
> drift.

## Verdict at a glance

| Question                    | Answer                                                         |
| --------------------------- | -------------------------------------------------------------- |
| Scales to 100k users today? | **No** — 3 fixable bottlenecks; the data model itself is sound |
| Marginal cost / user / year | **≤ $0.60** worst case, likely ~$0.15                          |
| Recommended price           | **$15–20/yr** premium tier (Plex sync + notifications + stats) |
| Break-even                  | ~150 subscribers on TMDB commercial · ~10 on TheTVDB           |

## Part 1 — Scalability

The architecture is right: the global shared `title-cache` means a show tracked
by 10,000 users is fetched from TMDB and written once per night, not 10,000
times. FCM is free and posters load from TMDB's CDN, so neither is a cost
driver. Three implementation choices break before 100k users, in this order:

### 1. Notification dispatch scans every watchlist on every write (breaks first — cost bomb)

`findUsersTracking` (`apps/functions/src/dispatch/adapters.ts`) fetches the
entire `watchlist` collection group and filters in memory, on every
`dispatchNotifications` fire — and a fire happens per availability-doc write
(up to ~10 per synced title per night). At 100k users × ~50 titles that is
~5M document reads _per fire_: billions of Firestore reads a night, all
serialized through one instance.

**Fix (spec 0100):** an indexed `where('tmdbId','==',…)` collection-group query
so each fire reads only the users tracking that title. Watchlist docs already
carry `tmdbId` — no migration, just a `firestore.indexes.json`
`COLLECTION_GROUP` override.

### 2. The nightly sync is one serial invocation (breaks second — hard timeout)

`maxInstances: 1` is set globally (`apps/functions/src/main.ts`), the whole
pipeline runs in a single invocation under a 540s timeout, and the TMDB client
throttles itself to ~4 req/s (250ms between calls ⇒ ~0.5s/title). Ceiling:
roughly 1,000 distinct titles — and the timeout history (60s → 300s → 540s)
shows it has been hit repeatedly. TMDB's real limit is ~50 req/s; the app uses
8% of it.

**Fix (spec 0101):** Cloud Tasks fan-out — the entry function gathers and
dedupes once, enqueues title shards to `onTaskDispatched` workers, with queue
rate limits sized to keep aggregate TMDB throughput ≤ ~40 req/s and explicit
per-function `maxInstances`.

### 3. Episode sync re-fetches the same show once per tracking user (breaks third)

The episode-insert pass (`apps/functions/src/sync-episodes.ts`) enumerates one
entry per (user, show) pair and calls TMDB per season _per pair_ —
O(users × shows × seasons). Two users tracking the same show fetch its seasons
twice. At scale this term dominates TMDB call volume.

**Fix (spec 0101):** fetch each show's season/episode data once per night into
a global cache under `title-cache/{tmdbId}`, then fan out only the cheap
per-user Firestore writes. The same spec consolidates the three full watchlist
collection-group gathers per run into one.

Sequencing: fix 1 before any growth push; fixes 2–3 before ~1,000 distinct
tracked titles. Checked and found fine: Firestore write throughput on shared
docs, FCM (free at any volume), image delivery (TMDB CDN), client listener
patterns.

## Part 2 — Unit economics

Modeled post-fixes, at ~50 tracked titles and daily app use per user,
europe-west1 Firestore pricing.

| Driver                                                     | Volume / user / month  | Cost / user / month            |
| ---------------------------------------------------------- | ---------------------- | ------------------------------ |
| Client listener reads (watchlist, availability, inbox)     | ~5–10k reads           | $0.002–0.006                   |
| Client writes (status changes, episode marks, Plex steady) | few hundred writes     | ~$0.001                        |
| Amortized nightly global sync (~20k titles × ~11 writes)   | shared                 | < $0.001                       |
| Notification dispatch (post-0100, indexed)                 | ~300 reads + 60 writes | < $0.001                       |
| Cloud Functions compute + FCM                              | inside/near free tier  | ~$0                            |
| One-time: first Plex library import (~7,500 ops)           | once                   | ~$0.01 once                    |
| **Total**                                                  |                        | **$0.01–0.05/mo (≤ $0.60/yr)** |

Any price ≥ ~$1/year covers marginal cost from user #1. At 100k users total
infra lands around $500–1,000/month ($0.005–0.01 per user).

### The dominant cost is a license, not a server

**TMDB's free API is non-commercial only.** The moment Vultus derives revenue —
subscriptions, ads, even affiliate links — a commercial license is required.
There is no published indie tier; community reports point to **~$149/month
(~$1,788/yr)**, and TMDB has left "when does a small paid app need this?"
questions unanswered. This one line item exceeds all Firebase costs combined
until well past 10,000 users.

Published-terms alternative: **TheTVDB** is free for companies under $50k/yr
revenue (then $1,000/yr to $250k), but its movie data is weaker. Worth
architecting the metadata layer so TVDB can substitute or supplement.

### Break-even (at $15/yr, netting ~$12.75 after the ~15% Play fee)

| Scenario                             | Fixed cost / yr | Break-even                              |
| ------------------------------------ | --------------- | --------------------------------------- |
| Free app (TMDB non-commercial)       | ~$0             | neutral always — but no revenue allowed |
| Monetized on TheTVDB (< $50k/yr rev) | ~$100           | **~10 subscribers**                     |
| Monetized on TMDB commercial         | ~$1,900         | **~150 subscribers**                    |

Google Play: 15% on subscriptions today, dropping to ~10–15% all-in under the
June 2026 fee changes (US/EEA/UK first). One-time $25 developer fee.

### Price recommendation

Freemium at **$15–20/year** (~$2/month). Free tier: core tracking. Premium:
**Plex sync + release notifications + stats** — the bundle the market
demonstrably pays for. That is 3–4× worst-case per-user cost even if every
user were free, sits inside the market's $20–35/yr cluster, and undercuts
Trakt's $60/yr by 3–4×. A lifetime tier, if offered, should be 4–6× annual
(~$75–100); SeriesGuide abandoned one-time pricing because server costs recur.
True "cost-neutral from the first user" holds on the TVDB route or while the
app stays free; on TMDB, from roughly subscriber #150.

## Part 3 — Market (as of 2026-07-22)

Two recent shifts reshape the market:

- **TV Time is dead.** The category's biggest app (26M lifetime installs) shut
  down 2026-07-15. Whip Media: free-with-ads wasn't sustainable, and there
  wasn't demand for _their_ paid app. Millions of users are migrating; Hobi,
  Moviebase and MyShows are courting them.
- **Trakt raised VIP to $60/yr** (from legacy $15–30) in 2025 and tightened
  free-tier limits again for 2026, generating real backlash.

| App                           | Free tier                                     | Paid                                  | Plex sync                        |
| ----------------------------- | --------------------------------------------- | ------------------------------------- | -------------------------------- |
| Trakt                         | Capped (250 watchlist items, 5 lists in 2026) | VIP $60/yr                            | **Yes — VIP-only** (main seller) |
| Simkl                         | Tracking + notifications; Plex webhook free   | PRO ~$35/yr · VIP ~$70/yr · life $149 | Yes (free tier)                  |
| TV Time                       | was free / ads                                | —                                     | Dead 2026-07-15                  |
| SeriesGuide (Android)         | Local tracking                                | "X" yearly sub (killed one-time Pass) | Via Trakt only                   |
| Hobi                          | Fully free, no ads; TV Time migration partner | —                                     | Via Trakt                        |
| Letterboxd (movies only)      | Logging, social                               | Pro $19/yr · Patron $49/yr            | No                               |
| JustWatch                     | Streaming search, ads                         | Pro $2.49/mo                          | No                               |
| Sofa (iOS)                    | Lists                                         | $29.99/yr                             | No                               |
| Callsheet (iOS, TMDB-powered) | 20 searches                                   | $9/yr                                 | No                               |

Takeaways:

- Serious tracker subscriptions cluster at **$20–35/yr**; Trakt's $60 is the
  resented ceiling.
- Basic episode tracking is table stakes. What gets paywalled: **media-server
  sync** (Trakt's whole VIP pitch), unlimited lists, backup, stats, no-ads.
- Vultus's on-device LAN Plex sync is exactly the proven premium anchor — and
  unlike Trakt's server-side webhook infra, it has near-zero marginal cost.
- Free-with-ads at scale failed (TV Time); free-tier generosity is shrinking
  (Trakt). The market is being trained to pay for trackers right now.

## Bottom line

1. **Scalability** is fixable with specs 0100 + 0101; the dispatch query
   (0100) is urgent, sharding and episode dedup (0101) before ~1,000 distinct
   titles.
2. **Infra cost** is a non-issue at any realistic price (≤ $0.60/user/yr worst
   case).
3. **The decisive monetization question is metadata licensing** — get a written
   TMDB quote before charging anything, or design the metadata layer so
   TheTVDB can substitute.
4. **A $15–20/yr premium tier** anchored on Plex sync + notifications is
   cost-neutral from ~150 subscribers (TMDB) or effectively from user #1
   (TVDB).

---

_Codebase findings verified against `apps/functions` + `libs/functions/sync-titles`
at the 2026-07-22 state of `main`. Market sources: TechCrunch (TV Time
shutdown), Trakt forums (VIP pricing, 2026 limits), Simkl docs,
seriesgui.de/whypay, letterboxd.com/about/pro, support.justwatch.com, 9to5Mac
(Sofa), caseyliss.com (Callsheet), firebase.google.com/pricing,
cloud.google.com/run/pricing, themoviedb.org/api-terms-of-use,
thetvdb.com/api-information, Android Developers Blog (June 2026 Play billing).
The TMDB $149/mo figure is community-reported, not an official published tier._
