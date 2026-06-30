# Palantirish — Session Handoff (for the next Opus session)

Read this first, then skim `src/WarEraOracle.tsx`. The memory files
(`project_architecture`, `warera-api-auth`, `warera-referrer-employer-api`,
`current-state-and-next-steps`) auto-load and overlap with this.

## What the app is
**Palantirish** — a WarEra (browser game) multi-account / bot-net detection tool. You scan a
region, a single user, or a stored local DB, and it flags suspicious accounts and shows WHY,
centred on a relationship map. Investigators triage a left **case list**, open a dossier
(map + matrix + sidebar + engagement + findings timeline), and **drill into linked accounts**.

- Stack: React 18 + TypeScript + Vite + Tailwind. **One ~4,100-line component**
  `src/WarEraOracle.tsx` holds ~all UI + analysis. Two helper files now exist:
  `api/cache.js` (Vercel serverless: Upstash Redis cache + WarEra fetch) and
  `src/localStore.js` (the Local DB — a user-picked on-disk file). Icons: `lucide-react`.
- Deployed on **Vercel → palantirish.vercel.app**, auto-deploys from `main`.
- Repo: `healthpack/WarEra-Oracle`. Tag **`pre-localdb`** is a rollback point before the Local
  DB work. Branch `feature/local-db` was merged to main (kept for reference).

## Working conventions
- **Verify with `npx vite build`** before committing (no test suite; build = the check).
  `api/cache.js` is NOT in the vite build (serverless) — eyeball it.
- Commit + push to **`main`** (no PRs). Messages end with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Deploy race / verify live:** after pushing, the live bundle hash should match your local
  `vite build` output. Check: `curl -s https://palantirish.vercel.app/ | grep -oE 'index-[a-z0-9]+\.js'`.
  A same-minute push can be missed; it usually lands within ~1 min. Re-check before telling the
  user "it's live."
- **Styling:** inline hex, Cobalt palette (bg `#070b18`, panel `#0c1226`, elev `#121b35`/`#1b2748`,
  line `#1f2b4e`/`#2e3f6a`, tx `#eaf0ff`/`#9fb0d4`/`#5d6e96`, link `#4fc3e8`, crit `#ff5d6c`,
  high `#ffab3d`, med `#ffd84d`, purple/nav `#a98bff`, green/ok `#3fd0a3`). Mono font for
  IDs/usernames/numbers. New nav/affordance accents use purple `#a98bff` (scan) / green `#3fd0a3` (view).
