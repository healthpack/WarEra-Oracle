# Palantirish — Session Handoff (for the next Opus session)

Read this first, then skim `src/WarEraOracle.tsx`. The two memory files
(`project_architecture`, `warera-api-auth`) auto-load and overlap with this.

## What the app is
**Palantirish** — a WarEra (browser game) multi-account / bot-net detection tool.
You scan a region (or a single user) and it flags suspicious accounts and shows
why, centred on a relationship map.

- Stack: React 18 + TypeScript + Vite + Tailwind. **One ~3,700-line component**
  `src/WarEraOracle.tsx` holds ~all UI + analysis. Serverless proxy `api/cache.js`
  (Upstash Redis cache + WarEra fetch). Icons: `lucide-react`.
- Deployed on **Vercel → palantirish.vercel.app**, auto-deploys from `main`.

## Working conventions
- **Verify with `npx vite build`** before committing (there's no test suite; build = the check).
- Commit + push to **`main`** (no PRs). Commit messages end with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Deploy race:** the auto-deploy can start the same minute as a push and miss it.
  If the user says "not updated", check the live bundle hash:
  `curl -s https://palantirish.vercel.app/ | grep -oE 'index-[a-z0-9]+\.js'` vs the
  hash your local `vite build` printed. An empty commit forces a fresh deploy.
- **Styling:** inline hex in the **Cobalt** palette (bg `#070b18`, panel `#0c1226`,
  elev `#121b35`/`#1b2748`, line `#1f2b4e`/`#2e3f6a`, tx `#eaf0ff`/`#9fb0d4`/`#5d6e96`,
  link `#4fc3e8`, crit `#ff5d6c`, high `#ffab3d`, med `#ffd84d`). Tokens also in
  `tailwind.config.js` + `index.html`. Mono font for IDs/usernames/numbers.
- **API key:** the user actively pastes a real `wae_` key (Sven's). It's fine to use
  for read-only API probing during dev (the warerastats gateway tolerates any key via
  its own session; authenticated endpoints want the real key as `X-API-Key`). Advise
  rotation; never hardcode it.

## Architecture
- **Two-phase scan** (in `processPlayerPhase1` / `processPlayerPhase2`):
  - Phase 1 runs for every user (transaction-derived): wash trading, sniper/APM/pacing,
    hermit, direct-launderer, tip farming, wealth anomaly, **coin funnel** →
    `analyzePhase1`. Stores a result; auto-triggers phase 2 if score ≥ threshold.
  - Phase 2 (flagged users): companies + `worker.getWorkers` + worker profiles →
    `analyzePlayer` (full). Replaces the phase-1 result.
- **Heuristic registry** = the single source of truth. Module-level `HEURISTICS`
  object: `{ type: { tier, matrixChip, detail:{observed,rule,note} } }`. `CRIT_TYPES`,
  `HIGH_TYPES`, `MATRIX_LINK_LABEL`, `FINDING_DETAIL` are all **derived** from it.
  **To add a heuristic:** write a `detect*` (or compute in phase 1), push a
  `{type,severity,desc,workers,detectionWeight,...}` suspicion, call it from
  `analyzePhase1`/`analyzePlayer`, add **one** `HEURISTICS` entry. (Sort-order arrays
  and `buildShortSummary` are still per-type and may also need a line.)
- **Concept G UI** (the results view): left **case list** → center **relationship map**
  (`ClusterMap`: interactive drag/zoom/hover, **boss pinned at TOP** with children
  fanned below, **rainbow stacked edges** when multiple links share a node pair, edge
  endpoints inset so lines don't cross box text) + **`MapSidebar`** (LEFT of the map:
  identity, verdict, summary, Report/Watch/Rescan/Copy, Signal Ledger) +
  **`LinkedAccountMatrix`** + **`EngagementNetwork`**; the detailed findings timeline
  is below as the deep-dive.
- **Map graph** comes from `buildClusterGraph(activeResult, globalCache)`: node kinds
  `worker` (dashed employ spoke), `partner` (wash), `funnel` (coin sink: MU/country/user),
  `muLeader` (MU commander/manager); edge types `name`/`clone`/`wash`/`funnel`/`role`.
  `buildMatrixModel(suspicions, globalCache)` feeds the matrix + per-account wealth ratio.

## Key API facts (all verified this session)
- **Auth:** the `wae_` key as `X-API-Key` authenticates **every** endpoint used, on
  BOTH the gateway and the official API. No JWT/cookie needed (an earlier rabbit hole).
  Routing is plain gateway-first / official-fallback for everything — no special-casing.
- **getUserLite:** wealth/level live under `rankings.userWealth.value` /
  `rankings.userLevel.value` (NOT top level). **Ban** is `infos.isBanned: true`
  (+ `isActive:false`); there is no top-level `isBanned`.
- **Donation tx:** sender = `buyerId`, recipient = `sellerMuId` (military unit) OR
  `sellerCountryId` (country), amount = `money`. **Tip tx:** sender `buyerId`,
  recipient `sellerId` (the article author, a user), amount `money`.
- **`mu.getById`** → `{ name, roles:{commanders[],managers[]}, members[] }`.
  **`country.getCountryById`** → `{ name }`. **`search.searchAnything`** →
  `{ userIds[], muIds[], countryIds[], ... }` (returns multiple — don't assume index 0).

## What was built this session (most recent first)
- **`coordinated_creation` heuristic.** A MongoDB ObjectId embeds creation time in its
  first 4 bytes (unix seconds) — `objIdSeconds(id)` reads an account's signup time with no
  fetch (verified exact vs `createdAt`). `detectCoordinatedCreation` flags any account
  already linked to the scanned one (worker / wash partner / employer) that was created
  **within 10s** of it — scripted batch signup; two linked humans don't register the same
  second. Scored (tier high, weight 2×hits), shown in the Signal Ledger + deep-dive, and a
  yellow **⏱+Ns** badge on the co-created map nodes. Excluded from the matrix so partner/
  employer accounts don't become phantom worker rows. **The earlier SAME-MINT badge was
  removed** — account↔own-company same-second is universal in WarEra (every account is
  born with a starter company), so only account↔account timing is compared.
- **Eutectic feature, piece 2 — employer edge.** When a flagged account is scanned in
  phase 2, resolve its current employer (`user.getUserById.company` →
  `company.getById.user` = owner) and draw it as a teal **EMPLOYER** node with an
  `EMPLOYS` edge (the live inverse of the boss→worker spokes). If the owner is already on
  the map the edge just stacks (rainbow). Also **MU leaders are now gated**: a sink's
  commander/manager is only drawn when independently linked to the scanned account (already
  a node — wash partner / alt / tip recipient / employer), instead of the whole MU roster.
  **Referrer was dropped: it is not
  in the API** — no `referral.*` procedure, no referred-by field (only the outbound
  `rankings.userReferrals` count). See `warera-referrer-employer-api` memory.
- **Eutectic feature, piece 1** (`cf859a1`): for flagged outflow accounts, resolve each
  MU coin-sink's leadership (`roles.commanders`+`managers`, capped 5) and draw them as
  **MU COMMANDER/MANAGER** nodes off the MU node (purple `role` edges). So "the MU you
  drained to is run by another flagged account (Eutectic)" is visible.
- **Ban detection** (`507123b`): read `infos.isBanned`; **keep** banned accounts (don't
  clear them) and **badge** them in the list + sidebar; `globalBans` cross-ref fallback.
  Also: edge endpoint inset (no text overlap), opaque boss box.
- **Map polish** (`5a6d4ad`): boss-at-top layout, rainbow edge stacking, MU/country sink
  floor ≥200 coins (tips ≥25/user), watchlist-scan ignores the User ID field.
- **coin_funnel heuristic** (`2a27c44`, `03554af`, `688dae1`): low wealth + large total
  outflow → flags; draws every donation/tip sink with amounts + names; money_laundering
  also draws sinks; findings show a coins-out breakdown (total / via donations / via tips
  / now holds + per-destination list).
- **Heuristic registry refactor** (`7a70ae7`). **Concept G redesign** fully integrated
  (map + matrix + sidebar + engagement, replacing the old tree/right-rail).

## Open threads / next steps
1. **Eutectic direct edges — DONE / partially N/A.** Employer edge built (above).
   Referrer is **not exposed by the API** so it can't be drawn — don't re-probe.
   Note the employer is only the account's *current* company owner; past bosses (the
   stale Eutectic→Alexo link) won't appear. The `same_mint` (account+company) idea was
   tried and **rejected as universal** (starter companies); the useful version —
   account↔account same-second creation — shipped as `coordinated_creation`. Possible
   extension: check ALL pairs in a cluster, not just boss-vs-linked (catches two alts
   co-created but not with the boss). Threshold currently 10s (`COCREATE_WINDOW_S`).
2. **Ban coverage:** only catches a ban if `getUserLite.infos.isBanned` is present or the
   account appeared as someone's wash partner (`globalBans`). A flagged account banned
   but never cross-referenced could still be missed — fine for now, just know it.
3. **Logo not showing:** the user committed the icon at **`Public/logo.png`** (capital P).
   Vercel is case-sensitive — it must be **`public/logo.png`** (lowercase) to serve at
   `/logo.png`. Tell them to rename the folder.
4. **High-wealth provenance** (the inverse of coin_funnel): inbound concentration — what
   share of a high-wealth account's coins came from transfers IN from a few accounts.
   Discussed, not built.
5. Threshold tuning against real scans (funnelMinCoins, wealth bounds, etc.).

## Good habits the user values
Concrete progress over discussion; verify against the live API rather than guessing;
be honest about data limits (e.g. invisible coin sinks: equipment/consumables/training);
flag deploy/staleness explicitly; surface findings as leads, not verdicts.
