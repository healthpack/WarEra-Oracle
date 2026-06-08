# Palantirish
**Multi-Account & Bot Net Detection for WarEra**

Palantirish is a web-based diagnostic tool that identifies multi-account networks, bot farms, and economic exploitation within the browser game [WarEra](https://app.warera.io). It load-balances between the WarEraStats community gateway and the official WarEra API, caching all stable data through an Upstash Redis layer on Vercel for 6-hour TTLs.

---

## Detection Heuristics

### Economic Network
- **Wash Trading** — Detects circular item trades (A→B→A) and triangle routes (A→B→C→A). Tracks net profit per ring, groups participants into visual network maps.
- **Money Laundering** — Flags workers who donate >25 coins in a single transaction or >60 coins/week to the boss's MU. Detects coordinated donation timing (multiple workers donating within 10 minutes of each other).
- **Direct Funnelling** — Flags the boss account itself if it makes large outbound donations.
- **Shell Companies** — Workers with >25% of their company portfolio in regions with no production bonuses.

### Automation Detection
- **Market Sniper** — Purchases made within a configurable ms window of an item being listed. Includes time-of-day concentration analysis.
- **Superhuman APM** — Multiple market listings within a sub-second window (impossible for humans).
- **Script Pacing** — Consecutive action sequences with identical delays (±tolerance ms). Uses streak-based detection — scattered coincidental matches do not qualify.

### Worker Pattern Analysis
- **Low Wage** — Workers paid at or below the suspicious wage threshold.
- **Naming Patterns** — Shared substrings ≥3 chars across worker usernames.
- **Cloned Progression** — Identical economic skill signatures within the same level band.
- **Wage Uniformity** — All high-fidelity workers (≥7/10) paid identical wages (std dev < 0.005).
- **Fidelity Ring** — Unusually high proportion of workers at max fidelity (10/10).

### Network Graph
- **Hermit Network** — >50% of market volume with a single partner, ≤3 unique partners lifetime.
- **Mutual Hermit Pair** — Two accounts that each trade almost exclusively with each other.

### Temporal & Age Analysis
- **Activity Window Lock** — 85%+ of actions concentrated in ≤4 UTC hours.
- **Newborn Wealthy** — Young accounts with disproportionate wealth vs. level peers (dynamic baseline built from scan data). Also flags high Automated Engine levels on new accounts.

## Supported by [warerastats.io](https://warerastats.io)