- **API key:** the user pastes a real `wae_` key (Sven's). Fine for read-only probing during dev.
  Advise rotation; never hardcode. (They also once pasted a JWT in a screenshot — if that recurs,
  remind them to log out to invalidate it; JWTs are account-level.)

## Architecture
- **Two-phase scan** (`processPlayerPhase1` / `processPlayerPhase2`):
  - Phase 1 runs for every user (transaction-derived): wash/sniper/APM/pacing, hermit,
    direct-launderer, tip farming, wealth anomaly, coin funnel, **work-consistency** (wage tx) →
    `analyzePhase1`. Auto-triggers phase 2 if score ≥ threshold.
  - Phase 2 (flagged users): companies + `worker.getWorkers` + worker profiles + **employer
    resolution** + per-worker wage-tx for slow-leveler candidates → `analyzePlayer` (full).
- **Heuristic registry** = single source of truth. Module-level `HEURISTICS` object
  `{ type: { tier, matrixChip, detail:{observed,rule,note} } }`. `CRIT_TYPES`, `HIGH_TYPES`,
  `MATRIX_LINK_LABEL`, `FINDING_DETAIL` are derived. **To add a heuristic:** write a `detect*`
  (or compute in phase 1) pushing `{type,severity,desc,workers,detectionWeight,...}`, call it from
  `analyzePhase1`/`analyzePlayer`, add ONE `HEURISTICS` entry. Sort arrays + `buildShortSummary`
  + the analyzePlayer `summaryParts` may also need a line.
- **Concept G UI:** left case list → center dossier. Dossier = `MapSidebar` (LEFT: identity,
  verdict, summary, Report/Watch/Rescan/DeepDive/Back, Signal Ledger) + `ClusterMapPanel`
  (`ClusterMap`: drag/zoom/hover, boss pinned at TOP, rainbow stacked edges, "Coins out" toggle)
  + `LinkedAccountMatrix` + `EngagementNetwork` (tippers) + the findings timeline.
- **Map graph** = `buildClusterGraph(activeResult, globalCache, showOutflow)`. Node kinds: `worker`
  (dashed employ spoke), `partner` (wash), `employer`, `tipper`, `funnel` (sink: MU/country/user),
  `muLeader`. Edge types: `name`/`clone`/`wash`/`funnel`/`role`/`employer`/`tip`. Badges on nodes:
  BAN / INACTIVE / ⏱+Ns (coordinated-creation) / SAME-MINT(removed). Outflow sinks are an opt-in
  layer (the "Coins out" toggle, default ON now).

## Local DB system (the big build this session) — `src/localStore.js`
- An **opt-in persistent cache = a real file the user picks on disk** (Chrome File System Access
  API; append-only NDJSON). Top-bar **Local DB** chip: New / Open / Reconnect (remembers the file
  handle in a tiny IndexedDB) + a **3-way mode toggle** + record/size/staleness readout.
- **Modes** (`dbMode` state, `dbModeRef`): **Live** (API only) · **Hybrid** (serve from the file,
  fetch only the gaps) · **Local** (file only, no API). Default Live.
- `smartFetch(endpoint, payload, forceOfficial=false, bypassLocal=false)`: in local/hybrid it
  reads the file first; `bypassLocal=true` forces live (used for username→ID resolution so search
  works in Local mode). Successful live responses are mirrored into the file.
- **Transactions use `gatherTx(type, userId, cutoff)`** (NOT generic per-key caching) because they
  are cursor-paginated. It stores a per-user merged set `txfull:<type>:<userId>` and, in Hybrid,
  fetches newest-first and **stops at the first already-stored tx `_id`**, merging only the new
  ones (a true delta refresh). Backward-compatible: rebuilds from old per-page cache if no txfull
  set. Used for itemMarket/donation/articleTip/wage.
- **Full scan** = throttled (~8 concurrent) all-regions crawl that is **pure data-gathering** (runs
  phase 1 only to decide phase-2 fetching, stores everything, shows NO findings) and **resumable**
  (skips accounts already in the DB). Surface flags afterward via Local DB mode + a scan.
- **Inactivity** uses each record's OWN fetch time as the reference (`inactiveRefFor`), so reading
  an old DB doesn't mass-flag (`localStore.fetchedAtFor`).
- "Coins out" toggle / case-list sort: both memoised; the case list renders only the **top 300**
  rows for speed.

## Navigation / investigation (this session)
- **Drill-down between user dossiers.** `openSuspect(id)` pushes a history stack; `navBack()` pops;
  a **Back** button shows in the sidebar / empty state. Left-list clicks reset the stack (new root).
- **Open affordances** (`onOpenUser`, `scannedIds`): a magnifier on every USER node (map), matrix
  row, and tipper card — **green** if already a case (opens it), **purple** if not (scans + opens).
  NOT on MU/country sink nodes. Worker findings cards show **⟳ Scan → ⊙ View profile** (flips once
  scanned).
- **`forceResult`**: manual scans (worker/map) pass `rescanPlayer(id, country, true)`, which sets
  `player.forceResult` so the analyzers surface a dossier **even when the account is clean** (else
  nothing was added and buttons never changed / "needed several presses").
- **Deep Dive** (sidebar button): boss↔user **timing correlation**. Counterpart = employer (else
  top wash partner). Pulls both accounts' action timestamps via `gatherTx` (instant in Hybrid/Local),
  computes hour-of-day **containment** + Pearson **rhythm** + **10-min shadow**, shows overlaid 24h
  histograms + verdict. `runDeepDive` toggles `isScanningRef` so gatherTx's loop runs.

## Full heuristic list (in `HEURISTICS`)
Critical: `market_automation`, `superhuman_apm`, `script_pacing`, `transaction_abuse` (wash, NO
wealth/level gate), `money_laundering`, `coordinated_donation`.
High: `wealth_anomaly` (<0.45× or >2× level median; low bound lvl 11+), `coin_funnel`,
`hermit_network`, `mutual_hermit`, `fidelity_ring`, `cloned_progression`, `coordinated_creation`
(ALL-PAIRS — union-find over the whole cluster within `COCREATE_WINDOW_S=10`s), `wage_slave`
(energy+production skills, companies+management=0, low wage), `slow_leveler` (level < 0.5× median
for account age via the level-for-age baseline; escalates to HIGH when the account ALSO works
almost every day, per its wage-tx `workConsistency`).
Medium: `low_wage`, `wage_uniformity`, `naming_pattern`, `temporal_clustering`, `no_production_bonus`,
`tip_farming`. Non-scored: BAN/INACTIVE badges, employer edge, MU-sink leadership, tipper-on-map.

## Key API / data facts (verified)
- **Auth:** the `wae_` key as `X-API-Key` authenticates everything the app uses on BOTH the
  warerastats gateway and official api2. Routing = gateway-first / official-fallback.
- **getUserLite:** wealth/level under `rankings.userWealth.value` / `rankings.userLevel.value`;
  game level under `leveling.level` (1–50). Ban = `infos.isBanned`. Has `dates.*` (lastConnectionAt,
  lastWorkAt, lastDailyRewardClaimedAt, message/event checks…) and `createdAt`. **`isActive` is
  unreliable** (false for many active players — do NOT use it for inactivity).
- **Inactivity:** "last active" = max of all `dates.*` timestamps; inactive if > 5d before the
  data's reference time.
- **ObjectId = creation time** in the first 4 bytes: `objIdSeconds(id)=parseInt(id.slice(0,8),16)`
  (exact vs createdAt). Drives `coordinated_creation` and the "Newest" sort.
- **Transactions** (`transaction.getPaginatedTransactions`, NO_CACHE in Redis): types include
  `itemMarket`, `trading` (2nd market channel), `donation`, `articleTip`, `wage`, `openCase`,
  `craftItem`, `dismantleItem`, `battleLoot`, `applicationFee`. Donation tx: buyer=sender,
  seller=`sellerMuId`/`sellerCountryId`. **`wage` tx: `sellerId`=worker, `buyerId`=EMPLOYER**,
  `money`=pay, `quantity`=items — heavy producers emit ~1 tx/item so many/day.
- **stats:** `worksCount`, `case1`/`case2` (crate opens), `damagesCount`, `wealth`. (worksCount is
  poisoned by the energy skill → we use wage-tx work-days instead.)
- **skills** keys: energy, health, hunger, attack, **companies** (company-limit), entrepreneurship,
  **production**, criticalChance, criticalDamages, armor, precision, dodge, lootChance, management.
  Each `{level, value}`; `.level` = points invested.
- `mu.getById`→`{name, roles:{commanders[],managers[]}, members[]}`; `company.getById`→
  `{name, user(owner=employer)}`; `search.searchAnything` uses `searchText`, returns MULTIPLE
  userIds — never assume index 0.

## Gotchas / things NOT to redo
- **Redis cache TTL bug (FIXED this session, was severe):** `api/cache.js redisSet` put
  `[value,'EX',ttl]` in the request BODY so Upstash stored it as the value and NEVER expired —
  every cached field (dates, wealth) was frozen at first scan. Fixed: value in body, `?EX=` query
  param; cache key bumped **v1→v2**. If you see stale data, suspect cache again.
- **Referrer + username-change history: SHELVED, do NOT re-probe.** Both exist
  (`referral.getUserReferrals`, `actionLog.getPaginated`) but are **JWT-session-only** (API token
  → 403). User declined to supply a session JWT. See `warera-referrer-employer-api`.
- **SAME-MINT (account+own-company same-second): rejected** — universal in WarEra (every account is
  born with a starter company). Only account↔account timing is used.
- **warera-overwatch repo (TheGroxEmpire):** uses official `@wareraprojects/api` npm pkg.
  Its market-price-anomaly idea is **unworkable** here — item prices are clamped to a daily band, so
  trades can't deviate enough to launder. Nothing to port; we already do the structural patterns.
- **High-wealth provenance: user chose to SKIP** (inbound coins aren't a clean feed anyway).
- **Worker id ≠ user id (FIXED):** `worker.getWorkers` returns EMPLOYMENT documents — `w._id`
  is the employment record, the real account is `w.user`. `getUserLite` omits `_id`, so
  `resolvedUser` can't supply it. `uid` must come from `w.user` (stamped at fetch time as
  `w.uid`), NOT `w._id`, or links/map/matrix point at nonexistent users. Don't reintroduce
  `w._id`-first id resolution.

## Open threads / next steps
1. Threshold tuning against real scans: `COCREATE_WINDOW_S` (10s), `slowLevelerRatio` (0.5),
   wage/wealth cutoffs. Best driven by what the user sees.
2. The slow-leveler / coordinated-creation flags need their baselines/clusters populated — strongest
   after a Full-scan crawl + Local DB scan. On a fresh browser the first scan may miss them.
3. Logo: ensure it's at lowercase `public/logo.png` (Vercel is case-sensitive) — was flagged historically.
4. Otherwise user-driven — ask what's next.

## Good habits the user values
Concrete progress over discussion; verify against the live API/data rather than guessing (probe with
`curl` via the gateway); be honest about data limits (invisible coin sinks; clamped market prices;
JWT-gated data); flag deploy/staleness explicitly and verify the live bundle hash; surface findings
as leads, not verdicts; when a behaviour seems wrong, instrument/probe before assuming a fix.
