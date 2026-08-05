#!/usr/bin/env node
/**
 * revenue_scan.mjs — estimate WarEra's real-money revenue from the public rankings.
 *
 * READ-ONLY, NO API KEY. `ranking.getRanking` is unauthenticated on the official API,
 * so this needs no `wae_` key and no per-user scanning: the monetisation totals are
 * already aggregated server-side into three leaderboards.
 *
 *   userGemsPurchased  — lifetime gems bought per user (gems are the cash currency)
 *   userPremiumMonths  — lifetime premium months held per user
 *   userPremiumGifts   — lifetime premium subs gifted per user
 *
 * Why this is a CENSUS, not a top-N sample: the gem leaderboard's bronze tier floor is
 * 600 gems, which is exactly the smallest purchasable pack — so every single person who
 * has ever bought gems appears. The premium board runs down to 1 month. Nothing is
 * hidden below a cutoff, and the entry counts are non-round (1049 / 4083 / 542), which
 * is what you expect from a complete list rather than a truncated one.
 *
 * Gem totals are decomposed into whole store packs rather than divided by a blended
 * rate, because the packs have different bonus tiers (100.2 → 120.0 gems/EUR). Every
 * observed total decomposes exactly; most decompose uniquely. The residual ambiguity
 * is reported as a min/max band.
 *
 * Usage:
 *   node scripts/revenue_scan.mjs
 *   node scripts/revenue_scan.mjs --json
 *   node scripts/revenue_scan.mjs --vat 21 --fees 2.9
 *
 * Options:
 *   --vat N              consumer VAT % included in the shelf prices (default 0 = gross)
 *   --fees N             payment-processor % (default 0)
 *   --premium-via-gems   treat premium as bought WITH gems, so it is NOT added to the
 *                        total. Default is OFF: the store bills premium at EUR/month
 *                        separately from gems, so the two are additive.
 *   --json               machine-readable output
 */

const API = 'https://api2.warera.io/trpc/ranking.getRanking';

// Store prices, read from the in-game shop 2026-08-05. The displayed gem count already
// includes the advertised bonus (base rate is a flat 100 gems/EUR; the packs add
// +0/10/15/20%). Premium is a separate EUR/month subscription that can be gifted.
const PACKS = [[12000, 99.99], [5750, 49.99], [2200, 19.99], [600, 5.99]];
const PREMIUM_EUR_PER_MONTH = 5.99;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = 0) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? parseFloat(argv[i + 1]) : d; };
const VAT = opt('--vat'), FEES = opt('--fees');
const PREMIUM_VIA_GEMS = flag('--premium-via-gems'), AS_JSON = flag('--json');

const fetchRanking = async (type) => {
  const input = encodeURIComponent(JSON.stringify({ 0: { rankingType: type } }));
  const res = await fetch(`${API}?batch=1&input=${input}`);
  if (!res.ok) throw new Error(`${type}: HTTP ${res.status}`);
  const data = (await res.json())?.[0]?.result?.data;
  if (!data) throw new Error(`${type}: unexpected response shape`);
  return data;
};

// ObjectId's first 4 bytes are a unix timestamp — lets us date accounts for free.
const objIdMs = (id) => parseInt(String(id).slice(0, 8), 16) * 1000;
const sum = (items) => items.reduce((s, x) => s + (x.value || 0), 0);
const eur = (n) => '€' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });

// Cheapest / dearest whole-pack combination reaching exactly `n` gems.
const packCost = (() => {
  const memo = new Map();
  return function solve(n, mode) {
    if (n === 0) return 0;
    if (n < 0) return null;
    const k = mode + ':' + n;
    if (memo.has(k)) return memo.get(k);
    let best = null;
    for (const [g, e] of PACKS) {
      const r = solve(n - g, mode);
      if (r == null) continue;
      const c = r + e;
      if (best == null || (mode === 'min' ? c < best : c > best)) best = c;
    }
    memo.set(k, best);
    return best;
  };
})();

const main = async () => {
  const [gemsD, premD, giftD, popD] = await Promise.all(
    ['userGemsPurchased', 'userPremiumMonths', 'userPremiumGifts', 'countryActivePopulation'].map(fetchRanking));
  const gems = gemsD.items, prem = premD.items, gifts = giftD.items;

  const totalGems = sum(gems), totalMonths = sum(prem), totalGifts = sum(gifts);
  const activePop = sum(popD.items);
  const newest = Math.max(...[...gems, ...prem, ...gifts].map(x => objIdMs(x.user)));
  const oldest = Math.min(...[...gems, ...prem, ...gifts].map(x => objIdMs(x.user)));
  const ageMonths = (Date.now() - oldest) / (30.44 * 86400000);

  let gemMin = 0, gemMax = 0, unique = 0, undecodable = 0;
  for (const u of gems) {
    const lo = packCost(u.value, 'min'), hi = packCost(u.value, 'max');
    if (lo == null) { undecodable++; continue; }
    gemMin += lo; gemMax += hi;
    if (Math.abs(lo - hi) < 0.005) unique++;
  }
  const premRevenue = totalMonths * PREMIUM_EUR_PER_MONTH;
  const addPrem = PREMIUM_VIA_GEMS ? 0 : premRevenue;
  const net = (v) => v * (1 - VAT / 100) * (1 - FEES / 100);

  if (AS_JSON) {
    console.log(JSON.stringify({
      measuredAt: new Date().toISOString(), freshestAccount: new Date(newest).toISOString(),
      totalGems, totalMonths, totalGifts, activePop, gemBuyers: gems.length,
      premiumHolders: prem.length, gifters: gifts.length, tierValues: gemsD.tierValues,
      gemRevenueEur: { min: gemMin, max: gemMax, uniquelyDecomposed: unique, undecodable },
      premiumRevenueEur: premRevenue, premiumCountedInTotal: !PREMIUM_VIA_GEMS,
      totalEur: { min: gemMin + addPrem, max: gemMax + addPrem },
      netEur: { min: net(gemMin + addPrem), max: net(gemMax + addPrem) },
      assumptions: { PACKS, PREMIUM_EUR_PER_MONTH, VAT, FEES },
    }, null, 2));
    return;
  }

  const pct = (n) => (100 * n / activePop).toFixed(1) + '%';
  console.log(`\nWarEra monetisation — public rankings, read ${new Date().toISOString().slice(0, 16)}Z`);
  console.log('='.repeat(74));
  console.log(`Freshest account on a board : ${new Date(newest).toISOString().slice(0, 10)} (live)   Game age: ~${ageMonths.toFixed(1)} months`);
  console.log(`Active population           : ${activePop.toLocaleString()}`);
  console.log('');
  console.log(`Gems purchased  : ${totalGems.toLocaleString()} gems by ${gems.length.toLocaleString()} users (${pct(gems.length)} of active)`);
  console.log(`Premium months  : ${totalMonths.toLocaleString()} months by ${prem.length.toLocaleString()} users (${pct(prem.length)} of active)`);
  console.log(`Premium gifted  : ${totalGifts.toLocaleString()} subs by ${gifts.length.toLocaleString()} users`);
  console.log(`Pack decomposition: ${gems.length - undecodable}/${gems.length} exact, ${unique} of them unique`);
  console.log('');
  console.log(`GEM revenue     : ${eur(gemMin)} – ${eur(gemMax)}`);
  console.log(`PREMIUM revenue : ${eur(premRevenue)}${PREMIUM_VIA_GEMS ? '   [EXCLUDED — assumed bought with gems]' : ''}`);
  console.log(`TOTAL (gross)   : ${eur(gemMin + addPrem)} – ${eur(gemMax + addPrem)}`);
  if (VAT || FEES) console.log(`NET  (−${VAT}% VAT, −${FEES}% fees) : ${eur(net(gemMin + addPrem))} – ${eur(net(gemMax + addPrem))}`);
  console.log('');
  console.log('Notes: lifetime totals since launch, not a run-rate. Gifted premium already');
  console.log('sits in the recipient\'s premium-months (no user exceeds the game\'s age in');
  console.log('months), so gifts are redistribution, not extra revenue — do not add them.');
  console.log('Shelf prices are EU consumer prices, so VAT is included until you strip it.');
};

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
