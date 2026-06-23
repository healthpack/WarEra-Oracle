import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  ShieldAlert, Play, Square, Activity, ChevronRight, 
  ChevronDown, AlertTriangle, Users, Database, UserX, 
  ExternalLink, Settings, Search, Star, Trash2, Coins,
  Target, Zap, Network, Clock, Download, Filter,
  RefreshCw, Info, Baby, Moon, Heart, Timer, CheckSquare, Bookmark
} from 'lucide-react';

// ─────────────────────────────────────────────
//  API LAYER
// ─────────────────────────────────────────────
const WarEraAPI = {
  fetch: async (endpoint, payload, activeKey, baseUrl) => {
    const isGateway = baseUrl.includes('gateway');
    const url = `${baseUrl}${endpoint}`;
    const headers = { 'Content-Type': 'application/json' };
    // X-API-Key only. An Authorization: Bearer header here confuses the gateway's own
    // session injection (and the official API wants a JWT cookie, not a Bearer key).
    if (activeKey && activeKey.trim() !== '') headers['X-API-Key'] = activeKey.trim();
    let res;
    try {
      const ctrl = new AbortController();
      const tId = setTimeout(() => ctrl.abort(), 15000); // 15s timeout to prevent thread hanging
      if (isGateway) {
        res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
      } else {
        const input = encodeURIComponent(JSON.stringify({ "0": payload }));
        res = await fetch(`${url}?batch=1&input=${input}`, { headers, signal: ctrl.signal });
      }
      clearTimeout(tId);
    } catch (e) { throw new Error(e.name === 'AbortError' ? `Request timed out: ${endpoint}` : `Network Error: ${e.message}`); }
    const text = await res.text();
    if (res.status === 429 || text.includes('Rate limit exceeded') || text.includes('"status":429')) throw new Error("RATE LIMIT TRIGGERED");
    if (!res.ok) {
      let errorMessage = `HTTP ${res.status}`;
      try {
        const parsedError = JSON.parse(text);
        const errObj = Array.isArray(parsedError) ? parsedError[0] : parsedError;
        if (errObj?.error?.message) errorMessage = errObj.error.message;
        if (errObj?.error) errorMessage = JSON.stringify(errObj.error);
      } catch(e) {
        if (text.toLowerCase().includes('unknown method')) throw new Error(`Unsupported Gateway Route: ${text}`);
        throw new Error(`HTML response received. Snippet: ${text.substring(0, 50)}...`);
      }
      throw new Error(`http ${res.status}: ${errorMessage}`);
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error(`Failed to parse JSON. Snippet: ${text.substring(0, 50)}...`); }
    const resultObj = Array.isArray(data) ? data[0] : data;
    if (resultObj?.error) throw new Error(resultObj.error.message || JSON.stringify(resultObj.error));
    return resultObj?.result?.data?.json || resultObj?.result?.data || resultObj;
  }
};

// ─────────────────────────────────────────────
//  BASELINE TRACKING (Passes through globalCache)
// ─────────────────────────────────────────────
// Per-level coin wealth baseline, keyed by userId (`byUser`). Keying by user means
// re-scanning the same player UPDATES their wealth in place (latest-wins) instead of
// appending duplicate samples — so repeatedly scanning the same small country can't
// poison the median, and stale wealth refreshes itself. We keep a median per level
// (robust to ultra-rich outliers) and cap distinct users per level to bound memory.
const USER_CAP = 500; // distinct users per level; bounds the Redis baseline payload
const recordWealthBaseline = (globalCache, level, wealth, userId) => {
  if (level == null || wealth == null || isNaN(wealth)) return;
  const key = String(Math.round(level));
  if (!globalCache.wealthByLevel) globalCache.wealthByLevel = {};
  let e = globalCache.wealthByLevel[key];
  if (!e || typeof e !== 'object') e = globalCache.wealthByLevel[key] = {};
  if (!e.byUser || typeof e.byUser !== 'object') e.byUser = {};
  // Without a userId we can't dedupe, so bucket anonymously but still record.
  const uk = userId || `anon:${Object.keys(e.byUser).length}`;
  const isNew = !(uk in e.byUser);
  e.byUser[uk] = wealth; // latest-wins
  if (isNew) {
    // Evict the oldest distinct user once over the cap. Hex userId / "anon:" keys are
    // non-integer strings, so Object.keys preserves insertion order.
    const keys = Object.keys(e.byUser);
    if (keys.length > USER_CAP) delete e.byUser[keys[0]];
  }
};

// Reconstruct a samples array from a legacy entry (mean-only {avg,count} or the older
// anonymous {samples:[]}) so pre-byUser baselines still contribute until users refill.
const legacySamples = (e) => Array.isArray(e?.samples) ? e.samples : (e && typeof e.avg === 'number' ? [e.avg] : []);

const median = (arr) => {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Distinct contributors backing a level's median (used for diagnostics / radius).
const levelSampleCount = (e) => {
  if (!e) return 0;
  if (e.byUser && typeof e.byUser === 'object') return Object.keys(e.byUser).length;
  return legacySamples(e).length;
};

// Median wealth for a single level. Prefers the deduped per-user values; falls back to
// legacy anonymous samples until enough per-user data has accumulated.
const getLevelMedian = (globalCache, level) => {
  const e = globalCache.wealthByLevel?.[String(level)];
  if (!e) return null;
  if (e.byUser && typeof e.byUser === 'object') {
    const vals = Object.values(e.byUser).filter(v => typeof v === 'number' && !isNaN(v));
    if (vals.length) return median(vals);
  }
  return median(legacySamples(e));
};

// Baseline = the AVERAGE of the surrounding per-level medians. We try the immediate
// ±1 band first and widen the radius only when no nearby level has data, so sparse
// levels borrow from their neighbours instead of returning nothing.
const getWealthAverageExtended = (globalCache, level) => {
  if (level == null) return null;
  if (!globalCache.wealthByLevel) return null;
  const lvl = Math.round(level);
  for (const radius of [1, 5, 10, 25, 50, 100, 250]) {
    const medians = [];
    let totalCount = 0;
    for (let l = lvl - radius; l <= lvl + radius; l++) {
      const m = getLevelMedian(globalCache, l);
      if (m != null) {
        medians.push(m);
        totalCount += levelSampleCount(globalCache.wealthByLevel[String(l)]);
      }
    }
    if (medians.length > 0) {
      const avg = medians.reduce((a, b) => a + b, 0) / medians.length;
      return { avg, radius, totalCount, levelsUsed: medians.length };
    }
  }
  return null;
};

// Pull coin wealth / level out of a user profile, tolerant of where the API puts
// them. getUserLite has been observed to omit userWealth, so we probe several
// candidate paths rather than assuming a single field.
const firstNumber = (...cands) => {
  for (const c of cands) {
    const n = (c && typeof c === 'object' && 'value' in c) ? c.value : c;
    if (typeof n === 'number' && !isNaN(n)) return n;
  }
  return null;
};
// Wealth and level live under `rankings` in getUserLite (e.g.
// rankings.userWealth = { value, rank, tier }); older code expected them at the
// top level, so we check both.
const extractCoinWealth = (u) => u ? firstNumber(u.rankings?.userWealth, u.userWealth, u.wealth, u.money, u.coins, u.balance) : null;
// Game level is 1-50. Prefer the canonical leveling.level, then rankings.userLevel.
// Reject anything out of range so a stray numeric field (e.g. an embedded worker's
// XP-like value of 5400) can't create a garbage level bucket that poisons the median.
const extractUserLevel = (u) => {
  if (!u) return null;
  const lvl = firstNumber(u.leveling?.level, u.rankings?.userLevel, u.userLevel, u.level);
  return (lvl != null && lvl >= 1 && lvl <= 60) ? lvl : null;
};

// Low-level accounts (< 11) have small, volatile wealth, so require a much higher bar
// — 4x the level median (400%) — before flagging, to suppress sub-level-11 noise.
const LOW_LEVEL_WEALTH_MULTIPLIER = 4;
const effectiveWealthMultiplier = (level, baseMultiplier) =>
  (level != null && level < 11) ? Math.max(LOW_LEVEL_WEALTH_MULTIPLIER, baseMultiplier) : baseMultiplier;

// ─────────────────────────────────────────────
//  DETECTION MODULES
// ─────────────────────────────────────────────

const detectAutomation = (player, settings) => {
  const suspicions = [];

  if (player.sniperHits >= 5) {
    const hourCounts = {};
    (player.sniperDetails || []).forEach(s => {
      const h = new Date(s.offerTimeMs + s.timeMs).getUTCHours();
      hourCounts[h] = (hourCounts[h] || 0) + 1;
    });
    const maxHour = Object.entries(hourCounts).sort((a,b)=>b[1]-a[1])[0];
    const concentrationNote = maxHour && maxHour[1] >= Math.ceil(player.sniperHits * 0.6)
      ? ` All ${maxHour[1]} snipes concentrated in UTC hour ${maxHour[0]}:00 - a concentration consistent with automated scheduling.`
      : '';
    suspicions.push({
      type: 'market_automation', severity: 'critical',
      desc: `Market Sniper: Account purchased ${player.sniperHits} items within ${settings.sniperThresholdMs}ms of listing.${concentrationNote}`,
      workers: [{ uid: player.id, normalizedName: player.name + " (SELF)", normalizedLevel: player.level || '?' }],
      detectionWeight: player.sniperHits, sniperDetails: player.sniperDetails
    });
  }

  if (player.maxConcurrentTxs >= 5) {
    suspicions.push({
      type: 'superhuman_apm', severity: 'critical',
      desc: `API Automation: Account listed ${player.maxConcurrentTxs} items within a ${settings.apmWindowMs}ms window.`,
      workers: [{ uid: player.id, normalizedName: player.name + " (SELF)", normalizedLevel: player.level || '?' }],
      detectionWeight: player.maxConcurrentTxs, apmDetails: player.apmDetails
    });
  }

  if (player.pacingHits >= settings.pacingMinHits) {
    const singleTypePacing = player.pacingSingleType
      ? ` All paced actions are of type "${player.pacingSingleType}" - single-action-type pacing of this regularity is hard to explain as manual play.`
      : '';
    suspicions.push({
      type: 'script_pacing', severity: 'critical',
      desc: `Script Pacing: ${player.pacingHits} actions with identical delay of ~${player.pacingAvgMs}ms (±${settings.pacingToleranceMs}ms).${singleTypePacing}`,
      workers: [{ uid: player.id, normalizedName: player.name + " (SELF)", normalizedLevel: player.level || '?' }],
      detectionWeight: player.pacingHits,
      pacingDetails: { avgGapMs: player.pacingAvgMs, hits: player.pacingHits, edges: player.pacingEdges }
    });
  }

  if (player.isHermit) {
    suspicions.push({
      type: 'hermit_network', severity: 'high',
      desc: `Network Centrality: ${player.centralityPercentage.toFixed(1)}% of all trade volume is with a single partner across ${player.hermitTxCount} transactions. Only ${player.uniqueTradingPartnersSize} unique partner(s) over lifetime.${player.hermitResaleDetails}`,
      workers: [{ uid: player.id, normalizedName: player.name + " (HERMIT NODE)", normalizedLevel: player.level || '?' }],
      detectionWeight: player.hermitTxCount
    });
  }

  if (player.isMutualHermit) {
    suspicions.push({
      type: 'mutual_hermit', severity: 'critical',
      desc: `Mutual Hermit Pair: This account and "${player.mutualHermitPartnerName}" trade almost exclusively with each other (bidirectional isolation) — a pattern consistent with a single operator running both.`,
      workers: [{ uid: player.id, normalizedName: player.name + " (SELF)", normalizedLevel: player.level || '?' }],
      detectionWeight: player.hermitTxCount || 5
    });
  }

  return suspicions;
};

const detectEconomicNetwork = (player, allWorkers, settings, globalCache) => {
  const suspicions = [];
  let totalCoinsWashed = 0;
  const washPartners = player.washPartners || {};
  
  if (Object.keys(washPartners).length > 0) {
    const partnerList = Object.entries(washPartners)
      .map(([id, data]) => {
        const isWorker = allWorkers.some(w => w.uid === id);
        return { id, isWorker, ...data };
      })
      .filter(p => Math.abs(p.netProfit !== 0 ? p.netProfit : p.volume) >= 1);
      
    if (partnerList.length > 0) {
      const workersInvolved = partnerList.filter(p => p.isWorker);
      const othersInvolved = partnerList.filter(p => !p.isWorker);
      let detectionWeight = 0;
      let descParts = [];
      if (workersInvolved.length > 0) { detectionWeight += workersInvolved.length * 2; descParts.push(`${workersInvolved.length} Workers (2x Penalty)`); }
      if (othersInvolved.length > 0) { detectionWeight += othersInvolved.length * 1; descParts.push(`${othersInvolved.length} Outside Users`); }
      partnerList.forEach(p => totalCoinsWashed += Math.abs(p.netProfit !== 0 ? p.netProfit : p.volume));

      let bossNetProfit = 0;
      partnerList.forEach(p => bossNetProfit += (p.netProfit || 0));
      const isNetZero = Math.abs(bossNetProfit) < 0.01;

      suspicions.push({
        type: 'transaction_abuse', severity: isNetZero ? 'high' : 'critical',
        desc: `Item Market Wash Trading detected with ${descParts.join(' and ')}.${isNetZero ? ' Net profit is zero - possible technique testing or practice ring.' : ''}`,
        partners: partnerList, detectionWeight: isNetZero ? Math.max(1, Math.floor(detectionWeight * 0.5)) : detectionWeight
      });
    }
  }

  return { suspicions, totalCoinsWashed };
};

const detectWorkerPatterns = (allWorkers, settings, globalCache) => {
  const suspicions = [];
  const suspiciousWorkers = new Set();

  const lowWageWorkers = allWorkers.filter(w => w.normalizedWage <= settings.suspiciousWageThreshold);
  if (lowWageWorkers.length >= 2) {
    suspicions.push({
      type: 'low_wage', severity: lowWageWorkers.length > 4 ? 'high' : 'medium',
      desc: `Found ${lowWageWorkers.length} workers with wages <= ${settings.suspiciousWageThreshold}`,
      workers: lowWageWorkers
    });
    lowWageWorkers.forEach(w => suspiciousWorkers.add(w));
  }

  const overlappingGroups = {};
  allWorkers.forEach(w1 => {
    allWorkers.forEach(w2 => {
      if (w1.uid === w2.uid) return;
      let n1 = String(w1.normalizedName).toLowerCase();
      let n2 = String(w2.normalizedName).toLowerCase();
      if (n1.startsWith('user_')) n1 = n1.substring(5);
      if (n2.startsWith('user_')) n2 = n2.substring(5);
      for (let len = n1.length; len >= 3; len--) {
        for (let i = 0; i <= n1.length - len; i++) {
          const sub = n1.substring(i, i + len).trim();
          if (sub.length < 3 || sub.includes(' ') || /^\d+$/.test(sub)) continue;
          if (n2.includes(sub)) {
            if (!overlappingGroups[sub]) overlappingGroups[sub] = new Set();
            overlappingGroups[sub].add(w1); overlappingGroups[sub].add(w2);
          }
        }
      }
    });
  });
  
  const processedNamingUids = new Set();
  Object.keys(overlappingGroups).sort((a,b) => b.length - a.length).forEach(sub => {
    const groupWorkers = Array.from(overlappingGroups[sub]);
    const unflagged = groupWorkers.filter(w => !processedNamingUids.has(w.uid));
    if (unflagged.length >= 2) {
      suspicions.push({ type: 'naming_pattern', severity: 'high', desc: `Naming overlap: ${unflagged.length} workers share "${sub}"`, workers: unflagged, overlapString: sub });
      unflagged.forEach(w => { suspiciousWorkers.add(w); processedNamingUids.add(w.uid); });
    }
  });

  const buildClusters = {};
  allWorkers.forEach(w => {
    if (w.normalizedBuild === 'NO_DATA' || w.normalizedBuild === 'DEFAULT_ECO') return;
    const levelBand = Math.floor(w.normalizedLevel / 10) * 10;
    const key = `${w.normalizedBuild}_${levelBand}`;
    if (!buildClusters[key]) buildClusters[key] = [];
    buildClusters[key].push(w);
  });
  
  Object.entries(buildClusters).forEach(([key, group]) => {
    const buildSignature = key.split('_')[0];
    const band = key.split('_')[1];
    if (group.length >= 2) {
      suspicions.push({ type: 'cloned_progression', severity: 'medium', desc: `${group.length} workers with identical skill signatures [${buildSignature}] in level band ${band}+`, workers: group });
      group.forEach(w => suspiciousWorkers.add(w));
    }
  });

  const highFidelityWorkers = allWorkers.filter(w => w.isActive !== false && w.normalizedFidelity >= 7 && w.normalizedWage > settings.suspiciousWageThreshold && w.normalizedWage < 0.128);
  const activeWages = highFidelityWorkers.map(w => w.normalizedWage);
  if (activeWages.length >= 4) {
    const mean = activeWages.reduce((a,b) => a+b, 0) / activeWages.length;
    const variance = activeWages.reduce((a,b) => a + Math.pow(b - mean, 2), 0) / activeWages.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev < 0.005) {
      suspicions.push({
        type: 'wage_uniformity', severity: 'high',
        desc: `Wage Uniformity: All ${activeWages.length} high-fidelity workers (>=7/10) paid identical wages of ${mean.toFixed(3)} coins (std dev: ${stdDev.toFixed(4)}). Perfectly identical wages across all long-term workers may indicate a single operator managing alts.`,
        workers: highFidelityWorkers,
        detectionWeight: activeWages.length
      });
    }
  }

  const maxFidelityWorkers = allWorkers.filter(w => w.normalizedFidelity === 10 && w.isActive !== false && w.normalizedWage < 0.128);
  const totalActiveWorkers = allWorkers.filter(w => w.isActive !== false).length;
  if (maxFidelityWorkers.length >= 4) {
    const fidelityPct = totalActiveWorkers > 0 ? Math.round((maxFidelityWorkers.length / totalActiveWorkers) * 100) : 100;
    suspicions.push({
      type: 'fidelity_ring', severity: 'medium',
      desc: `Fidelity Ring: ${maxFidelityWorkers.length}/${totalActiveWorkers} active workers (${fidelityPct}%) have max fidelity (10/10) — an unusually loyal workforce that can be consistent with controlled alt accounts.`,
      workers: maxFidelityWorkers, detectionWeight: maxFidelityWorkers.length
    });
    maxFidelityWorkers.forEach(w => suspiciousWorkers.add(w));
  }

  return { suspicions, suspiciousWorkers };
};

const detectLaundering = (allWorkers, player, settings, globalCache) => {
  const suspicions = [];
  const suspiciousWorkers = new Set();
  let hasLaundering = false;
  let launderingWorkerCount = 0;
  let totalLaunderedCoins = 0;

  const launderingWorkers = [];
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  allWorkers.forEach(w => {
    if (w.normalizedLevel >= 22) return;
    if (!w.muDonations || w.muDonations.length === 0) return;
    let totalDonatedWeekly = 0, largeDonations30Days = 0, totalDonatedAllTime = 0, maxSingleDonation = 0;
    const donationTimes = [];
    w.muDonations.forEach(tx => {
      const txTime = new Date(tx.createdAt || tx.timestamp || tx.date || Date.now()).getTime();
      if (txTime < thirtyDaysAgo) return;
      let amount = tx.amount ?? tx.quantity ?? tx.value ?? tx.gold ?? tx.money ?? tx.total;
      if (typeof amount === 'object' && amount !== null) amount = amount.amount ?? amount.value ?? amount.quantity ?? amount.gold ?? 0;
      if (typeof amount !== 'number') amount = parseFloat(amount) || 0;
      if (amount === 0) { const pv = Object.values(tx).filter(v => typeof v === 'number' && v < 1e12 && v > 0); if (pv.length > 0) amount = Math.max(...pv); }
      maxSingleDonation = Math.max(maxSingleDonation, amount);
      totalDonatedAllTime += amount;
      if (Math.abs(amount - 5) > 0.01 && Math.abs(amount - 25) > 0.01) largeDonations30Days += amount;
      if (txTime >= oneWeekAgo) totalDonatedWeekly += amount;
      if (Math.abs(amount - 5) > 0.01 && Math.abs(amount - 25) > 0.01) donationTimes.push(txTime);
    });
    w.totalDonatedWeekly = totalDonatedWeekly;
    w.largeDonations30Days = largeDonations30Days;
    w.totalDonatedAllTime = totalDonatedAllTime;
    w.maxDonation = maxSingleDonation;
    w.isLaundering = w.maxDonation > 25 || w.totalDonatedWeekly > 60;
    w.donationTimes = donationTimes;
    if (w.isLaundering) launderingWorkers.push(w);
  });

  if (launderingWorkers.length >= 2) {
    const windowMs = 10 * 60 * 1000;
    const correlatedGroups = [];
    for (let i = 0; i < launderingWorkers.length; i++) {
      for (let j = i+1; j < launderingWorkers.length; j++) {
        const times1 = launderingWorkers[i].donationTimes || [];
        const times2 = launderingWorkers[j].donationTimes || [];
        let overlap = false;
        for (const t1 of times1) {
          for (const t2 of times2) {
            if (Math.abs(t1 - t2) <= windowMs) { overlap = true; break; }
          }
          if (overlap) break;
        }
        if (overlap) {
          const existing = correlatedGroups.find(g => g.includes(launderingWorkers[i]) && g.includes(launderingWorkers[j]));
          if (!existing) correlatedGroups.push([launderingWorkers[i], launderingWorkers[j]]);
        }
      }
    }
    if (correlatedGroups.length > 0) {
      const correlatedWorkers = [...new Set(correlatedGroups.flat())];
      suspicions.push({
        type: 'coordinated_donation', severity: 'critical',
        desc: `Coordinated Donation Timing: ${correlatedWorkers.length} workers made large MU donations within 10 minutes of each other. This timing correlation suggests orchestrated transfers by a single operator.`,
        workers: correlatedWorkers, detectionWeight: correlatedWorkers.length * 2
      });
      correlatedWorkers.forEach(w => suspiciousWorkers.add(w));
    }
  }

  if (launderingWorkers.length > 0) {
    totalLaunderedCoins = launderingWorkers.reduce((sum, w) => sum + (w.largeDonations30Days || w.totalDonatedAllTime || 0), 0);
    suspicions.push({
      type: 'money_laundering', severity: 'critical',
      desc: `Money sent to Boss's MU via large donations (>25 Coins single or >60 Coins total/week) in the past 30 days.`,
      workers: launderingWorkers, detectionWeight: launderingWorkers.length
    });
    launderingWorkers.forEach(w => suspiciousWorkers.add(w));
    hasLaundering = true;
    launderingWorkerCount = launderingWorkers.length;
  }

  if (player.isDirectLaunderer) {
    const selfWorker = {
      uid: player.id, normalizedName: player.name + " (SELF)", normalizedLevel: player.level || '?',
      isBanned: player.isBanned, largeDonations30Days: player.directLaunderAmount,
      totalDonatedAllTime: player.directLaunderAmount, isLaundering: true, noBonusPercentage: 0
    };
    let existingLaunderSus = suspicions.find(s => s.type === 'money_laundering');
    if (existingLaunderSus) { existingLaunderSus.workers.push(selfWorker); existingLaunderSus.detectionWeight += 3; }
    else {
      suspicions.push({ type: 'money_laundering', severity: 'critical', desc: `Large outbound donations from this account — a pattern consistent with a burner funnel.`, workers: [selfWorker], detectionWeight: 3 });
    }
    totalLaunderedCoins += player.directLaunderAmount;
    hasLaundering = true;
    launderingWorkerCount += 1;
  }

  return { suspicions, suspiciousWorkers, hasLaundering, launderingWorkerCount, totalLaunderedCoins };
};

const detectShellCompanies = (allWorkers, settings, globalCache) => {
  const suspicions = [];
  const suspiciousWorkers = new Set();
  let zeroBonusCompanyCount = 0;
  let bossNoBonusPercentage = 0;
  const shellCompanyWorkers = [];
  const allNoBonusWorkers = [];
  let totalWorkerCompanyCount = 0;

  allWorkers.forEach(w => {
    w.noBonusOwnedCompanies = [];
    if (!w.ownedCompanies || w.ownedCompanies.length === 0) return;
    if (w.isActive === false || w.normalizedLevel >= 30 || w.normalizedLevel < 5) return;
    w.ownedCompanies.forEach(comp => {
      const itemCode = typeof comp.itemCode === 'object' ? comp.itemCode?._id || comp.itemCode?.code : comp.itemCode;
      const regionId = typeof comp.region === 'object' ? comp.region?._id : comp.region;
      if (!itemCode || !regionId) return;
      const regionObj = globalCache.regions[regionId];
      if (!regionObj) return;
      let hasTimedDeposit = false;
      if (regionObj.bonuses && Array.isArray(regionObj.bonuses)) {
        hasTimedDeposit = regionObj.bonuses.some(b => { const bCode = typeof b.item === 'object' ? b.item?._id || b.item?.code : b.item; return String(bCode).toLowerCase() === String(itemCode).toLowerCase(); });
      }
      if (hasTimedDeposit) return;
      const countryId = typeof regionObj.country === 'object' ? regionObj.country?._id : (regionObj.country || regionObj.countryId);
      const countryObj = globalCache.countries[countryId];
      if (!countryObj || !countryObj.specializedItem) return;
      const specialized = String(typeof countryObj.specializedItem === 'object' ? countryObj.specializedItem.code || countryObj.specializedItem._id : countryObj.specializedItem).toLowerCase();
      const produced = String(itemCode).toLowerCase();
      if (specialized !== produced && specialized !== 'undefined' && produced !== 'undefined') w.noBonusOwnedCompanies.push(comp);
    });
    if (w.noBonusOwnedCompanies.length > 0) {
      w.noBonusPercentage = Math.round((w.noBonusOwnedCompanies.length / w.ownedCompanies.length) * 100);
      w.noBonusCount = w.noBonusOwnedCompanies.length;
      w.totalOwnedCount = w.ownedCompanies.length;
      zeroBonusCompanyCount += w.noBonusOwnedCompanies.length;
      totalWorkerCompanyCount += w.ownedCompanies.length;
      allNoBonusWorkers.push(w);
      if (w.noBonusPercentage > 25) shellCompanyWorkers.push(w);
    }
  });

  if (totalWorkerCompanyCount > 0) bossNoBonusPercentage = Math.round((zeroBonusCompanyCount / totalWorkerCompanyCount) * 100);
  const isOnlyNoProd = suspicions.length === 0 && shellCompanyWorkers.length > 0;
  let shouldFlagNoProd = true;
  if (isOnlyNoProd) {
    const severeShells = shellCompanyWorkers.filter(w => w.noBonusPercentage >= 50);
    if (severeShells.length < 2 || bossNoBonusPercentage < 50) shouldFlagNoProd = false;
  }
  if (shellCompanyWorkers.length > 0 && shouldFlagNoProd) {
    suspicions.push({ type: 'no_production_bonus', severity: 'high', desc: `${shellCompanyWorkers.length} workers (Level 5+) where >25% of portfolio are NO production bonus companies.`, workers: allNoBonusWorkers, detectionWeight: shellCompanyWorkers.length });
    allNoBonusWorkers.forEach(w => suspiciousWorkers.add(w));
  }

  return { suspicions, suspiciousWorkers, zeroBonusCompanyCount, bossNoBonusPercentage };
};

// Flags accounts whose coin wealth is disproportionately high for their level,
// regardless of account age (account age is recorded as context only). Uses the
// shared extractors so the flag agrees with the per-user wealth log.
// Returns { anomalous, reason } if coin wealth is above the (level-adjusted) high bound
// or below the low bound. Low-wealth is only judged at level >= 11, where wealth is
// stable enough to be meaningful (sub-11 accounts naturally hold little).
const classifyWealth = (coinWealth, level, avg, settings) => {
  if (avg == null || avg <= 0 || coinWealth == null) return null;
  const ratio = coinWealth / avg;
  const upperMult = effectiveWealthMultiplier(level, settings?.wealthAnomalyMultiplier ?? 1.5);
  const lowerMult = settings?.wealthAnomalyLowerMultiplier ?? 0.5;
  if (ratio > upperMult) return { anomalous: true, reason: `coin wealth ${coinWealth.toFixed(0)} is ${ratio.toFixed(1)}x the level ${level} median (${avg.toFixed(0)}).` };
  if (level >= 11 && ratio < lowerMult) return { anomalous: true, reason: `coin wealth ${coinWealth.toFixed(0)} is only ${ratio.toFixed(2)}x the level ${level} median (${avg.toFixed(0)}) — unusually low.` };
  return null;
};

const detectAgeDateAnomaly = (player, allWorkers, settings, globalCache, _addLog) => {
  const suspicions = [];
  const now = Date.now();
  const richWorkers = [];

  allWorkers.forEach(w => {
    const coinWealth = extractCoinWealth(w.resolvedUser);
    if (coinWealth == null) return;
    const level = extractUserLevel(w.resolvedUser) ?? w.normalizedLevel ?? 1;
    const avgResult = getWealthAverageExtended(globalCache, level);
    const verdict = classifyWealth(coinWealth, level, avgResult ? avgResult.avg : null, settings);
    if (verdict) {
      if (w.resolvedUser?.createdAt) w.accountAgeDays = Math.floor((now - new Date(w.resolvedUser.createdAt).getTime()) / 86400000);
      w.wealthReason = verdict.reason;
      richWorkers.push(w);
    }
  });

  if (richWorkers.length >= 1) {
    suspicions.push({
      type: 'wealth_anomaly', severity: 'critical',
      desc: `${richWorkers.length} account(s) show anomalous coin wealth for their level (outside ${settings?.wealthAnomalyLowerMultiplier ?? 0.5}x–${settings?.wealthAnomalyMultiplier ?? 1.5}x the level median). May indicate external funding or draining.`,
      workers: richWorkers, detectionWeight: richWorkers.length * 2
    });
  }

  // Boss account itself
  const bossCoinWealth = extractCoinWealth(player);
  if (bossCoinWealth != null) {
    const bossLevel = extractUserLevel(player) ?? player.level ?? 1;
    const bossAvgResult = getWealthAverageExtended(globalCache, bossLevel);
    const bossVerdict = classifyWealth(bossCoinWealth, bossLevel, bossAvgResult ? bossAvgResult.avg : null, settings);
    if (bossVerdict) {
      const ageDays = player.accountCreatedAt ? Math.floor((now - new Date(player.accountCreatedAt).getTime()) / 86400000) : undefined;
      suspicions.push({
        type: 'wealth_anomaly', severity: 'critical',
        desc: `Boss account ${bossVerdict.reason}`,
        workers: [{ uid: player.id, normalizedName: player.name + ' (SELF)', normalizedLevel: player.level || '?', accountAgeDays: ageDays, wealthReason: bossVerdict.reason }],
        detectionWeight: 3
      });
    }
  }

  return suspicions;
};

const detectTemporalClustering = (player, actionTimes) => {
  if (actionTimes.length < 20) return [];
  const suspicions = [];
  const hourBuckets = new Array(24).fill(0);
  actionTimes.forEach(a => { hourBuckets[new Date(a.time).getUTCHours()]++; });
  const total = hourBuckets.reduce((a,b) => a+b, 0);
  const activeHours = hourBuckets.filter(b => b > 0).length;
  const maxBucket = Math.max(...hourBuckets);
  const maxHour = hourBuckets.indexOf(maxBucket);
  const top3 = [...hourBuckets].sort((a,b)=>b-a).slice(0,3).reduce((a,b)=>a+b,0);
  const concentrationRatio = top3 / total;

  if (activeHours <= 4 && concentrationRatio >= 0.85 && total >= 20) {
    suspicions.push({
      type: 'temporal_clustering', severity: 'high',
      desc: `Activity Window Lock: 85%+ of all actions happen in only ${activeHours} hour(s) (peak: UTC ${maxHour}:00). Human players show varied session times; bots typically run on a fixed schedule.`,
      workers: [{ uid: player.id, normalizedName: player.name + " (SELF)", normalizedLevel: player.level || '?' }],
      detectionWeight: Math.round(concentrationRatio * 6),
      hourBuckets
    });
  }

  return suspicions;
};

const analyzePlayer = (player, settings, globalCache, actionTimes = [], _forceRun = false, addLog = null) => {
  if (!player) return null;

  let rawWorkers = player.companies ? player.companies.flatMap(c => c.workers || []) : [];
  const uniqueWorkersMap = new Map();
  rawWorkers.forEach(w => {
    const rawUser = w.user;
    const resolvedUserId = typeof rawUser === 'string' ? rawUser : (rawUser?._id || rawUser?.id || null);
    const uid = w._id || w.id || resolvedUserId || Math.random().toString(36).slice(2);
    w.uid = uid;
    if (typeof rawUser === 'object' && rawUser !== null && !w.resolvedUser) {
      w.resolvedUser = rawUser;
    }
    uniqueWorkersMap.set(uid, w);
  });
  let allWorkers = Array.from(uniqueWorkersMap.values());
  const washPartners = player.washPartners || {};
  const hasAdvancedFlags = player.sniperHits >= 5 || player.maxConcurrentTxs >= 5 || player.isHermit || player.isMutualHermit || player.pacingHits >= settings.pacingMinHits;
  if (!_forceRun && allWorkers.length < 2 && Object.keys(washPartners).length === 0 && !player.isDirectLaunderer && !hasAdvancedFlags) return null;

  const validWorkers = [];
  allWorkers.forEach(w => {
    w.normalizedName = w.resolvedUser?.username || w.name || 'Unknown';
    w.normalizedWage = w.wage !== undefined ? w.wage : (w.salary || 0);
    w.normalizedLevel = w.resolvedUser?.leveling?.level || w.level || 1;
    w.isActive = w.resolvedUser?.isActive;
    w.normalizedFidelity = w.fidelity !== undefined ? w.fidelity : 0;
    if (w.isActive === false && w.normalizedWage > settings.suspiciousWageThreshold) return;

    let signature = 'NO_DATA';
    if (w.resolvedUser?.skills) {
      const skills = w.resolvedUser.skills;
      const skillMap = {};
      Object.entries(skills).forEach(([key, data]) => {
        if (typeof data === 'object' && data !== null) {
          let val = 0;
          if (data.total !== undefined && data.total !== null) val = data.total;
          else if (data.value !== undefined && data.value !== null) val = data.value;
          if (typeof val === 'number' && val > 0) skillMap[key] = Math.floor(val);
        }
      });
      const sortedKeys = Object.keys(skillMap).sort();
      if (sortedKeys.length > 0) {
        const ECO_DEFAULTS = { energy: 30, production: 10, management: 4, entrepreneurship: 30 };
        const ecoStats = [];
        sortedKeys.forEach(k => {
          const lk = k.toLowerCase();
          if (ECO_DEFAULTS[lk] !== undefined && skillMap[k] > ECO_DEFAULTS[lk]) ecoStats.push(`${k.substring(0,3).toUpperCase()}:${skillMap[k]}`);
        });
        signature = ecoStats.length > 0 ? ecoStats.join(' | ') : 'DEFAULT_ECO';
      }
    }
    w.normalizedBuild = signature;
    validWorkers.push(w);
  });
  allWorkers = validWorkers;

  const automationSuspicions = detectAutomation(player, settings);
  const { suspicions: econSuspicions, totalCoinsWashed } = detectEconomicNetwork(player, allWorkers, settings, globalCache);
  const ageSuspicions = detectAgeDateAnomaly(player, allWorkers, settings, globalCache, addLog);
  const temporalSuspicions = detectTemporalClustering(player, actionTimes);

  let workerSuspicions = [], workerSuspiciousSet = new Set();
  let launderSuspicions = [], launderSuspiciousSet = new Set(), hasLaundering = false, launderingWorkerCount = 0, totalLaunderedCoins = 0;
  let shellSuspicions = [], shellSuspiciousSet = new Set(), zeroBonusCompanyCount = 0, bossNoBonusPercentage = 0;

  ({ suspicions: workerSuspicions, suspiciousWorkers: workerSuspiciousSet } = detectWorkerPatterns(allWorkers, settings, globalCache));
  ({ suspicions: launderSuspicions, suspiciousWorkers: launderSuspiciousSet, hasLaundering, launderingWorkerCount, totalLaunderedCoins } = detectLaundering(allWorkers, player, settings, globalCache));
  ({ suspicions: shellSuspicions, suspiciousWorkers: shellSuspiciousSet, zeroBonusCompanyCount, bossNoBonusPercentage } = detectShellCompanies(allWorkers, settings, globalCache));

  const allSuspicions = [
    ...automationSuspicions,
    ...econSuspicions,
    ...ageSuspicions,
    ...temporalSuspicions,
    ...launderSuspicions,
    ...workerSuspicions,
    ...shellSuspicions,
  ];

  if (player.tipAbuse) {
    const { heavyTippers, repeatTippers, tipperCounts, tipperAmounts, tipperSentTotals, tipperMeta, totalTipsReceived, totalCoinsReceived } = player.tipAbuse;
    const coinsStr = totalCoinsReceived > 0 ? ` ${totalCoinsReceived.toFixed(1)} coins earned through tips.` : '';
    allSuspicions.push({
      type: 'tip_farming', severity: 'high',
      desc: `Article Tip Farming: ${heavyTippers} account(s) tipped 10+ times; ${repeatTippers} tipped 5+ times.${coinsStr} Coordinated engagement inflation.`,
      workers: [{ uid: player.id, normalizedName: player.name + ' (SELF)', normalizedLevel: player.level || '?' }],
      tipperCounts: tipperCounts || {},
      tipperAmounts: tipperAmounts || {},
      tipperSentTotals: tipperSentTotals || {},
      tipperMeta: tipperMeta || {},
      totalTipsReceived: totalTipsReceived || 0,
      totalCoinsReceived: totalCoinsReceived || 0,
      detectionWeight: heavyTippers * 2 + repeatTippers,
    });
  }

  if (allSuspicions.length === 0) return null;

  const summaryParts = [];
  if (player.sniperHits >= 5) summaryParts.push(`Sniper automation (${player.sniperHits} hits).`);
  if (player.maxConcurrentTxs >= 5) summaryParts.push(`Superhuman APM (${player.maxConcurrentTxs} concurrent ops).`);
  if (player.pacingHits >= settings.pacingMinHits) summaryParts.push(`Script pacing (${player.pacingHits} actions at ~${player.pacingAvgMs}ms).`);
  if (player.isHermit) summaryParts.push(`Hermit network (isolated trading).`);
  if (player.isMutualHermit) summaryParts.push(`Mutual hermit pair detected.`);
  const wageSus = allSuspicions.find(s => s.type === 'low_wage');
  if (wageSus) summaryParts.push(`${wageSus.workers.length} workers paid very low wages.`);
  const wageUnif = allSuspicions.find(s => s.type === 'wage_uniformity');
  if (wageUnif) summaryParts.push(`Suspiciously uniform wages across workforce.`);
  const fidelSus = allSuspicions.find(s => s.type === 'fidelity_ring');
  if (fidelSus) summaryParts.push(`${fidelSus.workers.length} workers all at max fidelity.`);
  if (hasLaundering) summaryParts.push(`${launderingWorkerCount} workers donated ${totalLaunderedCoins.toFixed(1)} coins in large MU transactions.`);
  const coordDonation = allSuspicions.find(s => s.type === 'coordinated_donation');
  if (coordDonation) summaryParts.push(`Donations coordinated within 10-min windows.`);
  const ageSus = allSuspicions.find(s => s.type === 'wealth_anomaly');
  if (ageSus) { const _bw=extractCoinWealth(player), _bl=extractUserLevel(player)??player.level, _bar=_bl!=null?getWealthAverageExtended(globalCache,_bl):null; summaryParts.push(_bw!=null&&_bar&&_bar.avg>0&&(_bw/_bar.avg)<1?`Account wealth unusually low for level.`:`Account wealth disproportionately high for level.`); }
  const tempSus = allSuspicions.find(s => s.type === 'temporal_clustering');
  if (tempSus) summaryParts.push(`Activity locked to narrow time window.`);
  const cloneSus = allSuspicions.filter(s => s.type === 'cloned_progression');
  if (cloneSus.length > 0) summaryParts.push(`${cloneSus.reduce((s,c) => s+c.workers.length, 0)} workers have cloned skills.`);
  const shellSus = allSuspicions.find(s => s.type === 'no_production_bonus');
  if (shellSus) summaryParts.push(`${bossNoBonusPercentage}% of worker companies have no regional production bonuses.`);
  const nameSus = allSuspicions.filter(s => s.type === 'naming_pattern');
  if (nameSus.length > 0) {
    const uNames = new Set(); nameSus.forEach(c => c.workers.forEach(w => uNames.add(w.uid)));
    summaryParts.push(`${uNames.size} workers with overlapping naming patterns.`);
  }
  const abuseSus = allSuspicions.find(s => s.type === 'transaction_abuse');
  if (abuseSus) summaryParts.push(`Wash Trading ring with ${abuseSus?.partners?.length || 0} partners.`);

  allSuspicions.sort((a, b) => {
    const order = ['coordinated_donation','money_laundering','transaction_abuse','market_automation','superhuman_apm','script_pacing','mutual_hermit','hermit_network','wealth_anomaly'];
    const ai = order.indexOf(a.type); const bi = order.indexOf(b.type);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1; if (bi !== -1) return 1;
    return (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0);
  });

  return {
    player, summary: summaryParts.join(' ') || `Worker analysis: ${allSuspicions.length} anomal${allSuspicions.length === 1 ? 'y' : 'ies'} detected.`, suspicions: allSuspicions,
    detections: allSuspicions.reduce((acc, s) => acc + (s.detectionWeight !== undefined ? s.detectionWeight : (s.workers?.length || s.partners?.length || 1)), 0),
    zeroBonusCompanyCount, bossNoBonusPercentage, hasLaundering, launderingWorkerCount,
    totalLaunderedCoins, washPartners, washPartnerCount: Object.keys(washPartners).length, totalCoinsWashed,
    scoreBreakdown: allSuspicions.map(s => ({
      type: s.type, weight: s.detectionWeight !== undefined ? s.detectionWeight : (s.workers?.length || s.partners?.length || 1), severity: s.severity
    }))
  };
};

const analyzePhase1 = (player, settings, globalCache, addLog = null) => {
  if (!player) return null;

  const washPartners = player.washPartners || {};
  const hasAdvancedFlags = player.sniperHits >= 5 || player.maxConcurrentTxs >= 5 ||
    player.isHermit || player.isMutualHermit || player.pacingHits >= settings.pacingMinHits;

  const automationSuspicions = detectAutomation(player, settings);
  const { suspicions: econSuspicions, totalCoinsWashed } = detectEconomicNetwork(player, [], settings, globalCache);
  const ageSuspicions = detectAgeDateAnomaly(player, [], settings, globalCache, addLog);

  const allSuspicions = [...automationSuspicions, ...econSuspicions, ...ageSuspicions];

  if (player.isDirectLaunderer) {
    const selfWorker = {
      uid: player.id, normalizedName: player.name + ' (SELF)', normalizedLevel: player.level || '?',
      largeDonations30Days: player.directLaunderAmount, totalDonatedAllTime: player.directLaunderAmount,
      isLaundering: true, noBonusPercentage: 0
    };
    const existingLaunder = allSuspicions.find(s => s.type === 'money_laundering');
    if (existingLaunder) { existingLaunder.workers.push(selfWorker); existingLaunder.detectionWeight += 3; }
    else allSuspicions.push({
      type: 'money_laundering', severity: 'critical',
      desc: 'Large outbound donations from this account — a pattern consistent with a burner funnel.',
      workers: [selfWorker], detectionWeight: 3
    });
  }

  if (player.tipAbuse) {
    const { heavyTippers, repeatTippers, tipperCounts, tipperAmounts, tipperSentTotals, tipperMeta, totalTipsReceived, totalCoinsReceived } = player.tipAbuse;
    const coinsStr = totalCoinsReceived > 0 ? ` ${totalCoinsReceived.toFixed(1)} coins earned through tips.` : '';
    allSuspicions.push({
      type: 'tip_farming', severity: 'high',
      desc: `Article Tip Farming: ${heavyTippers} account(s) tipped 10+ times; ${repeatTippers} tipped 5+ times.${coinsStr} Coordinated engagement inflation.`,
      workers: [{ uid: player.id, normalizedName: player.name + ' (SELF)', normalizedLevel: player.level || '?' }],
      tipperCounts: tipperCounts || {},
      tipperAmounts: tipperAmounts || {},
      tipperSentTotals: tipperSentTotals || {},
      tipperMeta: tipperMeta || {},
      totalTipsReceived: totalTipsReceived || 0,
      totalCoinsReceived: totalCoinsReceived || 0,
      detectionWeight: heavyTippers * 2 + repeatTippers
    });
  }

  if (allSuspicions.length === 0) return null;

  allSuspicions.sort((a, b) => {
    const order = ['money_laundering', 'transaction_abuse', 'market_automation', 'superhuman_apm', 'script_pacing', 'mutual_hermit', 'hermit_network', 'wealth_anomaly', 'tip_farming'];
    const ai = order.indexOf(a.type); const bi = order.indexOf(b.type);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1; if (bi !== -1) return 1;
    return (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0);
  });

  const summaryParts = [];
  if (player.sniperHits >= 5) summaryParts.push(`Sniper automation (${player.sniperHits} hits).`);
  if (player.maxConcurrentTxs >= 5) summaryParts.push(`Superhuman APM (${player.maxConcurrentTxs} concurrent ops).`);
  if (player.pacingHits >= settings.pacingMinHits) summaryParts.push(`Script pacing (${player.pacingHits} actions at ~${player.pacingAvgMs}ms).`);
  if (player.isHermit) summaryParts.push(`Hermit network (isolated trading).`);
  if (player.isMutualHermit) summaryParts.push(`Mutual hermit pair detected.`);
  if (player.isDirectLaunderer) summaryParts.push(`Outbound donation burner detected.`);
  const tipSusP2 = allSuspicions.find(s => s.type === 'tip_farming');
  if (tipSusP2) summaryParts.push(`Article tip farming (${player.tipAbuse?.heavyTippers || 0} heavy, ${player.tipAbuse?.repeatTippers || 0} repeat tippers).`);
  const abuseSus = allSuspicions.find(s => s.type === 'transaction_abuse');
  if (abuseSus) summaryParts.push(`Wash Trading ring with ${abuseSus?.partners?.length || 0} partners.`);
  const ageSus = allSuspicions.find(s => s.type === 'wealth_anomaly');
  if (ageSus) { const _bw=extractCoinWealth(player), _bl=extractUserLevel(player)??player.level, _bar=_bl!=null?getWealthAverageExtended(globalCache,_bl):null; summaryParts.push(_bw!=null&&_bar&&_bar.avg>0&&(_bw/_bar.avg)<1?`Account wealth unusually low for level.`:`Account wealth disproportionately high for level.`); }

  const detections = allSuspicions.reduce((acc, s) => acc + (s.detectionWeight !== undefined ? s.detectionWeight : (s.workers?.length || s.partners?.length || 1)), 0);

  return {
    player,
    summary: summaryParts.join(' ') || 'Phase 1 transaction flags - load worker analysis for full details.',
    suspicions: allSuspicions,
    detections,
    phase2Status: 'pending',
    hasLaundering: player.isDirectLaunderer,
    launderingWorkerCount: player.isDirectLaunderer ? 1 : 0,
    totalLaunderedCoins: player.directLaunderAmount || 0,
    washPartners, washPartnerCount: Object.keys(washPartners).length, totalCoinsWashed,
    zeroBonusCompanyCount: 0, bossNoBonusPercentage: 0,
    scoreBreakdown: allSuspicions.map(s => ({
      type: s.type,
      weight: s.detectionWeight !== undefined ? s.detectionWeight : (s.workers?.length || s.partners?.length || 1),
      severity: s.severity
    }))
  };
};

class UnionFind {
  constructor() { this.parent = {}; }
  add(id) { if (!this.parent[id]) this.parent[id] = id; }
  find(id) { if (this.parent[id] !== id) this.parent[id] = this.find(this.parent[id]); return this.parent[id]; }
  union(id1, id2) { this.add(id1); this.add(id2); const r1=this.find(id1),r2=this.find(id2); if(r1!==r2) this.parent[r2]=r1; }
}

// ── Linked-Account Matrix (Concept G / Cobalt) ──────────────────────────────
// One row per linked account; each detection becomes a column you read DOWN to
// see the pattern. Derived entirely from the existing analyzePlayer suspicions.
const MATRIX_LINK_LABEL = {
  wage_uniformity: 'WAGE', low_wage: 'WAGE', fidelity_ring: 'FID',
  naming_pattern: 'NAME', cloned_progression: 'CLONE', no_production_bonus: 'SHELL',
  wealth_anomaly: 'WEALTH', money_laundering: 'LAUNDER', coordinated_donation: 'DONATE',
  newborn_wealthy: 'WEALTH',
};
const CLONE_COLOR = ['#4fc3e8', '#c98bff', '#5aa0ff', '#3fd0a3'];

const buildMatrixModel = (suspicions, globalCache) => {
  const byUid = new Map();
  const order = [];
  let overlapString = null;
  (suspicions || []).forEach(s => {
    if (['tip_farming', 'transaction_abuse', 'temporal_clustering'].includes(s.type)) return;
    if (s.type === 'naming_pattern' && s.overlapString) overlapString = s.overlapString;
    (s.workers || []).forEach(w => {
      const uid = w.uid || w.resolvedUser?._id;
      if (!uid) return;
      const name = String(w.normalizedName || '').replace(' (SELF)', '').replace(' (HERMIT NODE)', '');
      if (!byUid.has(uid)) {
        let wealthX = null, wealth = null;
        const ru = w.resolvedUser;
        if (globalCache && ru) {
          const cw = extractCoinWealth(ru);
          if (cw != null) wealth = cw;
          const lv = extractUserLevel(ru) ?? w.normalizedLevel;
          const ar = lv != null ? getWealthAverageExtended(globalCache, lv) : null;
          if (cw != null && ar && ar.avg > 0) wealthX = cw / ar.avg;
        }
        byUid.set(uid, {
          uid, name, wage: w.normalizedWage, level: w.normalizedLevel,
          fid: w.normalizedFidelity, build: w.normalizedBuild, wealthX, wealth,
          age: w.accountAgeDays ?? (w.resolvedUser?.createdAt ? Math.floor((Date.now() - new Date(w.resolvedUser.createdAt).getTime()) / 86400000) : null),
          id: w.resolvedUser?._id || uid, links: new Set(),
        });
        order.push(uid);
      }
      byUid.get(uid).links.add(s.type);
    });
  });
  const rows = order.map(uid => byUid.get(uid));
  // Clone groups: identical non-trivial builds appearing 2+ times share a tag.
  const counts = {};
  rows.forEach(r => { const b = r.build; if (b && b !== 'NO_DATA' && b !== 'DEFAULT_ECO') counts[b] = (counts[b] || 0) + 1; });
  const letters = {}; let li = 0;
  Object.keys(counts).forEach(b => { if (counts[b] >= 2) { letters[b] = String.fromCharCode(65 + li); li++; } });
  rows.forEach(r => { r.cloneGroup = letters[r.build] || null; r.cloneColor = r.cloneGroup ? CLONE_COLOR[r.cloneGroup.charCodeAt(0) - 65] : null; });
  return { rows, overlapString };
};

const MatrixNameCell = ({ name, frag }) => {
  if (!frag) return <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 12, color: '#eaf0ff', fontWeight: 600 }}>{name}</span>;
  const i = name.toLowerCase().indexOf(String(frag).toLowerCase());
  if (i < 0) return <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 12, color: '#eaf0ff', fontWeight: 600 }}>{name}</span>;
  return <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 12, color: '#eaf0ff', fontWeight: 600 }}>
    {name.slice(0, i)}<span style={{ color: '#4fc3e8', background: 'rgba(79,195,232,0.13)', borderRadius: 3, padding: '0 2px' }}>{name.slice(i, i + frag.length)}</span>{name.slice(i + frag.length)}
  </span>;
};

const LinkedAccountMatrix = ({ suspicions, wageThreshold = 0.11, bossId }) => {
  const { rows: allRows, overlapString } = buildMatrixModel(suspicions);
  const rows = bossId ? allRows.filter(r => r.id !== bossId && r.uid !== bossId) : allRows;
  if (rows.length < 2) return null;
  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: '#9fb0d4', textTransform: 'uppercase' }}>Linked-Account Matrix</span>
      <span style={{ fontSize: 11, color: '#5d6e96' }}>— same accounts, each column is a signal; read down to see the pattern</span>
    </div>
  );
  const td = { padding: '9px 12px', borderBottom: '1px solid #1f2b4e', verticalAlign: 'middle' };
  const th = { textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #2e3f6a', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: '#5d6e96' };
  const cols = ['LINKED ACCOUNT', 'LVL', 'CREATED', 'WAGE', 'FIDELITY', 'SKILL BUILD', 'LINKED BY'];
  return (
    <div style={{ padding: '0 24px 18px' }}>
      {header}
      <div style={{ border: '1px solid #1f2b4e', borderRadius: 9, overflow: 'hidden', background: '#0c1226' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr style={{ background: '#121b35' }}>{cols.map(c => <th key={c} style={th}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((w, i) => {
            const lowWage = w.wage != null && w.wage <= wageThreshold;
            const fid = Math.max(0, Math.min(10, Math.round(w.fid || 0)));
            return (
              <tr key={w.uid} style={i === rows.length - 1 ? { ...td, borderBottom: 'none' } : undefined}>
                <td style={td}>
                  <a href={`https://app.warera.io/user/${w.id}`} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
                    <MatrixNameCell name={w.name} frag={overlapString} /><ExternalLink size={10} style={{ color: '#5d6e96' }} />
                  </a>
                </td>
                <td style={{ ...td, fontFamily: "IBM Plex Mono, monospace", fontSize: 12, color: '#9fb0d4' }}>{w.level ?? '?'}</td>
                <td style={{ ...td, fontFamily: "IBM Plex Mono, monospace", fontSize: 12, color: '#9fb0d4' }}>{w.age != null ? `${w.age}d` : '—'}</td>
                <td style={td}>
                  <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 12, fontWeight: 700, color: lowWage ? '#ffab3d' : '#eaf0ff', background: lowWage ? 'rgba(255,171,61,0.12)' : 'transparent', border: lowWage ? '1px solid rgba(255,171,61,0.40)' : '1px solid transparent', borderRadius: 5, padding: '2px 7px' }}>{w.wage != null ? Number(w.wage).toFixed(3) : '—'}</span>
                </td>
                <td style={td}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ display: 'flex', gap: 1.5 }}>{Array.from({ length: 10 }).map((_, j) => <span key={j} style={{ width: 4, height: 12, borderRadius: 1, background: j < fid ? (fid === 10 ? '#ffab3d' : '#9fb0d4') : '#2e3f6a' }} />)}</div>
                    <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11, fontWeight: 700, color: fid === 10 ? '#ffab3d' : '#9fb0d4' }}>{fid}/10</span>
                  </div>
                </td>
                <td style={td}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11, color: w.cloneColor || '#9fb0d4', fontWeight: w.cloneGroup ? 700 : 500 }}>{w.build && w.build !== 'NO_DATA' ? w.build : '—'}</span>
                    {w.cloneGroup && <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 8.5, fontWeight: 700, color: w.cloneColor, border: `1px solid ${w.cloneColor}`, borderRadius: 3, padding: '0 4px' }}>CLONE {w.cloneGroup}</span>}
                  </div>
                </td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {[...w.links].map(t => MATRIX_LINK_LABEL[t]).filter(Boolean).filter((v, idx, a) => a.indexOf(v) === idx).map(l => (
                      <span key={l} style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', color: '#9fb0d4', background: '#1b2748', border: '1px solid #2e3f6a', borderRadius: 4, padding: '1.5px 5px' }}>{l}</span>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
};

// ── Severity + relationship helpers (Concept G) ──────────────────────────────
const PL_SEV = {
  crit: { c: '#ff5d6c', bg: 'rgba(255,93,108,0.12)', line: 'rgba(255,93,108,0.42)' },
  high: { c: '#ffab3d', bg: 'rgba(255,171,61,0.12)', line: 'rgba(255,171,61,0.40)' },
  med:  { c: '#ffd84d', bg: 'rgba(255,216,77,0.11)', line: 'rgba(255,216,77,0.36)' },
};
const plScoreTier = (s) => s >= 10 ? 'crit' : s >= 5 ? 'high' : 'med';
const plSevTier = (sev) => sev === 'critical' ? 'crit' : sev === 'high' ? 'high' : 'med';
const PL_REL = { name: '#5aa0ff', clone: '#c98bff', wash: '#ff5d6c', donation: '#3fd0a3' };
const wealthColor = (x) => x == null ? '#9fb0d4' : (x < 0.5 ? '#4fc3e8' : x > 2 ? '#ff5d6c' : '#ffab3d');

// Cluster-shape glyph for the case list — Workforce (employees) / Ring / Solo.
const KindGlyph = ({ kind, c = '#5d6e96' }) => {
  if (kind === 'Workforce') return <svg width="12" height="12" viewBox="0 0 14 14"><circle cx="7" cy="4" r="2" fill="none" stroke={c} strokeWidth="1.2" /><circle cx="3" cy="10" r="1.6" fill="none" stroke={c} strokeWidth="1.2" /><circle cx="11" cy="10" r="1.6" fill="none" stroke={c} strokeWidth="1.2" /><path d="M7 6 L3.6 8.6M7 6 L10.4 8.6" stroke={c} strokeWidth="1.1" /></svg>;
  if (kind === 'Ring') return <svg width="12" height="12" viewBox="0 0 14 14"><circle cx="7" cy="7" r="4.2" fill="none" stroke={c} strokeWidth="1.2" /><path d="M9.6 4.4 L11 3M4.4 9.6 L3 11" stroke={c} strokeWidth="1.2" strokeLinecap="round" /></svg>;
  return <svg width="12" height="12" viewBox="0 0 14 14"><circle cx="7" cy="5" r="2.2" fill="none" stroke={c} strokeWidth="1.2" /><path d="M3 11.5c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5" fill="none" stroke={c} strokeWidth="1.2" /></svg>;
};
// Classifies a result into its cluster shape + size for the case-list sub-line.
const clusterKindOf = (r, globalCache) => {
  const ringCount = Object.keys(r.washPartners || {}).length;
  if (ringCount > 0) return { kind: 'Ring', size: ringCount + 1 };
  const wf = buildMatrixModel(r.suspicions, globalCache).rows.filter(x => x.id !== r.player.id && x.uid !== r.player.id).length;
  return wf >= 2 ? { kind: 'Workforce', size: wf } : { kind: 'Solo', size: 0 };
};

// Builds the relationship graph for the map from ALL relevant suspicions:
// worker nodes (employed alts) + wash-trade partners, with name / clone / wash edges.
const buildClusterGraph = (activeResult, globalCache) => {
  const bossId = activeResult.player.id;
  const { rows } = buildMatrixModel(activeResult.suspicions, globalCache);
  const nodes = new Map();
  rows.forEach(r => {
    if (r.id === bossId || r.uid === bossId) return;
    nodes.set(r.uid, { uid: r.uid, id: r.id, name: r.name, level: r.level, wage: r.wage, fid: r.fid, build: r.build, wealthX: r.wealthX, wealth: r.wealth, cloneGroup: r.cloneGroup, cloneColor: r.cloneColor, kind: 'worker' });
  });
  const edges = [];
  // Name edges — one chain per naming_pattern group (there can be several).
  (activeResult.suspicions || []).forEach(s => {
    if (s.type !== 'naming_pattern') return;
    const ids = (s.workers || []).map(w => w.uid || w.resolvedUser?._id).filter(u => u && u !== bossId && nodes.has(u));
    ids.forEach(u => { if (s.overlapString) nodes.get(u).frag = s.overlapString; });
    for (let i = 1; i < ids.length; i++) edges.push({ a: ids[i - 1], b: ids[i], type: 'name' });
  });
  // Clone edges — chain within each shared-build group.
  const groups = {};
  nodes.forEach(n => { if (n.cloneGroup) (groups[n.cloneGroup] = groups[n.cloneGroup] || []).push(n.uid); });
  Object.values(groups).forEach(g => { for (let i = 1; i < g.length; i++) edges.push({ a: g[i - 1], b: g[i], type: 'clone' }); });
  // Wash-trade partners — directional coin-flow edges from the boss.
  const wash = (activeResult.suspicions || []).find(s => s.type === 'transaction_abuse');
  if (wash) (wash.partners || []).forEach(p => {
    if (!p.id || p.id === bossId) return;
    if (!nodes.has(p.id)) nodes.set(p.id, { uid: p.id, id: p.id, name: String(p.name || p.id), level: p.level, banned: p.isBanned, kind: 'partner' });
    else nodes.get(p.id).banned = nodes.get(p.id).banned || p.isBanned;
    edges.push({ a: bossId, b: p.id, type: 'wash', net: p.netProfit || 0, trades: p.txCount });
  });
  return { nodes: [...nodes.values()], edges };
};

const WealthTag = ({ x, size = 10, coins }) => {
  if (x == null) return null;
  const c = wealthColor(x);
  const title = coins != null ? `${Math.round(coins)} coins · ${x.toFixed(2)}× the level median` : undefined;
  return <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: "IBM Plex Mono, monospace", fontSize: size, fontWeight: 700, color: c, cursor: coins != null ? 'help' : 'default' }}>
    <span style={{ width: size - 1, height: size - 1, borderRadius: '50%', border: `1.5px solid ${c}`, flexShrink: 0 }} />{x.toFixed(1)}×
  </span>;
};

// ── Interactive relationship map (drag / zoom / hover) ───────────────────────
const ClusterMap = ({ boss, nodes, edges, height = 384, nodeW = 150 }) => {
  const wrapRef = React.useRef(null);
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  React.useLayoutEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const NODE_H = 72;
  const SPREAD = 0.68; // pull the alts in toward the boss so the cluster reads tighter
  const geom = React.useMemo(() => {
    const w = size.w || 820, h = size.h || height;
    const rx = Math.max(120, ((w / 2 - nodeW / 2 - 24) / 0.87) * SPREAD);
    const ry = Math.max(78, (h / 2 - NODE_H / 2 - 14) * SPREAD);
    return { cx: w / 2, cy: h / 2, rx, ry };
  }, [size.w, size.h, nodeW, height]);
  const initial = React.useMemo(() => {
    const { cx, cy, rx, ry } = geom;
    const m = { BOSS: { x: cx, y: cy } };
    const n = nodes.length || 1;
    nodes.forEach((nd, i) => { const a = (-90 + i * (360 / n)) * Math.PI / 180; m[nd.uid] = { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }; });
    return m;
  }, [geom, nodes]);
  const [posns, setPosns] = React.useState(initial);
  const [zoom, setZoom] = React.useState(1);
  const [hover, setHover] = React.useState(null);
  const [dragKey, setDragKey] = React.useState(null);
  // Re-seed positions only when the node SET or container size actually changes —
  // not on every parent re-render (which gives `nodes`/`initial` a new identity and
  // would otherwise snap a dragged node back to its start).
  const layoutKey = nodes.map(n => n.uid).join(',') + '|' + Math.round(geom.cx) + 'x' + Math.round(geom.cy);
  React.useEffect(() => { setPosns(initial); }, [layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dragRef = React.useRef(null);
  const toLocal = (clientX, clientY) => {
    const el = wrapRef.current; const rect = el.getBoundingClientRect();
    const s = rect.width / (el.clientWidth || rect.width);
    const lx = (clientX - rect.left) / s, ly = (clientY - rect.top) / s;
    const ox = el.clientWidth / 2, oy = el.clientHeight / 2;
    return { x: ox + (lx - ox) / zoom, y: oy + (ly - oy) / zoom };
  };
  const onMove = (e) => { const d = dragRef.current; if (!d) return; const L = toLocal(e.clientX, e.clientY); setPosns(p => ({ ...p, [d.key]: { x: L.x + d.dx, y: L.y + d.dy } })); };
  const onUp = () => { dragRef.current = null; setDragKey(null); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  const startDrag = (key, e) => { e.preventDefault(); e.stopPropagation(); const L = toLocal(e.clientX, e.clientY); const cur = posns[key] || { x: 0, y: 0 }; dragRef.current = { key, dx: cur.x - L.x, dy: cur.y - L.y }; setDragKey(key); window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); };
  const reset = () => { setPosns(initial); setZoom(1); };
  const nudge = (d) => setZoom(z => Math.min(2, Math.max(0.6, +(z + d * 0.2).toFixed(2))));
  const edgeLit = (e) => hover && (hover === e.a || hover === e.b);
  const B = posns.BOSS || { x: geom.cx, y: geom.cy };
  const tier = plScoreTier(boss.score);

  const NodeCard = ({ nd }) => {
    const p = posns[nd.uid] || { x: geom.cx, y: geom.cy };
    const active = dragKey === nd.uid;
    const dim = hover && hover !== 'BOSS' && hover !== nd.uid && !edges.some(e => (e.a === hover && e.b === nd.uid) || (e.b === hover && e.a === nd.uid));
    let nm = <span>{nd.name}</span>;
    if (nd.frag) { const i = nd.name.toLowerCase().indexOf(String(nd.frag).toLowerCase()); if (i >= 0) nm = <span>{nd.name.slice(0, i)}<span style={{ color: PL_REL.name }}>{nd.name.slice(i, i + nd.frag.length)}</span>{nd.name.slice(i + nd.frag.length)}</span>; }
    return (
      <div onPointerDown={(e) => startDrag(nd.uid, e)} onMouseEnter={() => setHover(nd.uid)} onMouseLeave={() => setHover(null)}
        style={{ position: 'absolute', left: p.x, top: p.y, transform: `translate(-50%,-50%) scale(${active ? 1.04 : 1})`, width: nodeW, background: '#121b35', border: `1px solid ${active || hover === nd.uid ? '#4fc3e8' : '#2e3f6a'}`, borderRadius: 9, padding: '8px 10px', boxShadow: active ? '0 14px 34px rgba(0,0,0,.55)' : '0 6px 18px rgba(0,0,0,.4)', cursor: active ? 'grabbing' : 'grab', opacity: dim ? 0.4 : 1, transition: 'opacity .12s, border-color .12s', userSelect: 'none', touchAction: 'none', zIndex: active ? 5 : 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
          <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11.5, fontWeight: 600, color: nd.banned ? '#ff5d6c' : '#eaf0ff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nm}</span>
          {nd.banned && <span style={{ fontSize: 7.5, fontWeight: 700, color: '#ff5d6c', background: 'rgba(255,93,108,0.12)', border: '1px solid rgba(255,93,108,0.42)', borderRadius: 3, padding: '0 3px', flexShrink: 0 }}>BAN</span>}
          <a href={`https://app.warera.io/user/${nd.id}`} target="_blank" rel="noopener noreferrer" onPointerDown={(e) => e.stopPropagation()} style={{ color: '#5d6e96', flexShrink: 0, marginLeft: 'auto' }}><ExternalLink size={9} /></a>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: nd.kind === 'partner' ? 0 : 4 }}>
          <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 9.5, color: '#5d6e96' }}>Lv.{nd.level ?? '?'}</span>
          {nd.kind === 'partner'
            ? <span style={{ marginLeft: 'auto', fontFamily: "IBM Plex Mono, monospace", fontSize: 8.5, fontWeight: 700, color: '#ff5d6c' }}>WASH PARTNER</span>
            : <span style={{ marginLeft: 'auto' }}><WealthTag x={nd.wealthX} coins={nd.wealth} /></span>}
        </div>
        {nd.kind !== 'partner' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 9.5, color: '#ffab3d' }}>{nd.wage != null ? Number(nd.wage).toFixed(3) : '—'}</span>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 9.5, color: '#ffab3d', marginLeft: 'auto' }}>fid {nd.fid ?? 0}</span>
          </div>
        )}
      </div>
    );
  };
  const ZBtn = ({ children, onClick }) => <button onClick={onClick} style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: '#9fb0d4', fontSize: 15, fontWeight: 700, cursor: 'pointer', lineHeight: 1 }}>{children}</button>;

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, transform: `scale(${zoom})`, transformOrigin: 'center center' }}>
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
          {nodes.filter(nd => nd.kind !== 'partner').map(nd => { const p = posns[nd.uid] || B; const on = hover === 'BOSS' || hover === nd.uid; return <line key={nd.uid} x1={B.x} y1={B.y} x2={p.x} y2={p.y} stroke={on ? '#5d6e96' : '#2e3f6a'} strokeWidth={on ? 1.7 : 1.3} strokeDasharray="3 4" opacity={hover && !on ? 0.35 : 1} />; })}
          {edges.map((e, i) => {
            const A = posns[e.a] || B, C = posns[e.b] || B;
            const on = edgeLit(e), faded = hover && !on;
            return <path key={i} d={`M ${A.x} ${A.y} L ${C.x} ${C.y}`} fill="none" stroke={PL_REL[e.type]} strokeWidth={on ? 2.6 : 2} opacity={faded ? 0.25 : 0.9} style={{ transition: 'opacity .12s' }} />;
          })}
        </svg>
        <div onPointerDown={(e) => startDrag('BOSS', e)} onMouseEnter={() => setHover('BOSS')} onMouseLeave={() => setHover(null)}
          style={{ position: 'absolute', left: B.x, top: B.y, transform: `translate(-50%,-50%) scale(${dragKey === 'BOSS' ? 1.03 : 1})`, width: 184, textAlign: 'center', background: PL_SEV[tier].bg, border: `2px solid ${PL_SEV[tier].line}`, borderRadius: 12, padding: '12px 14px', boxShadow: '0 10px 30px rgba(0,0,0,.5)', cursor: dragKey === 'BOSS' ? 'grabbing' : 'grab', userSelect: 'none', touchAction: 'none', zIndex: dragKey === 'BOSS' ? 5 : 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 5 }}>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 16, fontWeight: 700, color: '#eaf0ff' }}>{boss.name}</span>
            <a href={`https://app.warera.io/user/${boss.id}`} target="_blank" rel="noopener noreferrer" onPointerDown={(e) => e.stopPropagation()} style={{ color: '#5d6e96' }}><ExternalLink size={11} /></a>
          </div>
          <div style={{ fontSize: 10, color: '#9fb0d4', marginBottom: 7 }}>{boss.region} · Lv.{boss.level ?? '?'}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <WealthTag x={boss.wealthX} size={11} coins={boss.wealth} />
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 13, fontWeight: 700, color: PL_SEV[tier].c }}>{boss.score}</span>
          </div>
        </div>
        {nodes.map(nd => <NodeCard key={nd.uid} nd={nd} />)}
        {/* Edge labels in an opaque layer ABOVE the node cards so they're never hidden. */}
        {edges.map((e, i) => {
          const A = posns[e.a] || B, C = posns[e.b] || B;
          const on = edgeLit(e), faded = hover && !on;
          const lbl = e.type === 'wash' ? `${e.net > 0 ? '+' : ''}${Math.round(e.net)}` : e.type === 'name' ? 'NAME' : 'CLONE';
          return <div key={'lbl' + i} style={{ position: 'absolute', left: (A.x + C.x) / 2, top: (A.y + C.y) / 2, transform: 'translate(-50%,-50%)', zIndex: 4, fontFamily: "IBM Plex Mono, monospace", fontSize: 8.5, fontWeight: 700, color: PL_REL[e.type], background: '#070b18', border: `1px solid ${PL_REL[e.type]}`, borderRadius: 4, padding: '1px 5px', opacity: faded ? 0.25 : 1, pointerEvents: 'none', whiteSpace: 'nowrap' }}>{lbl}</div>;
        })}
      </div>
      <div style={{ position: 'absolute', left: 12, bottom: 12, display: 'flex', flexDirection: 'column', gap: 6, background: 'rgba(12,18,38,0.86)', border: '1px solid #1f2b4e', borderRadius: 8, padding: '9px 11px', pointerEvents: 'none', zIndex: 6 }}>
        <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.07em', color: '#5d6e96', marginBottom: 1 }}>HOW THEY'RE LINKED</div>
        {[['#2e3f6a', 'Boss → worker (employs)', true], [PL_REL.name, 'Shares a name fragment', false], [PL_REL.clone, 'Identical skill build', false], [PL_REL.wash, 'Wash-trade partner (net coins)', false]].map((l, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke={l[0]} strokeWidth="2.2" strokeDasharray={l[2] ? '3 3' : '0'} /></svg>
            <span style={{ fontSize: 10.5, color: '#9fb0d4' }}>{l[1]}</span>
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', right: 12, top: 12, display: 'flex', alignItems: 'center', gap: 8, zIndex: 6 }}>
        <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 9.5, color: '#5d6e96' }}>drag to rearrange</span>
        <div style={{ display: 'flex', alignItems: 'center', background: '#121b35', border: '1px solid #2e3f6a', borderRadius: 6, overflow: 'hidden' }}>
          <ZBtn onClick={() => nudge(-1)}>−</ZBtn>
          <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: '#9fb0d4', width: 38, textAlign: 'center', borderLeft: '1px solid #2e3f6a', borderRight: '1px solid #2e3f6a' }}>{Math.round(zoom * 100)}%</span>
          <ZBtn onClick={() => nudge(1)}>+</ZBtn>
        </div>
        <span onClick={reset} style={{ fontSize: 10, fontWeight: 600, color: '#9fb0d4', background: '#121b35', border: '1px solid #2e3f6a', borderRadius: 6, padding: '5px 9px', cursor: 'pointer' }}>⟲ Reset</span>
      </div>
    </div>
  );
};

// Builds the cluster map (or a placeholder) from a suspect's analysis result.
const ClusterMapPanel = ({ activeResult, globalCache, bossWealthX, bossWealth }) => {
  const { nodes, edges } = buildClusterGraph(activeResult, globalCache);
  const boss = { name: String(activeResult.player.name), id: activeResult.player.id, level: activeResult.player.level, score: activeResult.adjustedDetections ?? activeResult.detections, region: activeResult.country, wealthX: bossWealthX, wealth: bossWealth };
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 7 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: '#9fb0d4', textTransform: 'uppercase' }}>Relationship Map</span>
        <span style={{ fontSize: 11, color: '#5d6e96' }}>— the boss at the hub; edges show how the alts are linked</span>
      </div>
      <div style={{ flex: 1, minHeight: 384, border: '1px solid #1f2b4e', borderRadius: 10, background: '#0c1226', overflow: 'hidden' }}>
        {nodes.length >= 1
          ? <ClusterMap boss={boss} nodes={nodes} edges={edges} />
          : <div style={{ height: '100%', minHeight: 384, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#5d6e96', gap: 8, textAlign: 'center', padding: 24 }}>
              <Network size={30} style={{ opacity: 0.25 }} />
              <div style={{ fontSize: 12 }}>No linked-account cluster for this suspect.</div>
              <div style={{ fontSize: 11, opacity: 0.7 }}>Flags here come from solo or transaction-level signals — see the detail below.</div>
            </div>}
      </div>
    </div>
  );
};

// Sidebar beside the map: identity, verdict, summary, actions, signal ledger.
const MapSidebar = ({ activeResult, isWatching, onWatch, onRescan, onReport, onCopy, copied, workforceSize }) => {
  const sc = activeResult.adjustedDetections ?? activeResult.detections;
  const tier = plScoreTier(sc);
  const ringCount = Object.keys(activeResult.washPartners || {}).length;
  const verdict = ringCount > 0
    ? { txt: `WASH RING · ${ringCount + 1} ACCOUNTS`, tier: 'crit' }
    : workforceSize >= 2
      ? { txt: `SUSPECTED WORKFORCE · ${workforceSize} ALTS`, tier: 'crit' }
      : { txt: tier === 'crit' ? 'HIGH-CONFIDENCE FLAG' : tier === 'high' ? 'NOTABLE SIGNALS' : 'SUPPORTING SIGNALS', tier };
  const btn = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '7px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' };
  return (
    <div style={{ width: 322, flex: '0 0 auto', alignSelf: 'stretch', background: '#0c1226', border: '1px solid #1f2b4e', borderRadius: 10, padding: '15px 16px', display: 'flex', flexDirection: 'column', gap: 12, marginTop: 25 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
          <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 18, fontWeight: 700, color: '#eaf0ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(activeResult.player.name)}</span>
          <a href={`https://app.warera.io/user/${activeResult.player.id}`} target="_blank" rel="noopener noreferrer" style={{ color: '#5d6e96', flexShrink: 0 }}><ExternalLink size={13} /></a>
          <div style={{ marginLeft: 'auto', padding: '4px 11px', background: PL_SEV[tier].bg, border: `2px solid ${PL_SEV[tier].line}`, borderRadius: 8, textAlign: 'center', flexShrink: 0 }}>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 17, fontWeight: 700, color: PL_SEV[tier].c }}>{sc}</span>
          </div>
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 9, fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em', color: PL_SEV[verdict.tier].c, background: PL_SEV[verdict.tier].bg, border: `1px solid ${PL_SEV[verdict.tier].line}`, borderRadius: 5, padding: '3px 8px' }}>{verdict.txt}</div>
        <div style={{ fontSize: 11, color: '#5d6e96', marginBottom: 8 }}>{activeResult.country}{activeResult.player.level && <span style={{ fontFamily: "IBM Plex Mono, monospace" }}> · Lv.{activeResult.player.level}</span>}{activeResult.player.isBanned && <span style={{ marginLeft: 6, color: '#ff5d6c', fontWeight: 700 }}>BANNED</span>}</div>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: '#9fb0d4' }}>{String(activeResult.summary)}</p>
        {activeResult.phase2Status === 'pending' && <p style={{ marginTop: 8, fontSize: 11, color: '#4fc3e8' }}>Worker analysis pending.</p>}
        {activeResult.phase2Status === 'running' && <p style={{ marginTop: 8, fontSize: 11, color: '#9fb0d4' }}>Fetching companies and workers…</p>}
        {activeResult.phase2Status === 'error' && <p style={{ marginTop: 8, fontSize: 11, color: '#ff5d6c' }}>Worker analysis failed — only transaction flags shown.</p>}
      </div>
      <div style={{ display: 'flex', gap: 7 }}>
        <button onClick={onReport} style={{ ...btn, flex: 1, background: '#4fc3e8', color: '#06121a', border: '1px solid #4fc3e8' }}><Download size={12} /> Report</button>
        <button onClick={onWatch} style={{ ...btn, background: isWatching ? 'rgba(255,171,61,0.20)' : '#121b35', color: isWatching ? '#ffab3d' : '#9fb0d4', border: `1px solid ${isWatching ? 'rgba(255,171,61,0.50)' : '#2e3f6a'}` }}><Star size={12} /> Watch</button>
        <button onClick={onRescan} style={{ ...btn, background: '#121b35', color: '#9fb0d4', border: '1px solid #2e3f6a' }}><RefreshCw size={12} /> Rescan</button>
      </div>
      {onCopy && <button onClick={onCopy} style={{ ...btn, width: '100%', background: copied ? 'rgba(63,208,163,0.12)' : 'transparent', color: copied ? '#3fd0a3' : '#5d6e96', border: `1px solid ${copied ? 'rgba(63,208,163,0.40)' : '#1f2b4e'}`, fontSize: 10.5, marginTop: -4 }}><CheckSquare size={11} /> {copied ? 'Copied!' : 'Copy 500-char summary'}</button>}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', color: '#9fb0d4', marginBottom: 8, textTransform: 'uppercase' }}>Signal Ledger</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {(activeResult.suspicions || []).map((s, i) => {
            const st = PL_SEV[plSevTier(s.severity)];
            const title = String(s.type).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            const count = s.workers?.length || s.partners?.length || 1;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#121b35', border: '1px solid #1f2b4e', borderLeft: `3px solid ${st.c}`, borderRadius: 6, padding: '6px 10px' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: st.c, flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 600, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#eaf0ff' }}>{title}</span>
                <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, fontWeight: 700, color: st.c }}>×{count}</span>
              </div>
            );
          })}
          {(!activeResult.suspicions || activeResult.suspicions.length === 0) && <div style={{ fontSize: 11, color: '#5d6e96' }}>No signals recorded.</div>}
        </div>
      </div>
    </div>
  );
};

// Engagement network — tipper cards with share-of-received / share-of-own bars.
const EngagementNetwork = ({ activeResult, names }) => {
  const sus = (activeResult.suspicions || []).find(s => s.type === 'tip_farming');
  if (!sus) return null;
  const counts = sus.tipperCounts || {};
  const ids = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 6);
  if (!ids.length) return null;
  const total = sus.totalTipsReceived || 0;
  return (
    <div style={{ padding: '0 24px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: '#9fb0d4', textTransform: 'uppercase' }}>Engagement Network</span>
        <span style={{ fontSize: 9.5, fontWeight: 700, color: '#ffd84d', background: 'rgba(255,216,77,0.11)', border: '1px solid rgba(255,216,77,0.36)', borderRadius: 4, padding: '1px 6px' }}>MEDIUM</span>
        <span style={{ fontSize: 11, color: '#5d6e96' }}>— who is tipping {String(activeResult.player.name)}, and how concentrated their tipping is</span>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {ids.map(id => {
          const cnt = counts[id];
          // "of their own tipping" = coins this tipper gave the suspect ÷ the tipper's
          // total tip coins sent anywhere (both in coins; the count alone has no total).
          const given = sus.tipperAmounts?.[id] || 0;
          const sentTotal = sus.tipperSentTotals?.[id] || 0;
          const recvPct = total > 0 ? Math.round(cnt / total * 100) : 0;
          const ownPct = sentTotal > 0 ? Math.round(given / sentTotal * 100) : 0;
          const conc = ownPct >= 75;
          const nm = names?.[id] || ('user_' + String(id).slice(-6));
          const Bar = ({ pct, color }) => <div style={{ height: 4, background: '#060a16', borderRadius: 99, overflow: 'hidden' }}><div style={{ width: Math.min(100, pct) + '%', height: '100%', background: color, borderRadius: 99 }} /></div>;
          return (
            <a key={id} href={`https://app.warera.io/user/${id}`} target="_blank" rel="noopener noreferrer" style={{ flex: '1 1 160px', minWidth: 160, background: '#0c1226', border: '1px solid #1f2b4e', borderRadius: 8, padding: '10px 13px', textDecoration: 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9 }}>
                <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 12.5, color: '#4fc3e8', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nm}</span>
                <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 9.5, color: '#5d6e96', marginLeft: 'auto', flexShrink: 0 }}>{cnt} tips</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}><span style={{ fontSize: 10, color: '#5d6e96' }}>of received tips</span><span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11, fontWeight: 700, color: '#9fb0d4' }}>{recvPct}%</span></div>
              <div style={{ marginBottom: 8 }}><Bar pct={recvPct} color="#9fb0d4" /></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}><span style={{ fontSize: 10, color: '#5d6e96' }}>of their own tipping</span><span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11, fontWeight: 700, color: conc ? '#ffab3d' : '#9fb0d4' }}>{ownPct}%</span></div>
              <Bar pct={ownPct} color={conc ? '#ffab3d' : '#9fb0d4'} />
            </a>
          );
        })}
      </div>
    </div>
  );
};

const WashNetworkTree = ({ rootId, washPartners, processedNodes, globalBans, globalNames, isRoot=true, edgeFromParent=null }) => {
  if (processedNodes.has(rootId)) return null;
  processedNodes.add(rootId);
  const partnersObj = washPartners[rootId] || {};
  const partners = Object.entries(partnersObj).map(([id, data]) => ({ id, ...data }));
  const rootName = globalNames[rootId] || rootId;
  const isBanned = globalBans[rootId];
  let rootBadge = null;
  if (isRoot) {
    let totalTrades=0, bossNetProfit=0;
    partners.forEach(p => { totalTrades+=(p.txCount||0); bossNetProfit+=(p.netProfit||0); });
    if (totalTrades > 0) {
      let bossProfitNode, bossBadgeClass="bg-slate-800 text-slate-300 border-slate-700";
      if (Math.abs(bossNetProfit)<0.01) { bossProfitNode="0.0 NET"; }
      else if (bossNetProfit>0) { bossProfitNode=`+${bossNetProfit.toFixed(1)} GAINED`; bossBadgeClass="bg-green-900/40 text-green-400 border-green-700/50"; }
      else { bossProfitNode=`-${Math.abs(bossNetProfit).toFixed(1)} LOST`; bossBadgeClass="bg-red-900/40 text-red-400 border-red-700/50"; }
      rootBadge = <div className={`px-2 py-1 rounded text-[10px] font-mono border font-bold tracking-wider flex items-center gap-1 ${bossBadgeClass}`}>[WASH: {totalTrades} TRADES | {bossProfitNode} <Coins size={10} className="inline -mt-0.5"/>]</div>;
    }
  } else if (edgeFromParent) {
    const partnerProfit = -(edgeFromParent.netProfit || 0);
    if (Math.abs(partnerProfit) < 0.01) return null;
    let profitNode, badgeClass="bg-slate-800 text-slate-300 border-slate-700";
    if (partnerProfit>0) { profitNode=`+${partnerProfit.toFixed(1)} GAINED`; badgeClass="bg-green-900/40 text-green-400 border-green-700/50"; }
    else { profitNode=`-${Math.abs(partnerProfit).toFixed(1)} LOST`; badgeClass="bg-red-900/40 text-red-400 border-red-700/50"; }
    rootBadge = <div className={`px-2 py-1 rounded text-[10px] font-mono border font-bold tracking-wider flex items-center gap-1 ${badgeClass}`}>[WASH: {edgeFromParent.txCount} TRADES | {profitNode} <Coins size={10} className="inline -mt-0.5"/>]</div>;
  }
  const validPartners = partners.filter(p => !processedNodes.has(p.id) && Math.abs(p.netProfit||0) >= 0.01);
  return (
    <div className="flex flex-col relative">
      <div className="flex items-center gap-3 relative z-10">
        {!isRoot && <div className="absolute -left-6 top-1/2 w-6 border-t border-slate-700"></div>}
        <a href={`https://app.warera.io/user/${rootId}`} target="_blank" rel="noopener noreferrer" className={`border ${isRoot?'border-amber-600/50 bg-amber-900/20 text-amber-500':'border-slate-700 bg-slate-900 text-slate-300'} px-3 py-1.5 rounded font-mono text-sm flex items-center gap-2 hover:border-blue-500 transition-colors z-10 bg-slate-950`}>
          <span className={isRoot?"font-bold":""}>{rootName}</span>
          {isBanned && <span className="bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded text-[10px] border border-red-700/50 font-bold uppercase tracking-wider">Banned</span>}
          <ExternalLink size={12} className="opacity-70 shrink-0" />
        </a>
        {rootBadge}
      </div>
      {validPartners.length > 0 && (
        <div className="pl-6 border-l border-slate-700 ml-4 mt-3 flex flex-col gap-3 relative">
          {validPartners.map(p => <WashNetworkTree key={p.id} rootId={p.id} washPartners={washPartners} processedNodes={new Set(processedNodes)} globalBans={globalBans} globalNames={globalNames} isRoot={false} edgeFromParent={p}/>)}
        </div>
      )}
    </div>
  );
};

const TreeNode = ({ label, icon: Icon, children, isRoot=false, defaultOpen=false, badge=null, badgeClass=null, extraData=null, linkId=null }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className={`ml-${isRoot?'0':'4'} mt-1 border-l border-slate-700 pl-2`}>
      <div className={`flex items-center gap-2 py-1.5 px-2 rounded hover:bg-slate-800 cursor-pointer text-sm ${isRoot?'font-semibold text-slate-100':'text-slate-300'}`} onClick={() => setIsOpen(!isOpen)}>
        {children ? (isOpen ? <ChevronDown size={14} className="text-slate-500 shrink-0"/> : <ChevronRight size={14} className="text-slate-500 shrink-0"/>) : <span className="w-[14px] shrink-0"></span>}
        {Icon && <Icon size={14} className={`shrink-0 ${isRoot?"text-blue-400":"text-slate-400"}`}/>}
        <span className="flex-1 flex items-center min-w-0">
          {linkId ? (
            <a href={`https://app.warera.io/user/${linkId}`} target="_blank" rel="noopener noreferrer" className="hover:text-blue-400 hover:underline flex items-center gap-1 w-fit truncate" onClick={e=>e.stopPropagation()}>
              <span className="truncate">{label}</span><ExternalLink size={10} className="shrink-0"/>
            </a>
          ) : <span className="truncate">{label}</span>}
        </span>
        {badge && <span className={`text-xs px-2 py-0.5 rounded-full font-mono border whitespace-nowrap shrink-0 ${badgeClass||'bg-red-900/50 text-red-400 border-red-800'}`}>{badge}</span>}
        {extraData && <span className="text-xs text-slate-500 font-mono whitespace-nowrap shrink-0">{extraData}</span>}
      </div>
      {isOpen && children && <div className="ml-2 animate-in slide-in-from-top-1 duration-200">{children}</div>}
    </div>
  );
};

const ScoreTooltip = ({ breakdown }) => {
  const [open, setOpen] = useState(false);
  if (!breakdown || breakdown.length === 0) return null;
  const severityColor = { critical: 'text-red-400', high: 'text-orange-400', medium: 'text-yellow-400', low: 'text-slate-400' };
  return (
    <span className="relative inline-block" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <Info size={12} className="text-slate-500 hover:text-slate-300 cursor-help ml-1 inline -mt-0.5" />
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-600 rounded shadow-xl z-50 min-w-[220px] p-2 text-[11px]">
          <div className="font-bold text-slate-300 mb-2 border-b border-slate-700 pb-1">Score Breakdown</div>
          {breakdown.map((b, i) => (
            <div key={i} className="flex justify-between items-center py-0.5">
              <span className={`${severityColor[b.severity]||'text-slate-400'} capitalize`}>{b.type.replace(/_/g,' ')}</span>
              <span className="font-mono text-slate-300 font-bold">+{b.weight}</span>
            </div>
          ))}
          <div className="border-t border-slate-700 mt-1 pt-1 flex justify-between font-bold text-slate-200">
            <span>Total</span>
            <span>{breakdown.reduce((a,b)=>a+b.weight,0)}</span>
          </div>
        </div>
      )}
    </span>
  );
};

const ActivityHeatmap = ({ hourBuckets }) => {
  if (!hourBuckets) return null;
  const max = Math.max(...hourBuckets, 1);
  return (
    <div className="mt-2">
      <div className="text-[10px] text-slate-500 mb-1">UTC Hour Activity (0-23)</div>
      <div className="flex gap-0.5">
        {hourBuckets.map((v, h) => {
          const intensity = v / max;
          const bg = intensity === 0 ? 'bg-slate-900' : intensity < 0.3 ? 'bg-pink-900/40' : intensity < 0.6 ? 'bg-pink-700/60' : 'bg-pink-500';
          return <div key={h} className={`h-6 flex-1 rounded-sm ${bg} relative group`} title={`UTC ${h}:00 - ${v} actions`}><div className="hidden group-hover:block absolute bottom-full left-1/2 -translate-x-1/2 bg-slate-800 text-slate-200 text-[9px] px-1 rounded whitespace-nowrap">{h}:00 ({v})</div></div>;
        })}
      </div>
    </div>
  );
};

export function WarEraOracle() {
  const [isScanning, setIsScanning] = useState(false);
  const isScanningRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [currentTask, setCurrentTask] = useState('Idle');
  const [logs, setLogs] = useState([]);
  const [findings, setFindings] = useState({});
  const [settings, setSettings] = useState({
    suspiciousWageThreshold: 0.110,
    concurrencyLimit: 50,
    wealthAnomalyMultiplier: 1.5,
    wealthAnomalyLowerMultiplier: 0.5,
    sniperThresholdMs: 1000,
    apmWindowMs: 500,
    pacingToleranceMs: 3,
    pacingMinHits: 6,
    verboseDebug: false,
    phase2AutoThreshold: 3,
  });
  
  const [apiKey, setApiKey] = useState(() => {
    try { return localStorage.getItem('wera_api_key') || ''; } catch { return ''; }
  });
  useEffect(() => { localStorage.setItem('wera_api_key', apiKey); }, [apiKey]);

  const [targetUserId, setTargetUserId] = useState('');
  const [availableRegions, setAvailableRegions] = useState([]);
  const [targetRegionId, setTargetRegionId] = useState('');
  const gatewayTokens = useRef([]);
  const officialTokens = useRef([]);
  const [tick, setTick] = useState(0);
  const [isRateLimited, setIsRateLimited] = useState(false);
  const [limitTimer, setLimitTimer] = useState(0);
  const [showLogs, setShowLogs] = useState(false);
  const gatewayFails = useRef(0);
  const isGatewayDead = useRef(false);
  const globalRateLimitRelease = useRef(0);
  const logsContainerRef = useRef(null);
  
  const globalCacheRef = useRef({ 
    countries: {}, 
    regions: {}, 
    names: {}, 
    requestDeduper: new Map(), 
    wealthByLevel: {}
  });
  
  const globalWashPartners = useRef({});
  const globalBans = useRef({});
  const globalHermitPrimaries = useRef({});
  const phase2DataRef = useRef({});
  const didLogTipPayloadRef = useRef(false);
  const didLogUserLiteShapeRef = useRef(false);
  const didLogWorkerShapeRef = useRef(false);
  const effectiveConcurrencyRef = useRef(50);
  const concurrencyLastReducedRef = useRef(0);
  const alwaysPhase2Ref = useRef(false);
  const scanQueueRef = useRef([]);
  const successfulWorkerEndpointRef = useRef(null);
  const successfulWorkerSchemaRef = useRef(null);
  const workerEndpointDiscoveryPromiseRef = useRef(null);
  const txHealthRef = useRef({ ok: 0, fail: 0, warned: false });

  const [listFilter, setListFilter] = useState('all');
  const [activeSuspectId, setActiveSuspectId] = useState(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [logExpanded, setLogExpanded] = useState(false);
  const [listSearch, setListSearch] = useState('');

  const [savedSession, setSavedSession] = useState(null);
  const [showRestorePrompt, setShowRestorePrompt] = useState(false);

  const [watchlist, setWatchlist] = useState(() => {
    try { return JSON.parse(localStorage.getItem('wera_watchlist') || '{}'); } catch { return {}; }
  });
  const [showWatchlist, setShowWatchlist] = useState(false);
  const watchlistScanRef = useRef(false);

  const fileInputRef = useRef(null);
  const [copiedId, setCopiedId] = useState(null);

  const addLog = useCallback((msg, type='info') => {
    if (type === 'debug' && !settings.verboseDebug) return;
    setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), msg, type }]);
  }, [settings.verboseDebug]);

  // Logs a per-user wealth check against the level baseline, for EVERY scanned user.
  // Takes the raw profile and resolves wealth/level itself so it prints even when
  // the API omits the expected userWealth field. Call BEFORE recordWealthBaseline
  // so the user is never averaged against themselves.
  const logUserWealth = useCallback((name, uData) => {
    const wealth = extractCoinWealth(uData);
    const level = extractUserLevel(uData);
    if (wealth == null) { addLog(`${name}: no wealth field found in profile.`, 'info'); return; }
    if (level == null) { addLog(`${name}: User wealth -${Math.round(wealth)}- Coins, level unknown.`, 'info'); return; }
    const avgResult = getWealthAverageExtended(globalCacheRef.current, level);
    const avg = avgResult ? avgResult.avg : null;
    if (avg == null) {
      addLog(`${name}: User wealth -${Math.round(wealth)}- Coins, no average wealth for level ${level} yet (baseline empty).`, 'info');
      return;
    }
    const pct = avg !== 0 ? Math.round((wealth / avg) * 100) : 0;
    addLog(`${name}: User wealth -${Math.round(wealth)}- Coins, average wealth for level >${level}< is -${Math.round(avg)}- Coins. User wealth is ${pct}% of the average.`, 'info');
  }, [addLog]);

  useEffect(() => {
    if ((showLogs || logExpanded) && logsContainerRef.current) logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
  }, [logs, showLogs, logExpanded]);

  useEffect(() => { localStorage.setItem('wera_watchlist', JSON.stringify(watchlist)); }, [watchlist]);

  useEffect(() => {
    if (activeSuspectId === null) {
      const first = Object.values(findings).flat()[0];
      if (first) setActiveSuspectId(first.player.id);
    }
  }, [findings, activeSuspectId]);

  const toggleWatchlist = useCallback((playerId, playerName, country) => {
    setWatchlist(prev => {
      const next = { ...prev };
      if (next[playerId]) { delete next[playerId]; } else { next[playerId] = { id: playerId, name: playerName, country: country || 'Unknown' }; }
      return next;
    });
  }, []);

  useEffect(() => {
    const ticker = setInterval(() => setTick(t => t+1), 250);
    return () => clearInterval(ticker);
  }, []);

  useEffect(() => {
    if (apiKey && apiKey.trim().length > 20 && availableRegions.length === 0 && !isScanning) fetchRegions();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('warera_oracle_session');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.findings && Object.keys(parsed.findings).length > 0) {
          setSavedSession(parsed);
          setShowRestorePrompt(true);
        }
      }
    } catch(e) {}
  }, []);

  useEffect(() => {
    if (Object.keys(findings).length > 0) {
      try {
        sessionStorage.setItem('warera_oracle_session', JSON.stringify({ findings, savedAt: Date.now() }));
      } catch(e) {}
    }
  }, [findings]);

  const getToken = async (forceOfficial=false) => {
    const startWait = Date.now();
    while (isScanningRef.current) {
      // Hard safety: never spin forever waiting for capacity (a saturated bucket or a
      // stuck global pause). Throwing lets the caller fail and unblocks phase 2.
      if (Date.now() - startWait > 60000) throw new Error("API capacity timeout");
      while (globalRateLimitRelease.current > Date.now()) {
        if (!isScanningRef.current) throw new Error("Scan Aborted");
        if (Date.now() - startWait > 60000) throw new Error("API capacity timeout");
        const waitMs = globalRateLimitRelease.current - Date.now();
        setIsRateLimited(true);
        setLimitTimer(Math.ceil(waitMs / 1000));
        setCurrentTask(`PAUSED: API COOLDOWN (${Math.ceil(waitMs/1000)}s remaining)`);
        await new Promise(r => setTimeout(r, 500));
      }
      if (isRateLimited) {
        setIsRateLimited(false);
        setCurrentTask(`Executing Concurrency Pool (x${effectiveConcurrencyRef.current})...`);
      }
      const now = Date.now();
      gatewayTokens.current = gatewayTokens.current.filter(t => now-t < 60000);
      officialTokens.current = officialTokens.current.filter(t => now-t < 60000);
      setTick(t => t+1);
      const isOfficialEnabled = apiKey && apiKey.trim() !== '';
      let gCapacity = (3500 - gatewayTokens.current.length) / 3500;
      let oCapacity = isOfficialEnabled ? ((400 - officialTokens.current.length) / 400) : 0;
      if (forceOfficial) gCapacity = -1;
      if (isGatewayDead.current) gCapacity = -1;
      if (gCapacity > 0 || oCapacity > 0) {
        if (oCapacity > gCapacity) { officialTokens.current.push(now); setTick(t=>t+1); return 'official'; }
        else { gatewayTokens.current.push(now); setTick(t=>t+1); return 'gateway'; }
      }
      const gNext = gatewayTokens.current[0] || Infinity;
      const oNext = isOfficialEnabled ? (officialTokens.current[0] || Infinity) : Infinity;
      let nextExpire = forceOfficial ? oNext : Math.min(gNext, oNext);
      if (nextExpire === Infinity) nextExpire = now;
      const waitMs = Math.max(10, 60000 - (now - nextExpire) + 10);
      
      if (globalRateLimitRelease.current < Date.now() + waitMs) {
          globalRateLimitRelease.current = Date.now() + waitMs;
      }
    }
    throw new Error("Scan Aborted");
  };

  const smartFetch = async (endpoint, payload, forceOfficial=false) => {
    // worker.* and transaction.* both authenticate fine with the user's API key on
    // either backend, so they use the normal gateway-first / official-fallback routing
    // — no special-casing. A gateway burst-401 just falls back to the official API.
    const cacheKey = endpoint + JSON.stringify(payload);
    
    if (globalCacheRef.current.requestDeduper.has(cacheKey)) {
        return await globalCacheRef.current.requestDeduper.get(cacheKey);
    }

    const executeFetch = async () => {
      let currentForceOfficial = forceOfficial;
      while(true) {
        if (!isScanningRef.current) throw new Error("Scan Aborted");

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 1500);
          const cacheRes = await fetch('/api/cache', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint, payload, forceOfficial: currentForceOfficial, apiKey: apiKey.trim() }),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          if (cacheRes.ok) {
            const cacheJson = await cacheRes.json();
            if (cacheJson?.data !== undefined) {
              let d = cacheJson.data;
              if (Array.isArray(d) && d.length > 0 && typeof d[0] === 'string') { try { d = JSON.parse(d[0]); } catch { } }
              return d;
            }
          }
        } catch(e) { }

        let route;
        if (isScanningRef.current) { route = await getToken(currentForceOfficial); }
        else { route = currentForceOfficial ? 'official' : (isGatewayDead.current ? 'official' : 'gateway'); }
        const baseUrl = route === 'gateway' ? 'https://gateway.warerastats.io/trpc/' : 'https://api2.warera.io/trpc/';
        const activeKey = apiKey.trim();
        try {
          let result = await WarEraAPI.fetch(endpoint, payload, activeKey, baseUrl);
          if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'string') {
            try { result = JSON.parse(result[0]); } catch { }
          }
          // A good gateway response clears the failure streak so only *consecutive*
          // failures (a real outage) can trip the breaker, not sporadic blips.
          if (route === 'gateway') gatewayFails.current = 0;
          return result;
        } catch (e) {
          if (e.message.includes('RATE LIMIT')) {
            const nowMs = Date.now();
            if (globalRateLimitRelease.current < nowMs + 10000) {
              globalRateLimitRelease.current = nowMs + 10000;
              addLog(`[WARNING] HTTP 429 on ${route.toUpperCase()}. Pausing all threads...`, 'warning');
            }
            while (globalRateLimitRelease.current > Date.now()) {
              if (!isScanningRef.current) throw new Error("Scan Aborted");
              await new Promise(r => setTimeout(r, 500));
            }
            await new Promise(r => setTimeout(r, Math.random() * 2000));
            continue;
          }
          const msg = e.message.toLowerCase();
          const isSchemaErr = msg.includes('no procedure') || msg.includes('too_big') || msg.includes('unrecognized key') || msg.includes('invalid_type') || msg.includes('unknown method') || msg.includes('unsupported gateway route');
          const isAuthErr = msg.includes('api token required') || msg.includes('missing x-api-key') || msg.includes('unauthorized') || msg.includes('http 401') || msg.includes('401:');
          const isDbSaturation = msg.includes('sqlstate 53300') || msg.includes('too many clients');

          // Gateway DB pool exhausted under load — reduce concurrency and back off. For
          // gateway-only endpoints (transaction.*) retry the gateway (official 401s);
          // otherwise offload this call to the official API.
          if (route === 'gateway' && isDbSaturation) {
            const cur = effectiveConcurrencyRef.current;
            const nowMs = Date.now();
            if (nowMs - concurrencyLastReducedRef.current > 15000) {
              const next = cur > 25 ? 25 : cur > 12 ? 12 : cur;
              if (next < cur) {
                effectiveConcurrencyRef.current = next;
                concurrencyLastReducedRef.current = nowMs;
                addLog(`[GATEWAY] DB saturated - reducing concurrency ${cur} -> ${next} (15s cooldown active)`, 'warning');
              }
            }
            await new Promise(r => setTimeout(r, 500 + Math.random() * 2000));
            currentForceOfficial = true;
            continue;
          }

          if (route === 'gateway' && isAuthErr) {
            await new Promise(r => setTimeout(r, Math.random() * 500));
            currentForceOfficial = true;
            continue;
          }
          if (route === 'gateway' && !isSchemaErr) {
            gatewayFails.current += 1;
            if (gatewayFails.current >= 4 && !isGatewayDead.current) {
              isGatewayDead.current = true;
              addLog(`[CRITICAL] Gateway failed 4 times. Circuit Breaker tripped. Falling back to Official API.`, 'warning');
              setTimeout(() => { if (isScanningRef.current) { isGatewayDead.current=false; gatewayFails.current=0; addLog(`[INFO] Gateway routing resurrected.`, 'info'); } }, 60000);
            } else if (!isGatewayDead.current) {
              addLog(`[GATEWAY] Miss #${gatewayFails.current} on ${endpoint}: ${e.message.split('\n')[0]}`, 'info');
            }
            const isOfficialEnabled = apiKey && apiKey.trim() !== '';
            if (!isOfficialEnabled) throw new Error("Gateway failed and no Live API Key provided for fallback.");
            await new Promise(r => setTimeout(r, Math.random() * 2000));
            currentForceOfficial = true;
            continue;
          }
          throw e;
        }
      }
    };

    const fetchPromise = executeFetch();
    globalCacheRef.current.requestDeduper.set(cacheKey, fetchPromise);
    
    try {
      const result = await fetchPromise;
      setTimeout(() => { if (globalCacheRef.current.requestDeduper) globalCacheRef.current.requestDeduper.delete(cacheKey); }, 60000);
      return result;
    } catch (err) {
      globalCacheRef.current.requestDeduper.delete(cacheKey);
      throw err;
    }
  };

  const fetchRegions = async () => {
    addLog('Pinging WarEra API for regions...', 'info');
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey && apiKey.trim()) headers['X-API-Key'] = apiKey.trim();

    const directFetch = async (endpoint, payload = {}) => {
      for (const [baseUrl, isGateway] of [
        ['https://gateway.warerastats.io/trpc/', true],
        ['https://api2.warera.io/trpc/', false],
      ]) {
        try {
          const url = `${baseUrl}${endpoint}`;
          let res;
          if (isGateway) {
            res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
          } else {
            const input = encodeURIComponent(JSON.stringify({ '0': payload }));
            res = await fetch(`${url}?batch=1&input=${input}`, { headers });
          }
          if (!res.ok) continue;
          const text = await res.text();
          const json = JSON.parse(text);
          const obj = Array.isArray(json) ? json[0] : json;
          if (obj?.error) continue;
          return obj?.result?.data?.json ?? obj?.result?.data ?? obj;
        } catch(e) { }
      }
      throw new Error(`${endpoint} unreachable`);
    };

    try {
      const countriesData = await directFetch('country.getAllCountries');
      let countries = Array.isArray(countriesData)
        ? countriesData
        : (countriesData?.countries || Object.values(countriesData || {}));
      countries = countries.flat().filter(r => r && r.name);

      if (countries.length === 0) {
        addLog('[DEBUG] country.getAllCountries returned no data', 'debug');
        return;
      }

      countries.sort((a,b) => a.name.localeCompare(b.name));
      setAvailableRegions(countries);
      setTargetRegionId(countries[0]._id || countries[0].id);
      countries.forEach(c => globalCacheRef.current.countries[c._id || c.id] = c);
      addLog(`✅ ${countries.length} countries loaded.`, 'info');

      try {
        const regData = await directFetch('region.getRegionsObject');
        const regMap = regData && typeof regData === 'object' && !Array.isArray(regData) ? regData : {};
        const regEntries = Object.values(regMap).filter(r => r && typeof r === 'object' && (r._id || r.id));
        regEntries.forEach(r => globalCacheRef.current.regions[r._id || r.id] = r);
        if (regEntries.length > 0) addLog(`✅ ${regEntries.length} regions cached.`, 'info');
      } catch(e) {
        addLog(`[DEBUG] Region cache failed (non-critical): ${e.message}`, 'debug');
      }
    } catch(e) {
      addLog(`[DEBUG] Failed to load countries: ${e.message}`, 'debug');
    }
  };

  const fetchUserCompaniesFull = async (userId) => {
    let parsed = [];
    for (const ep of ['company.getCompanies', 'company.getUserCompanies', 'company.getCompaniesByUserId']) {
      try {
        const data = await smartFetch(ep, { userId });
        let flat = Array.isArray(data) ? data : (data?.companies || Object.values(data||{}));
        flat = flat.flat(3).filter(c => c !== null);
        if (flat.length > 0) { parsed = flat.map(c => typeof c==='string' ? { _id:c.split('|').pop(), id:c.split('|').pop() } : c); break; }
      } catch(e) { addLog(`[DEBUG] Company fetch ${ep} failed for ${userId}`, 'debug'); }
    }
    await Promise.all(parsed.map(async c => {
      if (!isScanningRef.current) return;
      const cId = c._id || c.id;
      if (cId && !c.itemCode) {
        try { const details = await smartFetch('company.getById', { companyId: cId }); if (details) Object.assign(c, details); } catch(e) {}
      }
    }));
    const unique=[]; const seen=new Set();
    for (const c of parsed) { const cid=c._id||c.id; if (cid&&!seen.has(cid)) { seen.add(cid); unique.push(c); } }
    return unique;
  };

  const processPlayerPhase1 = async (playerObj) => {
    const uId = playerObj._id || playerObj.id;
    let foundName = playerObj.username || playerObj.name || playerObj.displayName || playerObj.nickname || playerObj.profile?.username || playerObj.profile?.name || 'Unknown';
    let bossMuId = null, hasMuLeadership = false;

    try {
      const uData = await smartFetch('user.getUserLite', { userId: uId });
      if (uData) {
        foundName = uData.username || uData.name || uData.displayName || uData.nickname || uData.user?.username || uData.user?.name || uData.profile?.username || uData.profile?.name || foundName;
        if (foundName==='Unknown'&&!didLogUserLiteShapeRef.current){didLogUserLiteShapeRef.current=true;addLog(`[INFO] getUserLite shape (first Unknown): ${JSON.stringify(uData).substring(0,300)}`, 'info');}
        playerObj.level = uData.leveling?.level || '?';
        playerObj.accountCreatedAt = uData.createdAt || uData.registeredAt || null;
        playerObj.userWealth = uData.userWealth || uData.rankings?.userWealth || null;
        playerObj.userLevel = uData.userLevel || uData.rankings?.userLevel || null;
        logUserWealth(foundName, uData);
        {
          const _w = extractCoinWealth(uData), _l = extractUserLevel(uData);
          if (_w != null && _l != null) {
            // Self wealth-anomaly pre-check (vs the pre-record baseline, matching the
            // log) so wealthy accounts with no transaction flags still advance to
            // analysis — analyzePhase1 then runs the authoritative detectAgeDateAnomaly.
            const _ar = getWealthAverageExtended(globalCacheRef.current, _l);
            if (_ar && classifyWealth(_w, _l, _ar.avg, settings)) playerObj.wealthAnomalous = true;
            recordWealthBaseline(globalCacheRef.current, _l, _w, uId);
          }
        }
        if (foundName && foundName !== 'Unknown') globalCacheRef.current.names[uId] = foundName;
        if (uData.isBanned || uData.banned) { addLog(`[OK] ${foundName} cleared (banned).`, 'info'); return; }
        bossMuId = uData.mu ? (typeof uData.mu==='object'?uData.mu._id||uData.mu.id:uData.mu) : (uData.militaryUnit?(typeof uData.militaryUnit==='object'?uData.militaryUnit._id||uData.militaryUnit.id:uData.militaryUnit):(uData.muId||null));
      }
    } catch(e) { addLog(`[DEBUG] getUserLite failed for ${uId}: ${e.message}`, 'debug'); }

    if (bossMuId) {
      try {
        const muData = await smartFetch('mu.getById', { muId: bossMuId });
        if (muData) {
          const managers = muData.roles?.managers || [];
          const commanders = muData.roles?.commanders || [];
          if (managers.includes(uId) || commanders.includes(uId)) hasMuLeadership = true;
        }
      } catch(e) {}
    }

    let itemMarketTxs = [];
    const lookbackDays = 60;
    const cutoffTime = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
    try {
      let nextCursor=null, reachedOld=false;
      do {
        if (!isScanningRef.current) break;
        const txPayload = { transactionType: 'itemMarket', userId: uId, limit: 100 };
        if (nextCursor) txPayload.cursor = nextCursor;
        const txData = await smartFetch('transaction.getPaginatedTransactions', txPayload);
        let items = Array.isArray(txData) ? txData : (txData?.items||txData?.data||txData?.transactions||[]);
        for (const tx of items) {
          const txTime = new Date(tx.createdAt||tx.timestamp||tx.date||Date.now()).getTime();
          if (txTime >= cutoffTime) itemMarketTxs.push(tx);
          else reachedOld = true;
        }
        nextCursor = txData?.nextCursor||txData?.meta?.nextCursor||null;
        if (reachedOld || itemMarketTxs.length >= 1000) break;
      } while (nextCursor);
      txHealthRef.current.ok += 1;
    } catch(e) {
      txHealthRef.current.fail += 1;
      // Surface the first transaction failure prominently — otherwise the cause of
      // "no transaction flags" is buried at debug level and looks like a clean scan.
      if (!txHealthRef.current.warned) {
        txHealthRef.current.warned = true;
        addLog(`[CRITICAL] Transaction endpoint failing (${e.message.split('\n')[0]}). ALL transaction-based heuristics (wash trading, laundering, sniper, pacing, hermit, tips) are disabled this scan.`, 'warning');
      }
      addLog(`[DEBUG] itemMarket fetch failed for ${foundName}: ${e.message}`, 'debug');
    }

    const actionTimes = [];
    let sniperHits=0, sniperDetails=[];
    const apmWindowMap = new Map();
    let totalMarketVolume=0;
    const uniqueTradingPartners = new Set();
    const partnerVolumes = new Map(), partnerTxCounts = new Map(), partnerNetFlow = new Map();

    itemMarketTxs.forEach(tx => {
      const sId = typeof tx.seller==='object' ? tx.seller?._id : (tx.sellerId||tx.seller);
      const bId = typeof tx.buyer==='object' ? tx.buyer?._id : (tx.buyerId||tx.buyer);
      if (sId===uId && tx.offerCreatedAt) actionTimes.push({ time: new Date(tx.offerCreatedAt).getTime(), type: 'Market List' });
      if (bId===uId && tx.createdAt) actionTimes.push({ time: new Date(tx.createdAt).getTime(), type: 'Market Buy' });
      if (tx.offerCreatedAt && tx.createdAt) {
        const offerTime = new Date(tx.offerCreatedAt).getTime();
        const buyTime = new Date(tx.createdAt).getTime();
        const timeOnMarketMs = buyTime - offerTime;
        if (timeOnMarketMs > 0 && timeOnMarketMs <= settings.sniperThresholdMs && bId===uId) {
          sniperHits++;
          sniperDetails.push({ itemCode: tx.itemCode||tx.item?.code||'unknown', timeMs: timeOnMarketMs, offerTimeMs: offerTime });
        }
      }
      if (sId===uId && tx.offerCreatedAt) {
        const offerTimeMs = new Date(tx.offerCreatedAt).getTime();
        const timeWindow = Math.floor(offerTimeMs / settings.apmWindowMs);
        if (!apmWindowMap.has(timeWindow)) apmWindowMap.set(timeWindow, []);
        apmWindowMap.get(timeWindow).push({ offerTimeMs, itemCode: tx.itemCode||tx.item?.code||'unknown' });
      }
      let partnerId = (sId===uId) ? bId : sId;
      if (partnerId && partnerId!==uId) uniqueTradingPartners.add(partnerId);
      let amount = tx.money ?? tx.price ?? tx.value ?? 0;
      if (typeof amount==='object'&&amount!==null) amount=amount.amount??amount.value??0;
      amount = parseFloat(amount)||0;
      totalMarketVolume += amount;
      if (partnerId && partnerId!==uId) {
        partnerVolumes.set(partnerId, (partnerVolumes.get(partnerId)||0)+amount);
        partnerTxCounts.set(partnerId, (partnerTxCounts.get(partnerId)||0)+1);
        const flow = (bId===uId) ? amount : -amount;
        partnerNetFlow.set(partnerId, (partnerNetFlow.get(partnerId)||0)+flow);
      }
    });

    let maxConcurrentTxs=0, worstApmWindow=[];
    apmWindowMap.forEach(txs => { if (txs.length > maxConcurrentTxs) { maxConcurrentTxs=txs.length; worstApmWindow=txs; } });
    let apmAvgGapMs=0;
    if (worstApmWindow.length > 1) {
      worstApmWindow.sort((a,b)=>a.offerTimeMs-b.offerTimeMs);
      let tg=0; for(let i=1;i<worstApmWindow.length;i++) tg+=(worstApmWindow[i].offerTimeMs-worstApmWindow[i-1].offerTimeMs);
      apmAvgGapMs = Math.round(tg/(worstApmWindow.length-1));
    }

    const washPartners = {};
    const itemGroups = {};
    itemMarketTxs.forEach(tx => {
      let pseudoItemId;
      if (typeof tx.item==='object'&&tx.item!==null) {
        const itemCode = tx.itemCode||tx.item.code||'unknown';
        const acqTime = tx.item.lastAcquisitionAt||'no_time';
        let statsStr='no_stats';
        if (tx.item.skills) statsStr=Object.entries(tx.item.skills).map(([k,v])=>`${k}:${typeof v==='object'&&v!==null?(v.value??v.total??0):v}`).sort().join('-');
        pseudoItemId=`${itemCode}_${acqTime}_${statsStr}`;
      } else { pseudoItemId=tx.item||tx._id; }
      tx.pseudoItemId=pseudoItemId;
      if (!pseudoItemId) return;
      if (!itemGroups[pseudoItemId]) itemGroups[pseudoItemId]=[];
      itemGroups[pseudoItemId].push(tx);
    });

    Object.entries(itemGroups).forEach(([itemId, txs]) => {
      if (txs.length < 2) return;
      txs.sort((a,b)=>new Date(a.createdAt||0).getTime()-new Date(b.createdAt||0).getTime());
      for (let i=0;i<txs.length-1;i++) {
        const tx1=txs[i];
        const s1=typeof tx1.seller==='object'?tx1.seller?._id:(tx1.sellerId||tx1.seller);
        const b1=typeof tx1.buyer==='object'?tx1.buyer?._id:(tx1.buyerId||tx1.buyer);
        if (s1!==uId&&b1!==uId) continue;
        for (let j=i+1;j<txs.length;j++) {
          const tx2=txs[j];
          const s2=typeof tx2.seller==='object'?tx2.seller?._id:(tx2.sellerId||tx2.seller);
          const b2=typeof tx2.buyer==='object'?tx2.buyer?._id:(tx2.buyerId||tx2.buyer);
          if (s2!==uId&&b2!==uId) continue;
          if (s1===b1||s2===b2) continue;
          let isCircular=false, p1, p2;
          if (s1===uId&&b2===uId) { isCircular=true; p1=b1; p2=s2; }
          else if (b1===uId&&s2===uId) { if (s1===b2) { isCircular=true; p1=s1; p2=b2; } }
          if (isCircular) {
            const isClassic=(p1===p2), threshold=isClassic?1:25;
            const m1=parseFloat(tx1.money||tx1.price||tx1.value||0);
            const m2=parseFloat(tx2.money||tx2.price||tx2.value||0);
            if (m1<threshold||m2<threshold) continue;
            const processLeg=(partnerId,money,txId,txTime,bossIsSeller)=>{
              if (!partnerId||partnerId===uId) return;
              if (!washPartners[partnerId]) washPartners[partnerId]={volume:0,netProfit:0,txCount:0,items:new Set(),latestTrade:0};
              if (!washPartners[partnerId].items.has(txId)) {
                washPartners[partnerId].txCount+=1; washPartners[partnerId].items.add(txId);
                washPartners[partnerId].volume+=money; washPartners[partnerId].latestTrade=Math.max(washPartners[partnerId].latestTrade||0,txTime);
                if (bossIsSeller) washPartners[partnerId].netProfit+=money; else washPartners[partnerId].netProfit-=money;
              }
            };
            processLeg(p1,m1,tx1._id,new Date(tx1.createdAt||0).getTime(),s1===uId);
            processLeg(p2,m2,tx2._id,new Date(tx2.createdAt||0).getTime(),s2===uId);
          }
        }
      }
    });

    for (const partnerId of Object.keys(washPartners)) {
      if (!globalWashPartners.current[uId]) globalWashPartners.current[uId]={};
      globalWashPartners.current[uId][partnerId]={...washPartners[partnerId]};
      try {
        const pData = await smartFetch('user.getUserLite', { userId: partnerId });
        if (pData) {
          washPartners[partnerId].name=pData.username||pData.name||partnerId;
          washPartners[partnerId].level=pData.leveling?.level||'?';
          globalCacheRef.current.names[partnerId]=washPartners[partnerId].name;
          const isPBanned=!!(pData.isBanned||pData.banned||pData.infos?.isBanned);
          washPartners[partnerId].isBanned=isPBanned; globalBans.current[partnerId]=isPBanned;
        }
      } catch(e) { washPartners[partnerId].name=partnerId; washPartners[partnerId].level='?'; }
      if (!playerObj.isSecondaryScan) scanQueueRef.current.push({ _id: partnerId, scanContext: playerObj.scanContext, isSecondaryScan: true });
    }

    let highestVolumeWithSinglePartner=0, hermitTxCount=0, primaryBossId=null;
    partnerVolumes.forEach((vol,pId) => { if (vol>highestVolumeWithSinglePartner) { highestVolumeWithSinglePartner=vol; hermitTxCount=partnerTxCounts.get(pId)||0; primaryBossId=pId; } });
    const centralityPercentage = totalMarketVolume>0?(highestVolumeWithSinglePartner/totalMarketVolume)*100:0;
    const isHermit = totalMarketVolume>=50&&uniqueTradingPartners.size<=3&&centralityPercentage>50&&hermitTxCount>=5;

    if (isHermit && primaryBossId) {
      globalHermitPrimaries.current[uId] = { primaryBossId, volume: highestVolumeWithSinglePartner };
    }
    const partnerHermitData = primaryBossId ? globalHermitPrimaries.current[primaryBossId] : null;
    const isMutualHermit = isHermit && partnerHermitData && partnerHermitData.primaryBossId === uId;

    let hermitBossName=primaryBossId;
    if ((isHermit||isMutualHermit) && primaryBossId) {
      try { const pd=await smartFetch('user.getUserLite',{userId:primaryBossId}); if(pd){hermitBossName=pd.username||pd.name||primaryBossId;globalCacheRef.current.names[primaryBossId]=hermitBossName;} } catch(e){}
    }

    let hermitResaleDetails="";
    if (isHermit && primaryBossId) {
      let netFlow=partnerNetFlow.get(primaryBossId)||0;
      hermitResaleDetails=` | ${netFlow>0?`Funneled ${netFlow.toFixed(1)} Coins TO boss`:`Received ${Math.abs(netFlow).toFixed(1)} Coins FROM boss`}`;
      let itemsSoldToMarketAfter=0,profitFromMarketAfter=0,itemsSoldToBossAfter=0,profitFromBossAfter=0;
      Object.values(itemGroups).forEach(txs => {
        if (txs.length<2) return;
        txs.sort((a,b)=>new Date(a.createdAt||0).getTime()-new Date(b.createdAt||0).getTime());
        for(let i=0;i<txs.length-1;i++){const tx1=txs[i];const s1=typeof tx1.seller==='object'?tx1.seller?._id:(tx1.sellerId||tx1.seller);const b1=typeof tx1.buyer==='object'?tx1.buyer?._id:(tx1.buyerId||tx1.buyer);for(let j=i+1;j<txs.length;j++){const tx2=txs[j];const s2=typeof tx2.seller==='object'?tx2.seller?._id:(tx2.sellerId||tx2.seller);const b2=typeof tx2.buyer==='object'?tx2.buyer?._id:(tx2.buyerId||tx2.buyer);const p1=parseFloat(tx1.money||tx1.price||tx1.value||0);const p2=parseFloat(tx2.money||tx2.price||tx2.value||0);if(s1===primaryBossId&&b1===uId&&s2===uId&&b2 !== primaryBossId){itemsSoldToMarketAfter++;profitFromMarketAfter+=(p2-p1);}if(s1 !== primaryBossId&&b1===uId&&s2===uId&&b2===primaryBossId){itemsSoldToBossAfter++;profitFromBossAfter+=(p2-p1);}}}
      });
      if (itemsSoldToMarketAfter>0) hermitResaleDetails+=` | Resale: ${itemsSoldToMarketAfter} items to Market (Net: ${profitFromMarketAfter>0?'+':''}${profitFromMarketAfter.toFixed(1)})`;
      else if (itemsSoldToBossAfter>0) hermitResaleDetails+=` | Resale: ${itemsSoldToBossAfter} items back to Boss (Net: ${profitFromBossAfter>0?'+':''}${profitFromBossAfter.toFixed(1)})`;
    }

    let isDirectLaunderer=false, directLaunderAmount=0;
    let pacingHits=0, pacingAvgMs=0, pacingEdges=[], pacingSingleType=null;
    let tipAbuse = null;

    {
      const [outTxResult, tipTxResult] = await Promise.allSettled([
        smartFetch('transaction.getPaginatedTransactions', { transactionType: 'donation', userId: uId, limit: 100 }),
        smartFetch('transaction.getPaginatedTransactions', { transactionType: 'articleTip', userId: uId, limit: 100 }),
      ]);

      if (outTxResult.status === 'fulfilled') {
        const outItems = Array.isArray(outTxResult.value) ? outTxResult.value : (outTxResult.value?.items||outTxResult.value?.data||outTxResult.value?.transactions||[]);
        const oneWeekAgo=Date.now()-7*24*60*60*1000;
        let weeklyOutbound=0, maxSingleOutbound=0;
        outItems.forEach(tx => {
          const txTime=new Date(tx.createdAt||tx.timestamp||tx.date||Date.now()).getTime();
          actionTimes.push({ time: txTime, type: 'Donation' });
          if (txTime<cutoffTime) return;
          const senderId=typeof tx.sender==='object'?(tx.sender?._id||tx.sender?.id):(tx.sender||tx.senderId||tx.from||tx.userId);
          if (senderId!==uId) return;
          let amount=tx.amount??tx.quantity??tx.value??tx.gold??tx.money??tx.total;
          if (typeof amount==='object'&&amount!==null) amount=amount.amount??amount.value??amount.quantity??amount.gold??0;
          if (typeof amount!=='number') amount=parseFloat(amount)||0;
          if (amount===0) { const pv=Object.values(tx).filter(v=>typeof v==='number'&&v<1e12&&v>0); if(pv.length>0) amount=Math.max(...pv); }
          if (Math.abs(amount-5)>0.01&&Math.abs(amount-25)>0.01) { directLaunderAmount+=amount; maxSingleOutbound=Math.max(maxSingleOutbound,amount); }
          if (txTime>=oneWeekAgo) weeklyOutbound+=amount;
        });
        if (maxSingleOutbound>25||weeklyOutbound>60) isDirectLaunderer=true;
      }

      if (tipTxResult.status === 'fulfilled') {
        const tipItems = Array.isArray(tipTxResult.value) ? tipTxResult.value : (tipTxResult.value?.items||tipTxResult.value?.data||tipTxResult.value?.transactions||[]);
        if (!didLogTipPayloadRef.current) {
          didLogTipPayloadRef.current = true;
          addLog(`[TIP PAYLOAD] raw top-level: ${JSON.stringify(tipTxResult.value).substring(0, 400)}`, 'info');
          if (tipItems.length > 0) addLog(`[TIP PAYLOAD] item[0]: ${JSON.stringify(tipItems[0])}`, 'info');
        }
        const tipperCounts = {};
        const tipperAmounts = {};
        let totalTipsReceived = 0;
        let totalCoinsReceived = 0;
        tipItems.forEach(tx => {
          const recipientId = typeof tx.recipient==='object' ? (tx.recipient?._id||tx.recipient?.id) : (tx.sellerId||tx.recipientId||tx.receiverId||tx.receiver||tx.toId||tx.to);
          const tipperId = typeof tx.sender==='object' ? (tx.sender?._id||tx.sender?.id) : (tx.buyerId||tx.senderId||tx.sender||tx.fromId||tx.from||tx.authorId);
          if (recipientId===uId && tipperId && tipperId!==uId) {
            const amt = typeof tx.amount==='number' ? tx.amount : typeof tx.coins==='number' ? tx.coins : typeof tx.value==='number' ? tx.value : typeof tx.price==='number' ? tx.price : typeof tx.money==='number' ? tx.money : 0;
            tipperCounts[tipperId] = (tipperCounts[tipperId]||0) + 1;
            tipperAmounts[tipperId] = (tipperAmounts[tipperId]||0) + amt;
            totalTipsReceived++;
            totalCoinsReceived += amt;
          }
        });
        const validTipperIds = Object.keys(tipperCounts).filter(id => tipperCounts[id] >= 5);
        if (Object.keys(tipperCounts).filter(id => tipperCounts[id] >= 10).length >= 1 || validTipperIds.length >= 2) {
          const tipperSentTotals = {};
          const tipperMeta = {};
          // Enrich the top tippers shown in the engagement view (not just the >=5 set),
          // so their names resolve and "of their own tipping" % can be computed.
          const enrichIds = Object.keys(tipperCounts).sort((a, b) => tipperCounts[b] - tipperCounts[a]).slice(0, 8);
          for (const tipperId of enrichIds) {
            try {
              const td = globalCacheRef.current.names[tipperId] ? null : await smartFetch('user.getUserLite', { userId: tipperId });
              if (td) {
                const tName = td.username || td.name || td.displayName || td.nickname || td.user?.username || td.profile?.username || null;
                if (tName) globalCacheRef.current.names[tipperId] = tName;
                tipperMeta[tipperId] = { level: td.leveling?.level ?? td.userLevel?.value ?? null, isBanned: !!(td.isBanned || td.banned || td.infos?.isBanned) };
              }
            } catch { /* best-effort */ }
            try {
              const tipperTxData = await smartFetch('transaction.getPaginatedTransactions', { transactionType: 'articleTip', userId: tipperId, limit: 100 });
              const tipperItems = Array.isArray(tipperTxData) ? tipperTxData : (tipperTxData?.items||tipperTxData?.data||tipperTxData?.transactions||[]);
              let totalSentCoins = 0;
              tipperItems.forEach(tx => {
                const senderId = typeof tx.sender==='object' ? (tx.sender?._id||tx.sender?.id) : (tx.buyerId||tx.senderId||tx.sender||tx.fromId||tx.from||tx.authorId);
                if (senderId === tipperId) {
                    const amt = typeof tx.amount==='number' ? tx.amount : typeof tx.coins==='number' ? tx.coins : typeof tx.value==='number' ? tx.value : typeof tx.price==='number' ? tx.price : typeof tx.money==='number' ? tx.money : 0;
                    totalSentCoins += amt;
                }
              });
              if (totalSentCoins > 0) tipperSentTotals[tipperId] = totalSentCoins;
            } catch { /* best-effort */ }
          }
          const finalHeavy = Object.values(tipperCounts).filter(c => c >= 10).length;
          const finalRepeat = Object.values(tipperCounts).filter(c => c >= 5).length;
          if (finalHeavy >= 1 || finalRepeat >= 2) {
             tipAbuse = { heavyTippers: finalHeavy, repeatTippers: finalRepeat, tipperCounts, tipperAmounts, tipperSentTotals, tipperMeta, totalTipsReceived, totalCoinsReceived };
          }
        }
      } else {
        addLog(`[DEBUG] articleTip fetch failed for ${foundName}: ${tipTxResult.reason?.message}`, 'debug');
      }

      playerObj.isDirectLaunderer=isDirectLaunderer; playerObj.directLaunderAmount=directLaunderAmount;

      const PACING_ACTION_TYPES = new Set(['Donation', 'Market List', 'Market Buy']);
      const pacingTimes = actionTimes.filter(a => PACING_ACTION_TYPES.has(a.type));
      pacingTimes.sort((a,b)=>a.time-b.time);
      const seqDeltas=[];
      for(let i=1;i<pacingTimes.length;i++) {
        const d=pacingTimes[i].time-pacingTimes[i-1].time;
        if(d>=100&&d<=60000) seqDeltas.push({ delta:d, start:pacingTimes[i-1].time, end:pacingTimes[i].time, type:pacingTimes[i].type, idx:i });
      }
      if (seqDeltas.length >= settings.pacingMinHits) {
        const candidateDeltas = [...new Set(seqDeltas.map(d => Math.round(d.delta / 50) * 50))];
        for (const center of candidateDeltas) {
          let streak=[], bestStreak=[];
          for (const gap of seqDeltas) {
            if (Math.abs(gap.delta - center) <= settings.pacingToleranceMs) { streak.push(gap); }
            else { if (streak.length > bestStreak.length) bestStreak = streak; streak = []; }
          }
          if (streak.length > bestStreak.length) bestStreak = streak;
          if (bestStreak.length > pacingHits) {
            pacingHits = bestStreak.length;
            pacingAvgMs = Math.round(bestStreak.reduce((s,g)=>s+g.delta,0)/bestStreak.length);
            pacingEdges = bestStreak;
          }
        }
        if (pacingHits >= settings.pacingMinHits) {
          const types=pacingEdges.map(e=>e.type);
          const typeSet=new Set(types);
          if (typeSet.size===1) pacingSingleType=[...typeSet][0];
        } else { pacingHits=0; pacingAvgMs=0; pacingEdges=[]; }
      }
      playerObj.pacingHits=pacingHits; playerObj.pacingAvgMs=pacingAvgMs; playerObj.pacingEdges=pacingEdges; playerObj.pacingSingleType=pacingSingleType;
    }

    const hasP1Flags = Object.keys(washPartners).length > 0 || isDirectLaunderer ||
      sniperHits >= 5 || maxConcurrentTxs >= 5 || isHermit || isMutualHermit ||
      pacingHits >= settings.pacingMinHits || tipAbuse !== null || playerObj.wealthAnomalous;

    if (!hasP1Flags && !alwaysPhase2Ref.current) { 
        addLog(`[OK] ${foundName} cleared (no transaction flags).`, 'info'); 
        return; 
    }

    const livePlayer = {
      id: uId, name: foundName, level: playerObj.level, isBanned: playerObj.isBanned, country: playerObj.scanContext||'Unknown Target',
      companies: [],
      washPartners, isDirectLaunderer, directLaunderAmount,
      sniperHits, sniperDetails, maxConcurrentTxs, apmDetails: { avgGapMs: apmAvgGapMs, txs: worstApmWindow },
      pacingHits: playerObj.pacingHits||0, pacingAvgMs: playerObj.pacingAvgMs||0, pacingEdges: playerObj.pacingEdges||[],
      pacingSingleType: playerObj.pacingSingleType||null,
      totalMarketVolume, uniqueTradingPartnersSize: uniqueTradingPartners.size,
      isHermit, isMutualHermit, mutualHermitPartnerName: isMutualHermit ? (globalCacheRef.current.names[primaryBossId]||primaryBossId) : null,
      centralityPercentage, hermitTxCount, hermitResaleDetails, hermitBossId: primaryBossId, hermitBossName,
      accountCreatedAt: playerObj.accountCreatedAt,
      userWealth: playerObj.userWealth,
      userLevel: playerObj.userLevel,
      tipAbuse,
    };

    phase2DataRef.current[uId] = { livePlayer, actionTimes, hasMuLeadership, bossMuId, foundName, country: livePlayer.country };

    const phase1Result = analyzePhase1(livePlayer, settings, globalCacheRef.current, addLog);
    if (phase1Result) {
      phase1Result.phase2Status = 'pending';
      addLog(`[WARNING] Phase 1 flags: ${foundName} (score ${phase1Result.detections})`, 'warning');
      setFindings(prev => {
        const newState = { ...prev };
        if (!newState[livePlayer.country]) newState[livePlayer.country]=[];
        if (!newState[livePlayer.country].some(r=>r.player.id===phase1Result.player.id)) newState[livePlayer.country].push(phase1Result);
        return newState;
      });
      if (alwaysPhase2Ref.current || phase1Result.detections >= 1) {
        await processPlayerPhase2(uId, livePlayer.country, true);
      }
    } else if (alwaysPhase2Ref.current) {
      addLog(`[INFO] ${foundName} - running phase 2 worker analysis.`, 'info');
      const placeholder = {
        player: livePlayer, summary: 'Running worker analysis...', suspicions: [],
        detections: 0, phase2Status: 'running', washPartners: {}, washPartnerCount: 0,
        totalCoinsWashed: 0, zeroBonusCompanyCount: 0, bossNoBonusPercentage: 0,
        hasLaundering: false, launderingWorkerCount: 0, totalLaunderedCoins: 0, scoreBreakdown: []
      };
      setFindings(prev => { const n={...prev}; if (!n[livePlayer.country]) n[livePlayer.country]=[]; n[livePlayer.country].push(placeholder); return n; });
      await processPlayerPhase2(uId, livePlayer.country, true);
    } else {
      addLog(`[OK] ${foundName} cleared.`, 'info');
    }
  };

  const processPlayerPhase2 = async (playerId, country, fromScan = false) => {
    const phase2Data = phase2DataRef.current[playerId];
    if (!phase2Data) { addLog(`[DEBUG] Phase 2 triggered for ${playerId} but no phase 1 data found.`, 'debug'); return; }

    const { livePlayer, actionTimes, hasMuLeadership, bossMuId, foundName } = phase2Data;

    setFindings(prev => {
      const newState = { ...prev };
      if (newState[country]) {
        const idx = newState[country].findIndex(r => r.player.id === playerId);
        if (idx >= 0) newState[country][idx] = { ...newState[country][idx], phase2Status: 'running' };
      }
      return newState;
    });

    addLog(`[INFO] Phase 2 worker analysis: ${foundName}...`, 'info');

    try {
      const parsedCompanies = await fetchUserCompaniesFull(playerId);
      addLog(`[DEBUG] P2 ${foundName}: ${parsedCompanies.length} compan${parsedCompanies.length===1?'y':'ies'} found.`, 'debug');

      if (parsedCompanies.length > 0) {
        await Promise.all(parsedCompanies.map(async company => {
          if (fromScan && !isScanningRef.current) return;
          const cId=company._id||company.id;

          if (!successfulWorkerEndpointRef.current) {
            if (!workerEndpointDiscoveryPromiseRef.current) {
                workerEndpointDiscoveryPromiseRef.current = (async () => {
                    addLog(`[DEBUG] Discovering worker endpoint using company ${cId}...`, 'debug');
                    for (const wep of ['worker.getWorkers','company.getWorkers','company.getEmployees', 'company.getCompanyWorkers']) {
                      try { 
                        const res = await smartFetch(wep, { companyId: cId, limit: 10 }); 
                        if (res) {
                          successfulWorkerEndpointRef.current=wep; 
                          successfulWorkerSchemaRef.current='companyId'; 
                          addLog(`[DEBUG] Worker endpoint found: ${wep} (companyId)`, 'debug');
                          return; 
                        }
                      } catch(e1) {
                        try { 
                          const res2 = await smartFetch(wep, { id: cId, limit: 10 }); 
                          if (res2) {
                            successfulWorkerEndpointRef.current=wep; 
                            successfulWorkerSchemaRef.current='id'; 
                            addLog(`[DEBUG] Worker endpoint found: ${wep} (id)`, 'debug');
                            return; 
                          }
                        } catch(e2) {}
                      }
                    }
                    addLog(`[CRITICAL] Failed to discover valid worker endpoint!`, 'warning');
                })();
            }
            await workerEndpointDiscoveryPromiseRef.current;
          }

          if (!successfulWorkerEndpointRef.current) return;

          const schema=successfulWorkerSchemaRef.current==='companyId'?{companyId:cId, limit:100}:{id:cId, limit:100};
          try {
            const pacingActionTypes = ['openCase', 'craftItem', 'dismantleItem'];
            await Promise.all(pacingActionTypes.map(async (aType) => {
              try {
                const pacingRes = await smartFetch('transaction.getPaginatedTransactions', { transactionType: aType, userId: playerId, limit: 100 });
                const items = Array.isArray(pacingRes) ? pacingRes : (pacingRes?.items||pacingRes?.data||pacingRes?.transactions||[]);
                items.forEach(tx => {
                  const txTime=new Date(tx.createdAt||tx.timestamp||tx.date||Date.now()).getTime();
                  if (!actionTimes.some(a => a.time === txTime && a.type === aType)) {
                    actionTimes.push({ time: txTime, type: aType });
                  }
                });
              } catch(e) {}
            }));

            const rawWorkers=await smartFetch(successfulWorkerEndpointRef.current, schema);
            let flatWorkers=Array.isArray(rawWorkers)?rawWorkers:(rawWorkers?.workers||rawWorkers?.data||rawWorkers?.items||Object.values(rawWorkers||{}));
            flatWorkers=flatWorkers.flat(3).filter(w=>typeof w==='object'&&w!==null);
            
            if (!didLogWorkerShapeRef.current) {
              didLogWorkerShapeRef.current=true;
              const shapeDesc=rawWorkers==null?'null':Array.isArray(rawWorkers)?'array['+rawWorkers.length+']':'obj{'+Object.keys(rawWorkers||{}).slice(0,8).join(',')+'}';
              addLog(`[DEBUG] worker.getWorkers raw: ${shapeDesc} -> ${flatWorkers.length} flat workers`, 'debug');
              if (flatWorkers.length>0) addLog(`[DEBUG] worker[0] keys: ${Object.keys(flatWorkers[0]).slice(0,12).join(',')} | sample: ${JSON.stringify(flatWorkers[0]).substring(0,300)}`, 'debug');
            }
            addLog(`[DEBUG] P2 company ${cId}: ${flatWorkers.length} workers`, 'debug');
            await Promise.all(flatWorkers.map(async w => {
              const rawUser = w.user || w.worker;
              const userId = typeof rawUser === 'string' ? rawUser : (rawUser?._id||rawUser?.id||rawUser?.userId||w.userId||w.playerId||w._id||w.id||null);
              if (typeof rawUser === 'object' && rawUser !== null && (rawUser.username||rawUser.name)) {
                w.resolvedUser = w.resolvedUser || rawUser;
              }
              if (userId) {
                try {
                  const uData = w.resolvedUser?.username ? w.resolvedUser : await smartFetch('user.getUserLite', { userId });
                  if (uData) {
                    w.resolvedUser=uData; w.isBanned=!!(uData.isBanned||uData.banned||uData.infos?.isBanned);
                    if (uData.rankings) { uData.userWealth = uData.userWealth || uData.rankings.userWealth; uData.userLevel = uData.userLevel || uData.rankings.userLevel; }
                    logUserWealth(uData.username||uData.name||userId, uData);
                    { const _w = extractCoinWealth(uData), _l = extractUserLevel(uData); if (_w != null && _l != null) recordWealthBaseline(globalCacheRef.current, _l, _w, userId); }
                    globalCacheRef.current.names[userId]=uData.username||uData.name||userId;
                    let workerMuId=uData.mu?(typeof uData.mu==='object'?uData.mu._id||uData.mu.id:uData.mu):(uData.militaryUnit?(typeof uData.militaryUnit==='object'?uData.militaryUnit._id||uData.militaryUnit.id:uData.militaryUnit):(uData.muId||null));
                    w.workerMuId=workerMuId;
                  }
                  const level=uData?.leveling?.level||1;
                  const isActive=uData?.isActive;
                  if (isActive!==false&&level<30) w.ownedCompanies=await fetchUserCompaniesFull(userId);
                  else w.ownedCompanies=[];
                  
                  if (hasMuLeadership&&bossMuId&&w.workerMuId===bossMuId) {
                    try {
                      const txData=await smartFetch('transaction.getPaginatedTransactions',{userId,muId:bossMuId,transactionType:'donation',limit:100});
                      const items=Array.isArray(txData)?txData:(txData?.items||txData?.data||txData?.transactions||[]);
                      w.muDonations=items;
                    } catch(e) {}
                  }
                } catch(e) { addLog(`[DEBUG] Worker resolve failed ${userId}: ${e.message}`, 'debug'); }
              }
            }));
            company.workers=flatWorkers;
          } catch(err) { addLog(`[DEBUG] Worker fetch failed for company ${cId}: ${err.message}`, 'debug'); }
        }));
      }

      let pacingHits=0, pacingAvgMs=0, pacingEdges=[], pacingSingleType=null;
      actionTimes.sort((a,b)=>a.time-b.time);
      const seqDeltas=[];
      for(let i=1;i<actionTimes.length;i++) {
        const d=actionTimes[i].time-actionTimes[i-1].time;
        if(d>=100&&d<=60000) seqDeltas.push({ delta:d, start:actionTimes[i-1].time, end:actionTimes[i].time, type:actionTimes[i].type, idx:i });
      }
      if (seqDeltas.length >= settings.pacingMinHits) {
        const candidateDeltas = [...new Set(seqDeltas.map(d => Math.round(d.delta / 50) * 50))];
        for (const center of candidateDeltas) {
          let streak=[], bestStreak=[];
          for (const gap of seqDeltas) {
            if (Math.abs(gap.delta - center) <= settings.pacingToleranceMs) { streak.push(gap); }
            else { if (streak.length > bestStreak.length) bestStreak = streak; streak = []; }
          }
          if (streak.length > bestStreak.length) bestStreak = streak;
          if (bestStreak.length > pacingHits) {
            pacingHits = bestStreak.length;
            pacingAvgMs = Math.round(bestStreak.reduce((s,g)=>s+g.delta,0)/bestStreak.length);
            pacingEdges = bestStreak;
          }
        }
        if (pacingHits >= settings.pacingMinHits) {
          const types=pacingEdges.map(e=>e.type);
          const typeSet=new Set(types);
          if (typeSet.size===1) pacingSingleType=[...typeSet][0];
        }
      }
      livePlayer.pacingHits = pacingHits;
      livePlayer.pacingAvgMs = pacingAvgMs;
      livePlayer.pacingEdges = pacingEdges;
      livePlayer.pacingSingleType = pacingSingleType;

      const fullPlayer = { ...livePlayer, companies: parsedCompanies };
      const result = analyzePlayer(fullPlayer, settings, globalCacheRef.current, actionTimes, true, addLog);

      setFindings(prev => {
        const newState = { ...prev };
        if (!newState[country]) newState[country] = [];
        const idx = newState[country].findIndex(r => r.player.id === playerId);
        if (result) {
          result.phase2Status = 'complete';
          if (idx >= 0) newState[country][idx] = result;
          else newState[country].push(result);
        } else {
          if (idx >= 0) newState[country] = newState[country].filter(r => r.player.id !== playerId);
        }
        return newState;
      });
      addLog(`[INFO] Phase 2 complete: ${foundName}.`, 'info');
    } catch(e) {
      addLog(`[CRITICAL] Phase 2 failed for ${foundName}: ${e.message}`, 'warning');
      setFindings(prev => {
        const newState = { ...prev };
        if (newState[country]) {
          const idx = newState[country].findIndex(r => r.player.id === playerId);
          if (idx >= 0) newState[country][idx] = { ...newState[country][idx], phase2Status: 'error' };
        }
        return newState;
      });
    }
  };

  const runPhase2 = (playerId, country) => { processPlayerPhase2(playerId, country, false); };

  const startScan = async (overrideUserId = null) => {
    setIsScanning(true); isScanningRef.current=true; setProgress(0); setFindings({}); setLogs([]);
    gatewayFails.current=0; isGatewayDead.current=false; globalRateLimitRelease.current=0; setIsRateLimited(false);
    globalWashPartners.current={}; globalBans.current={}; globalHermitPrimaries.current={};
    phase2DataRef.current={}; didLogTipPayloadRef.current=false; didLogUserLiteShapeRef.current=false; didLogWorkerShapeRef.current=false;
    effectiveConcurrencyRef.current=settings.concurrencyLimit; concurrencyLastReducedRef.current=0;
    alwaysPhase2Ref.current=false;
    scanQueueRef.current=[];
    
    successfulWorkerEndpointRef.current=null;
    successfulWorkerSchemaRef.current=null;
    workerEndpointDiscoveryPromiseRef.current=null;
    txHealthRef.current = { ok: 0, fail: 0, warned: false };
    globalCacheRef.current.requestDeduper.clear();

    try {
      if (!globalCacheRef.current.wealthByLevel) globalCacheRef.current.wealthByLevel = {};
      const localWb = localStorage.getItem('wera_wealth_baseline');
      if (localWb) {
        const parsedWb = JSON.parse(localWb);
        Object.assign(globalCacheRef.current.wealthByLevel, parsedWb);
      }
      const wbRes = await fetch('/api/cache', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'get_wealth_baseline' }) });
      if (wbRes.ok) {
          const wbJson = await wbRes.json();
          let loaded = wbJson.data||{};
          if (typeof loaded === 'object' && !Array.isArray(loaded)) {
              Object.assign(globalCacheRef.current.wealthByLevel, loaded);
          }
      }
      // Drop garbage level buckets (game level is 1-50) left by the earlier
      // level-extraction bug, so they don't linger as junk baselines.
      const wbl = globalCacheRef.current.wealthByLevel;
      let pruned = 0;
      for (const k of Object.keys(wbl)) { const n = Number(k); if (!(n >= 1 && n <= 60)) { delete wbl[k]; pruned++; } }
      if (pruned > 0) addLog(`[INFO] Wealth baseline: pruned ${pruned} out-of-range level bucket(s).`, 'info');
    } catch(e) { addLog(`[DEBUG] Could not load wealth baseline from server: ${e.message}`, 'debug'); }
    addLog(`[INFO] Wealth baseline: ${Object.keys(globalCacheRef.current.wealthByLevel || {}).length} level entries loaded.`, 'info');

    addLog(`Initializing High-Concurrency Oracle Engine...`, 'info');

    if (apiKey && apiKey.startsWith('wae_')) {
      try {
        const testRes=await fetch('https://api2.warera.io/trpc/country.getAllCountries?batch=1&input=%7B%220%22%3A%7B%7D%7D',{headers:{'Content-Type':'application/json','X-API-Key':apiKey.trim()}});
        if (testRes.status===401||testRes.status===403) throw new Error("Auth Failed");
        const tt=await testRes.text();
        if (tt.toLowerCase().includes('unauthorized')||tt.toLowerCase().includes('invalid api key')) throw new Error("Auth Failed");
        addLog(`✅ API Key Authorized.`, 'info');
      } catch(e) {
        if (e.message==='Auth Failed'||e.message.includes('401')||e.message.includes('403')) {
          addLog(`[CRITICAL] API Key rejected. Check your key.`, 'warning');
          setIsScanning(false); isScanningRef.current=false; setCurrentTask('Idle'); return;
        }
      }
    }

    const effectiveTargetUserId = overrideUserId || targetUserId;
    if (effectiveTargetUserId) {
      let actualTargetId=effectiveTargetUserId.trim();
      if (actualTargetId&&!/^[0-9a-fA-F]{24}$/.test(actualTargetId)) {
        addLog(`Resolving username "${actualTargetId}"...`, 'info');
        try {
          const searchData=await smartFetch('search.searchAnything',{searchText:actualTargetId});
          const targetLower=actualTargetId.toLowerCase();
          const extractIds=(obj)=>{ let ids=[]; if(Array.isArray(obj)){for(let item of obj){if(typeof item==='string'&&/^[0-9a-fA-F]{24}$/.test(item))ids.push(item);else if(typeof item==='object')ids.push(...extractIds(item));}}else if(typeof obj==='object'&&obj!==null){for(let key in obj){if(key==='userIds'&&Array.isArray(obj[key]))ids.push(...obj[key].filter(i=>/^[0-9a-fA-F]{24}$/.test(i)));else if(typeof obj[key]==='object')ids.push(...extractIds(obj[key]));}} return ids; };
          const possibleIds=extractIds(searchData);
          let foundExactId=null;
          if (possibleIds.length>0) {
            for (const id of possibleIds) {
              try { const uProfile=await smartFetch('user.getUserLite',{userId:id}); if(uProfile&&(String(uProfile.username||'').toLowerCase()===targetLower||String(uProfile.name||'').toLowerCase()===targetLower)){foundExactId=id;break;} } catch(e){}
            }
          }
          if (foundExactId) { actualTargetId=foundExactId; addLog(`✅ Resolved to ID: ${actualTargetId}`, 'info'); }
          else { addLog(`[CRITICAL] Could not resolve "${effectiveTargetUserId}".`, 'warning'); setIsScanning(false); isScanningRef.current=false; setCurrentTask('Idle'); return; }
        } catch(e) { addLog(`Search failed: ${e.message}`, 'warning'); }
      }
      scanQueueRef.current=[{ _id: actualTargetId, scanContext: 'Targeted User' }];
      alwaysPhase2Ref.current = true;
    } else if (watchlistScanRef.current) {
      const wlEntries = Object.values(watchlist);
      scanQueueRef.current = wlEntries.map(p => ({ _id: p.id, scanContext: p.country || 'Watchlist' }));
      alwaysPhase2Ref.current = true;
      watchlistScanRef.current = false;
      addLog(`Scanning ${wlEntries.length} watchlisted suspect(s)...`, 'info');
    } else if (targetRegionId) {
      let targetRegions = targetRegionId==='ALL' ? availableRegions.map(r=>r._id||r.id) : [targetRegionId];
      let allCitizens=[];
      for (const regionId of targetRegions) {
        if (!isScanningRef.current) break;
        const rName=availableRegions.find(r=>(r._id||r.id)===regionId)?.name||regionId;
        let success=false;
        
        for (const ep of ['user.getUsersByCountry', 'user.getUsers', 'country.getCitizens']) {
          if (success) break;
          let nextCursor=null, page=1, hasMore=true, loopSeenSet=new Set();
          try {
            do {
              if (!isScanningRef.current) break;
              while (globalRateLimitRelease.current>Date.now()) await new Promise(r=>setTimeout(r,500));
              const payload={countryId:regionId,limit:100};
              if (nextCursor) payload.cursor=nextCursor; else if (page>1) payload.page=page;
              const res=await smartFetch(ep,payload);
              
              let resolvedRes=res;
              if (Array.isArray(res)&&res.length>0&&typeof res[0]==='string'){try{resolvedRes=JSON.parse(res[0]);}catch{}}
              
              let pageData = resolvedRes;
              if (pageData && !Array.isArray(pageData)) {
                  pageData = pageData.data || pageData.items || pageData.citizens || pageData.users || pageData.members || pageData.results || [];
                  if (!Array.isArray(pageData)) pageData = Object.values(pageData);
              }
              
              if (page===1&&pageData.flat(3).filter(c=>typeof c==='object'&&c!==null).length===0) addLog(`[WARNING] ${rName} p1 raw shape: ${JSON.stringify(res).substring(0,300)}`, 'warning');
              pageData=pageData.flat(3).filter(c=>typeof c==='object'&&c!==null);
              let newCount=0; const uniqueC=[];
              pageData.forEach(c=>{ const id=c._id||c.id||c.userId; if(!loopSeenSet.has(id)){loopSeenSet.add(id);c.scanContext=rName;uniqueC.push(c);newCount++;} });
              
              if (uniqueC.length>0) { allCitizens.push(...uniqueC); success=true; }
              
              if (pageData.length===0||newCount===0) hasMore=false;
              else {
                const nextC=resolvedRes?.nextCursor||resolvedRes?.meta?.nextCursor||res?.nextCursor||null;
                if (nextC) { nextCursor=nextC; hasMore=true; }
                else if (pageData.length>=100) hasMore=true;
                else hasMore=false;
                if (hasMore) page++;
              }
              if (allCitizens.length>(targetRegionId==='ALL'?100000:2000)) { hasMore=false; break; }
            } while (hasMore);
          } catch(e) { addLog(`[WARNING] ${ep} for ${rName} failed: ${e.message.substring(0,120)}`, 'warning'); }
        }
        if (!success) addLog(`[WARNING] ${rName}: no citizens extracted (endpoint loop exhausted).`, 'warning');
      }
      const finalMap=new Map(); allCitizens.forEach(c=>{ const id=c._id||c.id||c.userId; finalMap.set(id,c); });
      allCitizens=Array.from(finalMap.values());
      if (allCitizens.length>0) { addLog(`✅ ${allCitizens.length} users acquired.`, 'info'); scanQueueRef.current=allCitizens; }
    }

    if (scanQueueRef.current.length===0) { addLog(`[CRITICAL] No targets acquired.`, 'warning'); setIsScanning(false); isScanningRef.current=false; setCurrentTask('Idle'); return; }

    const processedIds=new Set(); let playersScanned=0;
    const activePromises = new Set();
    setCurrentTask(`Executing Concurrency Pool (x${effectiveConcurrencyRef.current})...`);
    
    try {
      while (isScanningRef.current && (scanQueueRef.current.length > 0 || activePromises.size > 0)) {
        while (scanQueueRef.current.length > 0 && activePromises.size < effectiveConcurrencyRef.current) {
          const player = scanQueueRef.current.shift();
          const pid = player._id || player.id;
          if (processedIds.has(pid)) continue; 
          processedIds.add(pid);
          
          const p = (async () => { 
              await new Promise(r=>setTimeout(r, 10)); 
              try { await processPlayerPhase1(player); } 
              catch(err) { addLog(`[CRITICAL] Engine crash on ${player.name||player._id}: ${err.message}`, 'warning'); } 
          })();
          
          activePromises.add(p);
          p.finally(() => { 
              activePromises.delete(p); 
              playersScanned++; 
              const total = playersScanned + activePromises.size + scanQueueRef.current.length; 
              setProgress(Math.floor((playersScanned/total)*100)); 
          });
        }
        
        if (activePromises.size > 0) {
          await Promise.race(activePromises);
          const nowR = Date.now();
          if (concurrencyLastReducedRef.current > 0 && nowR - concurrencyLastReducedRef.current > 60000) {
            const curR = effectiveConcurrencyRef.current;
            const maxR = settings.concurrencyLimit;
            if (curR < maxR) {
              const nextR = curR >= 25 ? Math.min(curR + 10, maxR) : curR >= 12 ? 25 : curR >= 6 ? 12 : curR;
              effectiveConcurrencyRef.current = nextR;
              concurrencyLastReducedRef.current = nowR;
              addLog(`[GATEWAY] Concurrency recovering: ${curR} -> ${nextR}`, 'info');
            }
          }
        } else await new Promise(r=>setTimeout(r,100));
      }
      await Promise.all(activePromises);
    } finally {
      setIsRateLimited(false);
      const txH = txHealthRef.current;
      if (txH.ok > 0) addLog(`[INFO] Transaction endpoint healthy (${txH.ok} ok / ${txH.fail} failed). Transaction heuristics ran with live data.`, 'info');
      else if (txH.fail > 0) addLog(`[CRITICAL] Transaction endpoint failed on all ${txH.fail} attempt(s) — transaction-based heuristics had no data this scan.`, 'warning');
      if (isScanningRef.current) { setCurrentTask('Scan Complete'); setProgress(100); addLog('Scan sequence terminated.', 'info'); }
      setIsScanning(false); isScanningRef.current=false;
      if (globalCacheRef.current.wealthByLevel && Object.keys(globalCacheRef.current.wealthByLevel).length > 0) {
        localStorage.setItem('wera_wealth_baseline', JSON.stringify(globalCacheRef.current.wealthByLevel));
        fetch('/api/cache', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'set_wealth_baseline', data:globalCacheRef.current.wealthByLevel }) }).catch(()=>{});
      }
    }
  };

  const abortScan = () => { setIsScanning(false); isScanningRef.current=false; setIsRateLimited(false); setCurrentTask('Scan Aborted'); addLog('Scan manually aborted.', 'warning'); };

  const exportFindings = () => {
    const data = { _oracleExport: true, exportedAt: new Date().toISOString(), totalFlags: Object.values(findings).flat().length, findings };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=`warera-oracle-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const exportSinglePlayer = (result) => {
    const data = { _oracleExport: true, exportedAt: new Date().toISOString(), totalFlags: 1, findings: { [result.player.country]: [result] } };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=`oracle-${result.player.name}-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportJson = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        if (!parsed._oracleExport || !parsed.findings) { alert('Invalid Oracle export file. Make sure you exported from WarEra Oracle.'); return; }
        setFindings(parsed.findings);
        addLog(`✅ Imported ${Object.values(parsed.findings).flat().length} findings from ${file.name}`, 'info');
      } catch(err) { alert(`Failed to parse file: ${err.message}`); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const buildShortSummary = (result) => {
    const name = result.player.name;
    const parts = [];
    const launderSus = result.suspicions.find(s => s.type === 'money_laundering');
    if (launderSus) {
      const workerNames = launderSus.workers.filter(w => !w.normalizedName.includes('(SELF)')).map(w => w.normalizedName);
      const total = result.totalLaunderedCoins?.toFixed(1) || '?';
      if (workerNames.length > 0) parts.push(`${workerNames.length} worker(s) (${workerNames.slice(0,3).join(', ')}${workerNames.length>3?'...':''}) donated ${total} coins to ${name}'s MU in large transactions.`);
      else parts.push(`${name} sent ${total} coins to their MU in large outbound donations.`);
    }
    const washSus = result.suspicions.find(s => s.type === 'transaction_abuse');
    if (washSus) {
      const banned = (washSus.partners || []).filter(p => p.isBanned);
      const netProfit = (washSus.partners || []).reduce((s,p) => s + (p.netProfit || 0), 0);
      const profitStr = Math.abs(netProfit) < 0.01 ? 'no net gain' : netProfit > 0 ? `gaining ${netProfit.toFixed(1)} coins` : `losing ${Math.abs(netProfit).toFixed(1)} coins`;
      parts.push(`Ring-traded with ${(washSus.partners||[]).length} partner(s) (${profitStr})${banned.length > 0 ? `, ${banned.length} since banned` : ''}.`);
    }
    const wageSus = result.suspicions.find(s => s.type === 'low_wage');
    if (wageSus) parts.push(`${wageSus.workers.length} workers paid minimum wage.`);
    const cloneSus = result.suspicions.filter(s => s.type === 'cloned_progression');
    if (cloneSus.length > 0) parts.push(`${cloneSus.reduce((s,c) => s + c.workers.length, 0)} workers have cloned skills.`);
    const shellSus = result.suspicions.find(s => s.type === 'no_production_bonus');
    if (shellSus && result.bossNoBonusPercentage > 0) parts.push(`${result.bossNoBonusPercentage}% of worker companies have no regional production bonuses.`);
    const nameSus = result.suspicions.filter(s => s.type === 'naming_pattern');
    if (nameSus.length > 0) parts.push(`Workers with overlapping names: ${nameSus.map(s => `(${s.workers.map(w=>w.normalizedName).join(', ')})`).join(', ')}.`);
    const sniperSus = result.suspicions.find(s => s.type === 'market_automation');
    if (sniperSus) parts.push(`Sniper bot: bought ${result.player.sniperHits} items within ${settings.sniperThresholdMs}ms of listing.`);
    const paceSus = result.suspicions.find(s => s.type === 'script_pacing');
    if (paceSus) parts.push(`Script pacing: ${result.player.pacingHits} actions at ~${result.player.pacingAvgMs}ms intervals.`);
    const tipSus = result.suspicions.filter((s) => s.type === 'tip_farming');
    if (tipSus.length > 0) parts.push(`Tip farming: ${tipSus.length} coordinated tipping pattern${tipSus.length>1?'s':''} detected.`);
    const hermitSus = result.suspicions.find((s) => s.type === 'hermit_network' || s.type === 'mutual_hermit');
    if (hermitSus) parts.push(`Hermit trade network: transactions confined to a closed group of accounts.`);
    const apmSus = result.suspicions.find(s => s.type === 'superhuman_apm');
    if (apmSus) parts.push(`Superhuman APM: ${result.player.maxConcurrentTxs} listings within ${settings.apmWindowMs}ms.`);
    const wageUnifSus = result.suspicions.find(s => s.type === 'wage_uniformity');
    if (wageUnifSus) parts.push(`Workers paid suspiciously uniform wages.`);
    const fidSus = result.suspicions.find(s => s.type === 'fidelity_ring');
    if (fidSus) parts.push(`${fidSus.workers.length} workers at max fidelity (10/10).`);
    const coordSus = result.suspicions.find(s => s.type === 'coordinated_donation');
    if (coordSus) parts.push(`Donations coordinated within 10-minute windows.`);
    const wealthSus = result.suspicions.find(s => s.type === 'wealth_anomaly');
    if (wealthSus) {
      const _bw=extractCoinWealth(result.player), _bl=extractUserLevel(result.player)??result.player.level, _bar=_bl!=null?getWealthAverageExtended(globalCacheRef.current,_bl):null;
      parts.push(_bw!=null&&_bar&&_bar.avg>0&&(_bw/_bar.avg)<1?`Account wealth unusually low for level.`:`Account wealth disproportionately high for level.`);
    }
    const tempSus = result.suspicions.find(s => s.type === 'temporal_clustering');
    if (tempSus) parts.push(`Activity locked to a narrow time window.`);
    let summary = parts.join(' ');
    if (summary.length > 500) summary = summary.substring(0, 497).replace(/\s\S*$/, '') + '...';
    return summary;
  };

  const copySummaryToClipboard = (result) => {
    const text = buildShortSummary(result);
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    else fallbackCopy(text);
  };

  const fallbackCopy = (text) => {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand('copy'); } catch(e) {}
    document.body.removeChild(ta);
  };

  const rescanPlayer = (playerId, country) => {
    delete phase2DataRef.current[playerId];
    setFindings(prev => { const n={...prev}; if(n[country]) n[country]=n[country].filter(r=>r.player.id!==playerId); return n; });
    scanQueueRef.current.unshift({ _id: playerId, scanContext: country });
    if (!isScanningRef.current) {
      setIsScanning(true); isScanningRef.current=true; setProgress(0); setCurrentTask('Re-scanning player...');
      const processedIds=new Set(); let activePromises=[];
      const runRescan=async()=>{
        try {
          while (isScanningRef.current&&(scanQueueRef.current.length>0||activePromises.length>0)) {
            while (scanQueueRef.current.length>0&&activePromises.length<5) {
              const player=scanQueueRef.current.shift(); const pid=player._id||player.id;
              if (processedIds.has(pid)) continue; processedIds.add(pid);
              const p=(async()=>{ await new Promise(r=>setTimeout(r,10)); try{await processPlayerPhase1(player);}catch(err){addLog(`[CRITICAL] ${err.message}`,'warning');} })();
              p.finally(()=>{ activePromises=activePromises.filter(pr=>pr!==p); });
              activePromises.push(p);
            }
            if (activePromises.length>0) await Promise.race(activePromises); else break;
          }
          await Promise.all(activePromises);
        } finally { setIsScanning(false); isScanningRef.current=false; setCurrentTask('Re-scan Complete'); setProgress(100); }
      };
      runRescan();
    }
  };

  const now = Date.now();
  gatewayTokens.current = gatewayTokens.current.filter(t=>now-t<60000);
  officialTokens.current = officialTokens.current.filter(t=>now-t<60000);
  const gatewayCount=gatewayTokens.current.length, officialCount=officialTokens.current.length;
  const gatewayPercent=Math.max(0,((3500-gatewayCount)/3500)*100);
  const officialPercent=Math.max(0,((400-officialCount)/400)*100);
  const isOfficialEnabled=apiKey&&apiKey.trim()!=='';
  const getNextRefill=tokens=>tokens.length===0?0:Math.ceil((60000-(now-tokens[0]))/1000);
  const gatewayNext=getNextRefill(gatewayTokens.current);
  const officialNext=getNextRefill(officialTokens.current);

  const CRIT_TYPES = new Set(['market_automation','superhuman_apm','script_pacing','money_laundering','coordinated_donation','transaction_abuse']);
  const HIGH_TYPES = new Set(['hermit_network','mutual_hermit','wealth_anomaly','fidelity_ring','cloned_progression']);
  const sevTierOf = (type) => CRIT_TYPES.has(type) ? 'crit' : HIGH_TYPES.has(type) ? 'high' : 'med';
  const scoreTierOf = (score) => score >= 10 ? 'crit' : score >= 5 ? 'high' : 'med';
  const T_COLOR = { crit:'#ff5d6c', high:'#ffab3d', med:'#ffd84d' };
  const T_BG    = { crit:'rgba(255,93,108,0.12)', high:'rgba(255,171,61,0.12)', med:'rgba(255,216,77,0.11)' };
  const T_LINE  = { crit:'rgba(255,93,108,0.42)', high:'rgba(255,171,61,0.40)', med:'rgba(255,216,77,0.36)' };

  const FINDING_DETAIL = {
    market_automation:    { observed:'Items purchased within milliseconds of listing', rule:`Reaction < ${settings.sniperThresholdMs}ms on 5+ occasions`, note:'Human reaction speed is ~200-400ms; sustained sub-threshold purchase rate is consistent with automated polling.' },
    superhuman_apm:       { observed:'Multiple market listings placed within a narrow window', rule:`>=5 transactions within ${settings.apmWindowMs}ms`, note:'Concurrent market actions are extremely difficult to achieve manually.' },
    script_pacing:        { observed:'Identical inter-action gaps across consecutive trades', rule:`Gap variance <= ±${settings.pacingToleranceMs}ms on ${settings.pacingMinHits}+ consecutive pairs`, note:'Clock-perfect pacing is a strong indicator of timer-driven automation.' },
    money_laundering:     { observed:'Workers receiving unusually large coin donations', rule:'Donation volume >= 30x expected wage in 30 days', note:'May be profit extraction from a controlled network; legitimate bonuses rarely reach this scale.' },
    coordinated_donation: { observed:'Multiple workers tipping within suspiciously close intervals', rule:'>=3 donations within 60s', note:'Coordinated timing suggests an orchestrated network rather than independent actors.' },
    transaction_abuse:    { observed:'High-volume bilateral trading with the same counterparty', rule:'>=5 trades; significantly imbalanced net profit', note:'Repeated round-trip trades between two accounts are a common wash-trading pattern.' },
    hermit_network:       { observed:'Workers employed nowhere except this account', rule:'All known employment is with this single employer', note:'Exclusive worker networks can indicate account manufacturing, though niche legitimate employers exist.' },
    mutual_hermit:        { observed:'Mutual exclusive employment between boss and worker', rule:'Boss is also exclusively employed by this account', note:'Reciprocal hermit relationships substantially increase the likelihood of coordination.' },
    wealth_anomaly:      { observed:'Account coin wealth far from level peers', rule:`Coin wealth > ${settings.wealthAnomalyMultiplier}x or < ${settings.wealthAnomalyLowerMultiplier}x the level median (low bound applies at level 11+)`, note:'Wealth far above the level median may indicate external funding; far below may indicate a drained mule. Check account age and transaction history for context.' },
    fidelity_ring:        { observed:'Workers holding maximum fidelity across the workforce', rule:'Fidelity = 10/10 across workers', note:'Perfect fidelity cluster is unusual - may indicate artificially maintained relationships.' },
    cloned_progression:   { observed:'Progression stats mirror another account', rule:'Level/wealth within 2% of a known clone signature', note:'Near-identical progression curves can indicate copy-cat account farming.' },
    low_wage:             { observed:'Workers paid below suspicious wage threshold', rule:`Wage <= ${settings.suspiciousWageThreshold.toFixed(3)}`, note:'Low wages alone are not conclusive; combine with other signals for stronger inference.' },
    naming_pattern:       { observed:'Workers share a name substring or systematic pattern', rule:'>=3 workers share an overlapping name fragment', note:'Bot farms sometimes use systematic naming. May also be coincidence in small regions.' },
    temporal_clustering:  { observed:'Activity concentrated in a narrow UTC window', rule:'Majority of actions in <=3 contiguous hours', note:'Timezone-consistent clustering is expected - combined with other flags it may indicate automation.' },
    wage_uniformity:      { observed:'All workers paid identical wages', rule:'Wage variance across workforce is zero', note:'Uniform wages may suggest batch configuration rather than individual negotiation.' },
    no_production_bonus:  { observed:'Companies issuing no production bonuses', rule:'>=1 company with 0% bonus rate', note:'Bonus suppression can reduce worker incentive to audit their employment.' },
    tip_farming:          { observed:'Heavy, concentrated tip traffic from a small set of accounts', rule:'Single tipper accounts for >=50% of all received tips', note:'Tip farming networks route coins through repeated small donations to obscure origin.' },
  };

  const allResults = Object.entries(findings).flatMap(([country, results]) =>
    (results).map(r => ({ ...r, country }))
  );
  const tierOrder = { crit: 0, high: 1, med: 2 };
  const maxSevTierOf = (result) => {
    if (result.suspicions.some((s) => CRIT_TYPES.has(s.type))) return 'crit';
    if (result.suspicions.some((s) => HIGH_TYPES.has(s.type))) return 'high';
    return 'med';
  };
  const filteredResults = allResults.filter(r => {
    if (r.player.isBanned) return false; // banned accounts are hidden from the case list (still shown in maps/findings where flagged)
    if (listSearch && !String(r.player.name).toLowerCase().includes(listSearch.toLowerCase())) return false;
    if (listFilter !== 'all') {
      const tier = maxSevTierOf(r);
      if (listFilter === 'critical' && tier !== 'crit') return false;
      if (listFilter === 'high' && tier !== 'high') return false;
      if (listFilter === 'medium' && tier !== 'med') return false;
    }
    return true;
  }).sort((a, b) => {
    const ta = tierOrder[maxSevTierOf(a)], tb = tierOrder[maxSevTierOf(b)];
    if (ta !== tb) return ta - tb;
    return (b.adjustedDetections ?? b.detections) - (a.adjustedDetections ?? a.detections);
  });
  const caseGroups = {};
  filteredResults.forEach(r => { if (!caseGroups[r.country]) caseGroups[r.country] = []; caseGroups[r.country].push(r); });

  const activeResult = allResults.find(r => r.player.id === activeSuspectId) || null;
  const orderedSuspicions = activeResult
    ? [...activeResult.suspicions].sort((a, b) => {
        const ta = tierOrder[sevTierOf(a.type)], tb = tierOrder[sevTierOf(b.type)];
        if (ta !== tb) return ta - tb;
        return (b.detectionWeight ?? 1) - (a.detectionWeight ?? 1);
      })
    : [];
  const activeWashPartners = activeResult && globalWashPartners.current[activeResult.player.id]
    ? Object.entries(globalWashPartners.current[activeResult.player.id])
    : [];
  const ringSize = activeResult ? Object.keys(activeResult.washPartners || {}).length : 0;
  const ringBanned = activeWashPartners.filter(([, p]) => p.isBanned).length;
  const netFlow = activeWashPartners.reduce((s, [, p]) => s + (p.netProfit || 0), 0);
  const critCount = activeResult ? activeResult.suspicions.filter((s) => CRIT_TYPES.has(s.type)).length : 0;
  const totalFlags = Object.values(findings).flat().length;
  const activeRuleCount = [
    settings.suspiciousWageThreshold !== 0.110,
    settings.wealthAnomalyMultiplier !== 1.5,
    settings.wealthAnomalyLowerMultiplier !== 0.5,
    settings.sniperThresholdMs !== 1000,
    settings.apmWindowMs !== 500,
    settings.pacingToleranceMs !== 3,
    settings.pacingMinHits !== 6,
  ].filter(Boolean).length;

  return (
    <div style={{height:'100vh',display:'flex',flexDirection:'column',overflow:'hidden',background:'#070b18',color:'#eaf0ff',fontFamily:"IBM Plex Sans, system-ui, sans-serif"}}>

      {/* Slim progress bar */}
      <div style={{height:3,background:'#0c1226',flexShrink:0,position:'relative'}}>
        <div style={{height:'100%',width:`${progress}%`,background:isRateLimited?'#ffab3d':'#4fc3e8',transition:'width 0.3s'}}/>
      </div>
      {isRateLimited&&(
        <div style={{flexShrink:0,background:'rgba(255,171,61,0.12)',borderBottom:'1px solid rgba(255,171,61,0.40)',padding:'4px 18px',textAlign:'center',fontSize:11,color:'#ffab3d',fontFamily:"IBM Plex Mono, monospace",fontWeight:700,letterSpacing:'0.08em'}}>
          PAUSED: API COOLDOWN - {limitTimer}s REMAINING
        </div>
      )}

      {/* Session restore prompt */}
      {showRestorePrompt&&savedSession&&(
        <div style={{flexShrink:0,background:'rgba(255,171,61,0.10)',borderBottom:'1px solid rgba(255,171,61,0.40)',padding:'8px 18px',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <span style={{color:'#ffab3d',fontSize:13,fontWeight:500}}>Previous scan - {Object.values(savedSession.findings).flat().length} flags, saved {new Date(savedSession.savedAt).toLocaleTimeString()}</span>
          <div style={{display:'flex',gap:8}}>
            <button onClick={()=>{setFindings(savedSession.findings);setShowRestorePrompt(false);}} style={{padding:'4px 10px',background:'rgba(255,171,61,0.25)',border:'1px solid rgba(255,171,61,0.50)',borderRadius:6,color:'#ffab3d',fontSize:11,fontWeight:600,cursor:'pointer'}}>Restore</button>
            <button onClick={()=>{setShowRestorePrompt(false);sessionStorage.removeItem('warera_oracle_session');}} style={{padding:'4px 10px',background:'#121b35',border:'1px solid #1f2b4e',borderRadius:6,color:'#9fb0d4',fontSize:11,fontWeight:600,cursor:'pointer'}}>Dismiss</button>
          </div>
        </div>
      )}

      {/* TOP BAR */}
      <header style={{height:68,flexShrink:0,background:'#0c1226',borderBottom:'1px solid #1f2b4e',padding:'0 16px',display:'flex',alignItems:'center',gap:10,overflow:'hidden'}}>
        {/* Brand */}
        <div style={{display:'flex',alignItems:'center',gap:9,flexShrink:0}}>
          <ShieldAlert size={19} style={{color:'#ff5d6c'}}/>
          <div>
            <div style={{fontSize:16,fontWeight:700,color:'#eaf0ff',lineHeight:1.2}}>Palantirish</div>
            <div style={{fontSize:9.5,color:'#5d6e96',fontFamily:"IBM Plex Mono, monospace",whiteSpace:'nowrap'}}>Multi-Account & Bot Detection</div>
          </div>
        </div>
        <div style={{width:1,height:34,background:'#1f2b4e',flexShrink:0}}/>
        {/* Scan controls */}
        <div style={{display:'flex',alignItems:'flex-end',gap:6,flex:1,minWidth:0}}>
          <div style={{display:'flex',flexDirection:'column',gap:2}}>
            <label style={{fontSize:8,color:'#5d6e96',letterSpacing:'0.07em',textTransform:'uppercase',lineHeight:1}}>API Key</label>
            <input type="text" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="wae_..."
              style={{width:162,background:'#060a16',border:`1px solid ${apiKey&&!apiKey.startsWith('wae_')?'#ff5d6c':'#1f2b4e'}`,borderRadius:5,padding:'5px 8px',fontSize:11,color:apiKey&&!apiKey.startsWith('wae_')?'#ff5d6c':'#eaf0ff',outline:'none',fontFamily:"IBM Plex Mono, monospace"}}
              disabled={isScanning}/>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:2}}>
            <label style={{fontSize:8,color:'#5d6e96',letterSpacing:'0.07em',textTransform:'uppercase',lineHeight:1}}>User ID <span style={{color:'#2e3f6a',textTransform:'none',letterSpacing:0}}>(opt.)</span></label>
            <input type="text" value={targetUserId} onChange={e=>setTargetUserId(e.target.value)} placeholder="leave blank for all"
              style={{width:130,background:'#060a16',border:'1px solid #1f2b4e',borderRadius:5,padding:'5px 8px',fontSize:11,color:'#eaf0ff',outline:'none',fontFamily:"IBM Plex Mono, monospace"}}
              disabled={isScanning||!apiKey.startsWith('wae_')}/>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:2}}>
            <label style={{fontSize:8,color:'#5d6e96',letterSpacing:'0.07em',textTransform:'uppercase',lineHeight:1}}>Region</label>
            <select value={targetRegionId} onChange={e=>setTargetRegionId(e.target.value)}
              style={{width:148,background:'#060a16',border:'1px solid #1f2b4e',borderRadius:5,padding:'5px 8px',fontSize:11,color:'#eaf0ff',outline:'none'}}
              disabled={isScanning||!!targetUserId||availableRegions.length===0||!apiKey.startsWith('wae_')}>
              {availableRegions.length===0&&<option value="">{!apiKey.startsWith('wae_')?'Awaiting API key...':'Pinging...'}</option>}
              {availableRegions.length>0&&<option value="ALL">Global (All Regions)</option>}
              {availableRegions.map((r)=><option key={r._id||r.id} value={r._id||r.id}>{r.name}</option>)}
            </select>
          </div>
          {!isScanning?(
            <div style={{display:'flex',gap:4}}>
              <button onClick={() => startScan(null)} style={{padding:'5px 14px',background:'#ff5d6c',border:'none',borderRadius:5,color:'#070b18',fontSize:11.5,fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap'}}>
                <Play size={11} fill="currentColor"/> Scan
              </button>
              {Object.keys(watchlist).length>0&&(
                <button onClick={()=>{watchlistScanRef.current=true;startScan(null);}} style={{padding:'5px 9px',background:'rgba(255,171,61,0.20)',border:'1px solid rgba(255,171,61,0.50)',borderRadius:5,color:'#ffab3d',fontSize:11,fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',gap:4}}>
                  <Bookmark size={10} fill="currentColor"/> {Object.keys(watchlist).length}
                </button>
              )}
            </div>
          ):(
            <button onClick={abortScan} style={{padding:'5px 14px',background:'#1b2748',border:'1px solid #2e3f6a',borderRadius:5,color:'#9fb0d4',fontSize:11.5,fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap'}}>
              <Square size={11} fill="currentColor"/> Abort
            </button>
          )}
        </div>
        <div style={{width:1,height:34,background:'#1f2b4e',flexShrink:0}}/>
        {/* Flag count */}
        <div style={{textAlign:'center',lineHeight:1,flexShrink:0}}>
          <div style={{fontSize:18,fontWeight:700,color:'#ff5d6c',fontFamily:"IBM Plex Mono, monospace"}}>{totalFlags}</div>
          <div style={{fontSize:9.5,color:'#5d6e96',letterSpacing:'0.08em',textTransform:'uppercase'}}>Flags</div>
        </div>
        {/* Rate bars */}
        <div style={{display:'flex',flexDirection:'column',gap:3,padding:'4px 10px',background:'#121b35',border:'1px solid #1f2b4e',borderRadius:6,minWidth:118,flexShrink:0}}>
          <div style={{display:'flex',alignItems:'center',gap:5}}>
            <span style={{fontSize:8.5,color:'#5d6e96',width:52,textAlign:'right',whiteSpace:'nowrap',flexShrink:0}}>Stats cache</span>
            <div style={{flex:1,height:3,background:'#060a16',borderRadius:99,overflow:'hidden'}}><div style={{width:`${gatewayPercent}%`,height:'100%',background:gatewayPercent<20?'#ff5d6c':gatewayPercent<50?'#ffab3d':'#4fc3e8',transition:'width 0.3s'}}/></div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:5,opacity:isOfficialEnabled?1:0.35}}>
            <span style={{fontSize:8.5,color:'#5d6e96',width:52,textAlign:'right',whiteSpace:'nowrap',flexShrink:0}}>Live API</span>
            <div style={{flex:1,height:3,background:'#060a16',borderRadius:99,overflow:'hidden'}}><div style={{width:`${!isOfficialEnabled?0:officialPercent}%`,height:'100%',background:officialPercent<20?'#ff5d6c':officialPercent<50?'#ffab3d':'#3fd0a3',transition:'width 0.3s'}}/></div>
          </div>
        </div>
        {/* Thresholds */}
        <button onClick={()=>setConfigOpen(o=>!o)} style={{display:'flex',alignItems:'center',gap:5,padding:'5px 10px',background:configOpen?'#1b2748':'#121b35',border:`1px solid ${configOpen?'#4fc3e8':'#2e3f6a'}`,borderRadius:6,color:configOpen?'#4fc3e8':'#9fb0d4',fontSize:11.5,fontWeight:600,cursor:'pointer',whiteSpace:'nowrap',flexShrink:0}}>
          <Settings size={12}/> Thresholds{activeRuleCount>0&&<span style={{background:'rgba(79,195,232,0.20)',color:'#4fc3e8',borderRadius:99,padding:'1px 6px',fontSize:9,fontWeight:700}}>{activeRuleCount}</span>}
        </button>
        {/* Import */}
        <button onClick={()=>fileInputRef.current?.click()} style={{display:'flex',alignItems:'center',gap:5,padding:'5px 10px',background:'#121b35',border:'1px solid #2e3f6a',borderRadius:6,color:'#9fb0d4',fontSize:11.5,fontWeight:600,cursor:'pointer',flexShrink:0,whiteSpace:'nowrap'}}>
          <Download size={11} style={{transform:'rotate(180deg)'}}/> Import
        </button>
        <input ref={fileInputRef} type="file" accept=".json" onChange={handleImportJson} style={{display:'none'}}/>
        {totalFlags>0&&(
          <button onClick={exportFindings} style={{display:'flex',alignItems:'center',gap:5,padding:'5px 10px',background:'#121b35',border:'1px solid #2e3f6a',borderRadius:6,color:'#9fb0d4',fontSize:11.5,fontWeight:600,cursor:'pointer',flexShrink:0,whiteSpace:'nowrap'}}>
            <Download size={11}/> Export all
          </button>
        )}
        {Object.keys(watchlist).length>0&&(
          <button onClick={()=>setShowWatchlist(w=>!w)} style={{display:'flex',alignItems:'center',gap:5,padding:'5px 10px',background:showWatchlist?'rgba(255,171,61,0.15)':'#121b35',border:`1px solid ${showWatchlist?'rgba(255,171,61,0.50)':'#2e3f6a'}`,borderRadius:6,color:showWatchlist?'#ffab3d':'#9fb0d4',fontSize:11.5,fontWeight:600,cursor:'pointer',flexShrink:0,whiteSpace:'nowrap'}}>
            <Bookmark size={11} fill={showWatchlist?'currentColor':'none'}/> Watchlist {Object.keys(watchlist).length}
          </button>
        )}
      </header>

      {/* ── THREE-PANE BODY ── */}
      <div style={{flex:1,display:'flex',flexDirection:'row',overflow:'hidden',minHeight:0}}>

        {/* LEFT: Case List 300px */}
        <div style={{width:300,flexShrink:0,background:'#0c1226',borderRight:'1px solid #1f2b4e',display:'flex',flexDirection:'column',overflow:'hidden'}}>
          {/* Header */}
          <div style={{padding:'12px 14px 8px',borderBottom:'1px solid #1f2b4e',flexShrink:0}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:8}}>
              <span style={{fontSize:12,fontWeight:700,letterSpacing:'0.08em',color:'#9fb0d4',textTransform:'uppercase'}}>Case List</span>
              <span style={{fontSize:10.5,fontFamily:"IBM Plex Mono, monospace",color:'#5d6e96'}}>{filteredResults.length} - by score</span>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:6,background:'#060a16',border:'1px solid #2e3f6a',borderRadius:6,padding:'5px 8px',marginBottom:8}}>
              <Search size={11} style={{color:'#5d6e96',flexShrink:0}}/>
              <input value={listSearch} onChange={e=>setListSearch(e.target.value)} placeholder="Filter suspects..." style={{background:'transparent',border:'none',outline:'none',color:'#eaf0ff',fontSize:12,flex:1,fontFamily:"IBM Plex Sans, system-ui, sans-serif"}}/>
            </div>
            <div style={{display:'flex',gap:4}}>
              {['all','critical','high','medium'].map(f=>(
                <button key={f} onClick={()=>setListFilter(f)} style={{padding:'3px 8px',borderRadius:99,fontSize:10,fontWeight:600,cursor:'pointer',background:listFilter===f?'rgba(79,195,232,0.12)':'#121b35',border:`1px solid ${listFilter===f?'#2e3f6a':'#1f2b4e'}`,color:listFilter===f?'#4fc3e8':'#5d6e96'}}>
                  {f==='all'?'All':f.charAt(0).toUpperCase()+f.slice(1)}
                </button>
              ))}
            </div>
          </div>
          {/* Suspect rows */}
          <div style={{flex:1,overflowY:'auto'}}>
            {Object.keys(findings).length===0?(
              <div style={{padding:24,textAlign:'center',color:'#5d6e96'}}>
                <Search size={32} style={{margin:'0 auto 12px',opacity:0.15,display:'block'}}/>
                <div style={{fontSize:12,marginBottom:4}}>No scan results yet</div>
                <div style={{fontSize:10.5,lineHeight:1.5}}>Enter API key + region in the top bar, then click Scan</div>
              </div>
            ):filteredResults.length===0?(
              <div style={{padding:24,textAlign:'center',color:'#5d6e96',fontSize:12}}>No suspects match this filter.</div>
            ):(
              Object.entries(caseGroups).sort().map(([country,results])=>(
                <div key={country}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'7px 14px 5px',background:'#070b18',borderBottom:'1px solid #1f2b4e',position:'sticky',top:0,zIndex:2}}>
                    <span style={{fontSize:10.5,fontWeight:700,color:'#9fb0d4',letterSpacing:'0.04em',textTransform:'uppercase'}}>{country}</span>
                    <span style={{fontSize:9.5,fontFamily:"IBM Plex Mono, monospace",background:'rgba(255,93,108,0.11)',color:'#ff5d6c',border:'1px solid rgba(255,93,108,0.42)',borderRadius:4,padding:'1px 6px',fontWeight:700}}>{results.length}</span>
                  </div>
                  {results.map((r)=>{
                    const tier=maxSevTierOf(r);
                    const score=r.adjustedDetections??r.detections;
                    const isActive=r.player.id===activeSuspectId;
                    const _pw=extractCoinWealth(r.player);
                    const _pl=extractUserLevel(r.player)??r.player.level;
                    const _pavg=_pl!=null?getWealthAverageExtended(globalCacheRef.current,_pl):null;
                    const wealthRatio=(_pw!=null&&_pavg&&_pavg.avg>0)?(_pw/_pavg.avg):null;
                    const _kind=clusterKindOf(r,globalCacheRef.current);
                    return (
                      <div key={r.player.id} onClick={()=>setActiveSuspectId(r.player.id)}
                        style={{display:'flex',alignItems:'stretch',cursor:'pointer',
                          background:isActive?'rgba(79,195,232,0.08)':'transparent',
                          borderLeft:isActive?'3px solid #4fc3e8':`3px solid ${T_COLOR[tier]}`,
                          borderBottom:'1px solid #1f2b4e',
                        }}>
                        <div style={{flex:1,padding:'8px 8px 8px 9px',minWidth:0}}>
                          <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:2}}>
                            <div style={{width:5,height:5,borderRadius:'50%',background:T_COLOR[tier],flexShrink:0}}/>
                            <span style={{fontSize:12.5,fontWeight:600,fontFamily:"IBM Plex Mono, monospace",color:isActive?'#4fc3e8':'#eaf0ff',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1}}>{String(r.player.name)}</span>
                            {r.player.level&&<span style={{fontSize:9.5,fontFamily:"IBM Plex Mono, monospace",color:'#5d6e96',flexShrink:0}}>Lv.{r.player.level}</span>}
                          </div>
                          <div style={{fontSize:10,color:'#5d6e96',display:'flex',gap:5,alignItems:'center'}}>
                            <KindGlyph kind={_kind.kind}/>
                            <span>{_kind.kind}{_kind.size>0?` · ${_kind.size}`:''}</span>
                            {wealthRatio!=null&&<span style={{color:'#2e3f6a'}}>·</span>}
                            {wealthRatio!=null&&<span style={{fontWeight:700,color:wealthRatio>=1?'#ffab3d':'#4fc3e8'}}>{wealthRatio.toFixed(1)}× avg</span>}
                            {watchlist[r.player.id]&&<span style={{fontSize:9,fontWeight:700,color:'#ffab3d'}}>WATCH</span>}
                          </div>
                        </div>
                        <div style={{display:'flex',alignItems:'center',padding:'0 10px',flexShrink:0}}>
                          <span style={{fontSize:13,fontWeight:700,fontFamily:"IBM Plex Mono, monospace",color:T_COLOR[tier]}}>{score}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>

        {/* CENTER: Dossier */}
        <div style={{flex:1,overflowY:'auto',background:'#070b18',minWidth:0}}>
          {!activeResult?(
            <div style={{height:'100%',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',color:'#5d6e96'}}>
              <ShieldAlert size={48} style={{opacity:0.1,marginBottom:16}}/>
              <div style={{fontSize:14,fontWeight:600,marginBottom:6}}>Select a suspect</div>
              <div style={{fontSize:12,textAlign:'center',lineHeight:1.6,opacity:0.7}}>Click any row in the case list to load their dossier.</div>
            </div>
          ):(
            <div>
              {/* Concept G top row: relationship map + sidebar */}
              {(()=>{
                const _cw=extractCoinWealth(activeResult.player);
                const _lv=extractUserLevel(activeResult.player)??activeResult.player.level;
                const _ar=_lv!=null?getWealthAverageExtended(globalCacheRef.current,_lv):null;
                const _bx=(_cw!=null&&_ar&&_ar.avg>0)?_cw/_ar.avg:null;
                const _wf=buildMatrixModel(activeResult.suspicions,globalCacheRef.current).rows.filter(r=>r.id!==activeResult.player.id).length;
                return (
                  <div style={{padding:'14px 24px 0',display:'flex',gap:14,alignItems:'stretch'}}>
                    <MapSidebar activeResult={activeResult} isWatching={!!watchlist[activeResult.player.id]} workforceSize={_wf}
                      copied={copiedId===activeResult.player.id}
                      onWatch={()=>toggleWatchlist(activeResult.player.id,activeResult.player.name,activeResult.country)}
                      onRescan={()=>rescanPlayer(activeResult.player.id,activeResult.country)}
                      onReport={()=>exportSinglePlayer(activeResult)}
                      onCopy={()=>{copySummaryToClipboard(activeResult);setCopiedId(activeResult.player.id);setTimeout(()=>setCopiedId(null),2500);}}/>
                    <ClusterMapPanel activeResult={activeResult} globalCache={globalCacheRef.current} bossWealthX={_bx} bossWealth={_cw}/>
                  </div>
                );
              })()}

              {/* Linked-Account Matrix (Concept G) */}
              <div style={{paddingTop:18}}>
                <LinkedAccountMatrix suspicions={activeResult.suspicions} wageThreshold={settings.suspiciousWageThreshold} bossId={activeResult.player.id}/>
              </div>

              {/* Engagement network (Concept G) */}
              <EngagementNetwork activeResult={activeResult} names={globalCacheRef.current.names}/>

              {/* Findings timeline (evidence detail) */}
              <div style={{padding:'20px 24px'}}>
                <div style={{fontSize:11,fontWeight:700,letterSpacing:'0.08em',color:'#9fb0d4',textTransform:'uppercase',marginBottom:20}}>
                  Observed Signals - {orderedSuspicions.length}, ordered by strength
                </div>
                {orderedSuspicions.map((suspicion, sIdx)=>{
                  const tier=sevTierOf(suspicion.type);
                  const detail=FINDING_DETAIL[suspicion.type];
                  const friendlyTitle=String(suspicion.type).replace(/_/g,' ').replace(/\b\w/g,(c)=>c.toUpperCase());
                  return (
                    <div key={sIdx} style={{display:'flex',gap:14,marginBottom:28,alignItems:'flex-start'}}>
                      {/* Number circle + connector */}
                      <div style={{display:'flex',flexDirection:'column',alignItems:'center',flexShrink:0,paddingTop:3}}>
                        <div style={{width:24,height:24,borderRadius:'50%',background:T_BG[tier],border:`2px solid ${T_COLOR[tier]}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:700,fontFamily:"IBM Plex Mono, monospace",color:T_COLOR[tier]}}>{sIdx+1}</div>
                        {sIdx<orderedSuspicions.length-1&&<div style={{width:1,background:'#1f2b4e',marginTop:4,height:16}}/>}
                      </div>
                      {/* Body */}
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6,flexWrap:'wrap'}}>
                          <span style={{fontSize:14,fontWeight:700,color:'#eaf0ff',whiteSpace:'nowrap'}}>{friendlyTitle}</span>
                          <span style={{fontSize:9.5,fontWeight:700,background:T_BG[tier],border:`1px solid ${T_LINE[tier]}`,color:T_COLOR[tier],borderRadius:4,padding:'2px 7px',letterSpacing:'0.05em',textTransform:'uppercase'}}>{tier==='crit'?'Critical':tier==='high'?'High':'Medium'}</span>
                          {detail&&(
                            <span className="group/dtip" style={{position:'relative',display:'inline-block'}}>
                              <span style={{fontSize:10,color:'#4fc3e8',background:'rgba(79,195,232,0.10)',border:'1px solid rgba(79,195,232,0.30)',borderRadius:4,padding:'2px 7px',cursor:'help'}}>i details</span>
                              <div className="hidden group-hover/dtip:block" style={{position:'absolute',left:0,top:'130%',background:'#121b35',border:'1px solid #2e3f6a',borderRadius:8,padding:12,zIndex:50,width:290,boxShadow:'0 8px 24px rgba(0,0,0,0.6)',fontSize:11.5,lineHeight:1.55}}>
                                <div style={{marginBottom:7}}><span style={{color:'#5d6e96',fontWeight:600}}>Observed: </span><span style={{color:'#eaf0ff'}}>{detail.observed}</span></div>
                                <div style={{marginBottom:7}}><span style={{color:'#5d6e96',fontWeight:600}}>Rule: </span><span style={{color:'#eaf0ff',fontFamily:"IBM Plex Mono, monospace",fontSize:10.5}}>{detail.rule}</span></div>
                                <div><span style={{color:'#5d6e96',fontWeight:600}}>Note: </span><span style={{color:'#9fb0d4'}}>{detail.note}</span></div>
                              </div>
                            </span>
                          )}
                        </div>
                        <p style={{fontSize:13,lineHeight:1.55,color:'#9fb0d4',maxWidth:600,marginBottom:8}}>
                          {String(suspicion.desc).split('Coins').map((part,i,arr)=>(
                            <React.Fragment key={i}>{part}{i!==arr.length-1&&<Coins size={10} style={{display:'inline',color:'#ffd84d',verticalAlign:'middle',marginBottom:1}}/>}</React.Fragment>
                          ))}
                        </p>
                        {suspicion.type==='temporal_clustering'&&suspicion.hourBuckets&&<ActivityHeatmap hourBuckets={suspicion.hourBuckets}/>}
                        
                        {/* Tip farming cards */}
                        {suspicion.type==='tip_farming'&&suspicion.tipperCounts&&Object.keys(suspicion.tipperCounts).length>0?(
                          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(210px,1fr))',gap:8}}>
                            {Object.entries(suspicion.tipperCounts).filter(([,c])=>c>=5).sort((a,b)=>b[1]-a[1]).map(([tipperId,count],tIdx)=>{
                              const tipperName=globalCacheRef.current.names?.[tipperId];
                              const meta=suspicion.tipperMeta?.[tipperId];
                              const receivedPct=suspicion.totalTipsReceived>0?Math.round(count/suspicion.totalTipsReceived*100):null;
                              const sentPct=(suspicion.tipperSentTotals?.[tipperId]||0)>0?Math.round((suspicion.tipperAmounts?.[tipperId]||0)/suspicion.tipperSentTotals[tipperId]*100):null;
                              const coinsFromTipper=suspicion.tipperAmounts?.[tipperId];
                              return (
                                <a key={tIdx} href={`https://app.warera.io/user/${tipperId}`} target="_blank" rel="noopener noreferrer"
                                  style={{background:'#060a16',border:`1px solid ${T_LINE.med}`,borderLeft:`3px solid ${T_COLOR.med}`,borderRadius:6,padding:'8px 10px',display:'block',textDecoration:'none'}}>
                                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                                    <span style={{fontFamily:"IBM Plex Mono, monospace",fontSize:11,color:'#4fc3e8',display:'flex',alignItems:'center',gap:4,flexWrap:'wrap'}}>
                                      {tipperName||<span style={{color:'#5d6e96'}}>{tipperId}</span>}
                                      {meta?.level!=null&&<span style={{color:'#5d6e96',fontSize:9.5}}>Lv.{meta.level}</span>}
                                      {meta?.isBanned&&<span style={{fontSize:8,fontWeight:700,color:'#ff5d6c',background:'rgba(255,93,108,0.12)',border:'1px solid rgba(255,93,108,0.42)',borderRadius:3,padding:'1px 4px'}}>BANNED</span>}
                                    </span>
                                    <span style={{fontSize:9.5,background:'rgba(255,171,61,0.15)',color:'#ffab3d',border:'1px solid rgba(255,171,61,0.40)',borderRadius:4,padding:'2px 6px',fontWeight:700,display:'flex',alignItems:'center',gap:3,flexShrink:0}}>{count}<Star size={8}/></span>
                                  </div>
                                  <div style={{fontSize:10,fontFamily:"IBM Plex Mono, monospace",color:'#5d6e96',display:'flex',flexDirection:'column',gap:2}}>
                                    {receivedPct!==null&&<span>{receivedPct}% of all tips received</span>}
                                    {sentPct!==null&&<span style={{color:'#ffab3d'}}>{sentPct}% of tipper's lifetime sends</span>}
                                    {coinsFromTipper>0&&<span style={{color:'#3fd0a3'}}>{coinsFromTipper.toFixed(1)} coins donated</span>}
                                  </div>
                                </a>
                              );
                            })}
                          </div>
                        ) : suspicion.type==='transaction_abuse'&&(suspicion.partners||[]).length>0?(
                          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(210px,1fr))',gap:8}}>
                            {(suspicion.partners||[]).map((p,pIdx)=>{
                              const partnerProfit=-(p.netProfit||0);
                              const profitColor=Math.abs(partnerProfit)<0.01?'#5d6e96':partnerProfit>0?'#3fd0a3':'#ff5d6c';
                              const profitText=Math.abs(partnerProfit)<0.01?`0.0 NET (${(p.volume||0).toFixed(1)} VOL)`:partnerProfit>0?`+${partnerProfit.toFixed(1)} gained`:`-${Math.abs(partnerProfit).toFixed(1)} lost`;
                              return (
                                <a key={pIdx} href={`https://app.warera.io/user/${p.id}`} target="_blank" rel="noopener noreferrer"
                                  style={{background:'#060a16',border:`1px solid ${T_LINE.crit}`,borderLeft:`3px solid #ff5d6c`,borderRadius:6,padding:'8px 10px',display:'block',textDecoration:'none'}}>
                                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:4}}>
                                    <div>
                                      <span style={{fontFamily:"IBM Plex Mono, monospace",fontSize:11,color:'#4fc3e8'}}>{String(p.name)}</span>
                                      {p.isBanned&&<span style={{display:'inline-block',marginLeft:4,fontSize:8,fontWeight:700,color:'#ff5d6c',background:'rgba(255,93,108,0.12)',border:'1px solid rgba(255,93,108,0.42)',borderRadius:3,padding:'1px 4px'}}>BANNED</span>}
                                      {p.isWorker&&<span style={{display:'inline-block',marginLeft:4,fontSize:8,fontWeight:700,color:'#ffab3d',background:'rgba(255,171,61,0.12)',border:'1px solid rgba(255,171,61,0.40)',borderRadius:3,padding:'1px 4px'}}>WORKER ×2</span>}
                                    </div>
                                    <span style={{fontSize:10,color:'#5d6e96',fontFamily:"IBM Plex Mono, monospace",flexShrink:0}}>Lv.{p.level}</span>
                                  </div>
                                  <div style={{display:'flex',justifyContent:'space-between',fontSize:10,fontFamily:"IBM Plex Mono, monospace"}}>
                                    <span style={{color:'#5d6e96'}}>{p.txCount} trades - {p.latestTrade?new Date(p.latestTrade).toLocaleDateString():'?'}</span>
                                    <span style={{color:profitColor,fontWeight:700}}>{profitText}</span>
                                  </div>
                                </a>
                              );
                            })}
                          </div>
                        ) : !['tip_farming','transaction_abuse','temporal_clustering'].includes(suspicion.type)&&(suspicion.workers||[]).length>0 ? (
                          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(210px,1fr))',gap:8}}>
                            {(suspicion.workers||[]).map((w,wIdx)=>{
                              let dispName=String(w.normalizedName), isSelf=false, isHermitNode=false;
                              if(dispName.includes('(SELF)')){isSelf=true;dispName=dispName.replace(' (SELF)','');}
                              if(dispName.includes('(HERMIT NODE)')){isHermitNode=true;dispName=dispName.replace(' (HERMIT NODE)','');}
                              return (
                                <a key={wIdx} href={`https://app.warera.io/user/${w.resolvedUser?._id||w.uid}`} target="_blank" rel="noopener noreferrer"
                                  style={{background:'#060a16',border:`1px solid ${T_LINE[tier]}`,borderLeft:`3px solid ${T_COLOR[tier]}`,borderRadius:6,padding:'8px 10px',display:'block',textDecoration:'none'}}>
                                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:4}}>
                                    <div style={{minWidth:0,flex:1}}>
                                      <div style={{fontFamily:"IBM Plex Mono, monospace",fontSize:11,color:'#4fc3e8',display:'flex',flexWrap:'wrap',alignItems:'center',gap:4}}>
                                        {/* name */}
                                        {suspicion.type==='naming_pattern'
                                          ?dispName.split(new RegExp(`(${suspicion.overlapString})`, 'gi')).map((part,i)=>
                                              part.toLowerCase()===suspicion.overlapString?.toLowerCase()?<span key={i} style={{color:'#ffd84d',fontWeight:700}}>{part}</span>:<span key={i}>{part}</span>)
                                          :dispName}
                                        
                                        {/* APM tooltip */}
                                        {suspicion.type==='superhuman_apm'&&suspicion.apmDetails&&isSelf&&(
                                          <span className="group/tooltip" style={{position:'relative',fontSize:9,color:'#4fc3e8',background:'rgba(79,195,232,0.10)',border:'1px solid rgba(79,195,232,0.30)',borderRadius:4,padding:'1px 5px',cursor:'help',fontWeight:700}}>
                                            AVG {suspicion.apmDetails.avgGapMs}ms
                                            <div className="hidden group-hover/tooltip:block" style={{position:'absolute',left:0,top:'120%',background:'#121b35',border:'1px solid #2e3f6a',borderRadius:8,padding:10,zIndex:60,minWidth:260,fontSize:10,boxShadow:'0 8px 24px rgba(0,0,0,0.6)'}}>
                                              <div style={{fontWeight:700,color:'#9fb0d4',marginBottom:6}}>Listed Items (Window: {settings.apmWindowMs}ms)</div>
                                              {(suspicion.apmDetails.txs||[]).slice(0,15).map((t,i)=><div key={i} style={{display:'flex',justifyContent:'space-between',gap:10,paddingBottom:3,marginBottom:3,borderBottom:'1px solid #1f2b4e',color:'#9fb0d4'}}><span>{new Date(t.offerTimeMs).toISOString().substring(0,19).replace('T',' ')}</span><span style={{color:'#4fc3e8'}}>{t.itemCode}</span></div>)}
                                              {(suspicion.apmDetails.txs||[]).length>15&&<div style={{color:'#5d6e96',fontStyle:'italic'}}>+{(suspicion.apmDetails.txs||[]).length-15} more</div>}
                                            </div>
                                          </span>
                                        )}

                                        {/* Pacing tooltip */}
                                        {suspicion.type==='script_pacing'&&suspicion.pacingDetails&&isSelf&&(
                                          <span className="group/tooltip" style={{position:'relative',fontSize:9,color:'#ff5d6c',background:'rgba(255,93,108,0.10)',border:'1px solid rgba(255,93,108,0.42)',borderRadius:4,padding:'1px 5px',cursor:'help',fontWeight:700}}>
                                            {suspicion.pacingDetails.avgGapMs}ms gap{suspicion.pacingDetails.singleType?` / ${suspicion.pacingDetails.singleType}`:''}
                                            <div className="hidden group-hover/tooltip:block" style={{position:'absolute',left:0,top:'120%',background:'#121b35',border:'1px solid #2e3f6a',borderRadius:8,padding:10,zIndex:60,minWidth:280,fontSize:10,boxShadow:'0 8px 24px rgba(0,0,0,0.6)'}}>
                                              <div style={{fontWeight:700,color:'#9fb0d4',marginBottom:6}}>Identical Gaps (±{settings.pacingToleranceMs}ms)</div>
                                              {(suspicion.pacingDetails.edges||[]).slice(0,15).map((edge,i)=><div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:4,paddingBottom:3,marginBottom:3,borderBottom:'1px solid #1f2b4e',color:'#9fb0d4'}}><span style={{color:'#ff5d6c',fontWeight:700,width:48}}>{edge.delta}ms</span><span style={{color:'#5d6e96',fontSize:9}}>{new Date(edge.end).toISOString().substring(0,19).replace('T',' ')}</span><span style={{textAlign:'right',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:80,textTransform:'capitalize'}}>{edge.type}</span></div>)}
                                              {(suspicion.pacingDetails.edges||[]).length>15&&<div style={{color:'#5d6e96',fontStyle:'italic'}}>+{(suspicion.pacingDetails.edges||[]).length-15} more</div>}
                                            </div>
                                          </span>
                                        )}

                                        {/* Sniper tooltip */}
                                        {suspicion.type==='market_automation'&&suspicion.sniperDetails&&isSelf&&(
                                          <span className="group/tooltip" style={{position:'relative',fontSize:9,color:'#ff5d6c',background:'rgba(255,93,108,0.10)',border:'1px solid rgba(255,93,108,0.42)',borderRadius:4,padding:'1px 5px',cursor:'help',fontWeight:700}}>
                                            AVG {Math.round((suspicion.sniperDetails||[]).reduce((a,b)=>a+b.timeMs,0)/Math.max(1,(suspicion.sniperDetails||[]).length))}ms
                                            <div className="hidden group-hover/tooltip:block" style={{position:'absolute',left:0,top:'120%',background:'#121b35',border:'1px solid #2e3f6a',borderRadius:8,padding:10,zIndex:60,minWidth:280,fontSize:10,boxShadow:'0 8px 24px rgba(0,0,0,0.6)'}}>
                                              <div style={{fontWeight:700,color:'#9fb0d4',marginBottom:6}}>Sniped Items (Fastest First)</div>
                                              {[...(suspicion.sniperDetails||[])].sort((a,b)=>a.timeMs-b.timeMs).slice(0,15).map((t,i)=><div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:4,paddingBottom:3,marginBottom:3,borderBottom:'1px solid #1f2b4e',color:'#9fb0d4'}}><span style={{color:'#ff5d6c',fontWeight:700,width:48}}>{t.timeMs}ms</span><span style={{color:'#5d6e96',fontSize:9}}>{new Date(t.offerTimeMs+t.timeMs).toISOString().substring(0,19).replace('T',' ')}</span><span style={{textAlign:'right',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:80}}>{t.itemCode}</span></div>)}
                                              {(suspicion.sniperDetails||[]).length>15&&<div style={{color:'#5d6e96',fontStyle:'italic'}}>+{(suspicion.sniperDetails||[]).length-15} more</div>}
                                            </div>
                                          </span>
                                        )}

                                        {suspicion.type==='hermit_network'&&isHermitNode&&<span style={{fontSize:8,fontWeight:700,color:'#ffab3d',background:'rgba(255,171,61,0.12)',border:'1px solid rgba(255,171,61,0.40)',borderRadius:3,padding:'1px 4px'}}>HERMIT NODE</span>}
                                        {suspicion.type==='wealth_anomaly'&&w.accountAgeDays!==undefined&&<span style={{fontSize:8,fontWeight:700,color:'#4fc3e8',background:'rgba(79,195,232,0.10)',border:'1px solid rgba(79,195,232,0.30)',borderRadius:3,padding:'1px 4px'}}>{w.accountAgeDays}d OLD</span>}
                                        {w.isBanned&&<span style={{fontSize:8,fontWeight:700,color:'#ff5d6c',background:'rgba(255,93,108,0.12)',border:'1px solid rgba(255,93,108,0.42)',borderRadius:3,padding:'1px 4px'}}>BANNED</span>}
                                        {w.isActive===false&&!w.isBanned&&<span style={{fontSize:8,fontWeight:700,color:'#ff5d6c',background:'rgba(255,93,108,0.12)',border:'1px solid rgba(255,93,108,0.42)',borderRadius:3,padding:'1px 4px'}}>INACTIVE</span>}
                                        {w.noBonusPercentage>0&&suspicion.type==='no_production_bonus'&&<span style={{fontSize:8,fontWeight:700,color:'#ffab3d',background:'rgba(255,171,61,0.12)',border:'1px solid rgba(255,171,61,0.40)',borderRadius:3,padding:'1px 4px'}}>{w.noBonusPercentage}% NO-PROD</span>}
                                        {w.isLaundering&&suspicion.type==='money_laundering'&&<span style={{fontSize:8,fontWeight:700,color:'#ff5d6c',background:'rgba(255,93,108,0.12)',border:'1px solid rgba(255,93,108,0.42)',borderRadius:3,padding:'1px 4px',display:'flex',alignItems:'center',gap:2}}>{w.largeDonations30Days?.toFixed(1)} <Coins size={8}/></span>}
                                        {suspicion.type==='fidelity_ring'&&<span style={{fontSize:8,fontWeight:700,color:'#ffab3d',background:'rgba(255,171,61,0.12)',border:'1px solid rgba(255,171,61,0.40)',borderRadius:3,padding:'1px 4px'}}>FIDELITY 10</span>}
                                      </div>
                                      {suspicion.type==='wealth_anomaly'&&w.wealthReason&&<div style={{fontSize:10,color:'#5d6e96',marginTop:3,lineHeight:1.4}}>{w.wealthReason}</div>}
                                    </div>
                                    <span style={{fontSize:10,fontFamily:"IBM Plex Mono, monospace",color:'#5d6e96',flexShrink:0,marginLeft:8}}>Lv.{w.normalizedLevel}</span>
                                  </div>
                                  {(w.normalizedWage!==undefined||w.normalizedFidelity!==undefined)&&(
                                    <div style={{display:'flex',justifyContent:'space-between',fontSize:10,fontFamily:"IBM Plex Mono, monospace",marginTop:4}}>
                                      {w.normalizedWage!==undefined&&<span style={{color:w.normalizedWage<=settings.suspiciousWageThreshold?'#ff5d6c':'#3fd0a3'}}>Wage: {Number(w.normalizedWage).toFixed(3)}</span>}
                                      {w.normalizedFidelity!==undefined&&<span style={{color:'#5d6e96'}}>Fid: <span style={{color:w.normalizedFidelity===10?'#4fc3e8':'#eaf0ff',fontWeight:w.normalizedFidelity===10?700:400}}>{w.normalizedFidelity}</span>/10</span>}
                                    </div>
                                  )}
                                </a>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* (Old right rail removed — replaced by the in-pane MapSidebar beside the relationship map.) */}
      </div>

      {/* ── FOOTER: LogBar ── */}
      <div style={{flexShrink:0,background:'#0c1226',borderTop:'1px solid #1f2b4e',overflow:'hidden'}}>
        <div onClick={()=>setLogExpanded(e=>!e)} style={{height:40,display:'flex',alignItems:'center',padding:'0 18px',cursor:'pointer',userSelect:'none',justifyContent:'space-between'}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            {logExpanded?<ChevronDown size={12} style={{color:'#5d6e96'}}/>:<ChevronRight size={12} style={{color:'#5d6e96'}}/>}
            <span style={{fontSize:12,fontWeight:600,color:'#9fb0d4'}}>Scanner Telemetry</span>
            <span style={{fontFamily:"IBM Plex Mono, monospace",fontSize:11,color:isScanning?'#ffab3d':'#3fd0a3'}}>
              {isRateLimited?`COOLDOWN ${limitTimer}s`:isScanning?'Scanning...':currentTask} [{progress}%]
            </span>
          </div>
          <span style={{fontSize:10.5,fontFamily:"IBM Plex Mono, monospace",color:'#5d6e96'}}>{totalFlags} flagged</span>
        </div>
        {logExpanded&&(
          <div style={{height:200,background:'#060a16',borderTop:'1px solid #1f2b4e',padding:'8px 12px',overflowY:'auto',fontFamily:"IBM Plex Mono, monospace",fontSize:11,display:'flex',flexDirection:'column',gap:2}}>
            {logs.map((log,i)=>(
              <div key={i} style={{color:log.type==='warning'?'#ff5d6c':log.type==='debug'?'#2e3f6a':'#5d6e96',display:'flex',gap:8}}>
                <span style={{color:'#1f2b4e',flexShrink:0}}>[{log.time}]</span>
                <span style={{wordBreak:'break-all'}}>{log.msg}</span>
              </div>
            ))}
            <div ref={logsContainerRef}/>
          </div>
        )}
      </div>

      {/* ── CONFIG POPOVER ── */}
      {configOpen&&(
        <div style={{position:'fixed',top:74,right:18,zIndex:200,background:'#121b35',border:'1px solid #2e3f6a',borderRadius:9,padding:20,width:330,boxShadow:'0 12px 40px rgba(0,0,0,0.75)',maxHeight:'calc(100vh - 88px)',overflowY:'auto'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
            <span style={{fontSize:13,fontWeight:700,color:'#eaf0ff'}}>Detection Thresholds</span>
            <button onClick={()=>setConfigOpen(false)} style={{background:'none',border:'none',color:'#5d6e96',cursor:'pointer',fontSize:18,lineHeight:1,padding:'0 4px'}}>&#215;</button>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            {[
              {label:'Suspicious Wage Threshold',key:'suspiciousWageThreshold',min:0.01,max:0.15,step:0.001,fmt:(v)=>v.toFixed(3),isFloat:true},
              {label:'Wealth Anomaly Threshold (high)',key:'wealthAnomalyMultiplier',min:1,max:10,step:0.5,fmt:(v)=>`${v}x`,isFloat:true},
              {label:'Low Wealth Threshold',key:'wealthAnomalyLowerMultiplier',min:0.05,max:0.95,step:0.05,fmt:(v)=>`${v}x`,isFloat:true},
              {label:'Sniper Threshold (ms)',key:'sniperThresholdMs',min:100,max:5000,step:100,fmt:(v)=>`${v}`,isFloat:false},
              {label:'Superhuman APM Window (ms)',key:'apmWindowMs',min:100,max:20000,step:100,fmt:(v)=>`${v}`,isFloat:false},
              {label:'Pacing Tolerance (ms)',key:'pacingToleranceMs',min:1,max:100,step:1,fmt:(v)=>`+/-${v}`,isFloat:false},
              {label:'Pacing Min Hits',key:'pacingMinHits',min:4,max:20,step:1,fmt:(v)=>`${v}`,isFloat:false},
            ].map(({label,key,min,max,step,fmt,isFloat})=>(
              <div key={key}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <label style={{fontSize:11,color:'#9fb0d4'}}>{label}</label>
                  <span style={{fontSize:11,fontFamily:"IBM Plex Mono, monospace",color:'#4fc3e8'}}>{fmt(settings[key])}</span>
                </div>
                <input type="range" min={min} max={max} step={step} value={settings[key]}
                  onChange={e=>setSettings({...settings,[key]:isFloat?parseFloat(e.target.value):parseInt(e.target.value)})}
                  style={{width:'100%',accentColor:'#4fc3e8'}} disabled={isScanning}/>
              </div>
            ))}
            <label style={{display:'flex',alignItems:'center',gap:8,fontSize:11.5,color:'#9fb0d4',cursor:'pointer'}}>
              <input type="checkbox" checked={settings.verboseDebug} onChange={e=>setSettings({...settings,verboseDebug:e.target.checked})} style={{accentColor:'#4fc3e8'}} disabled={isScanning}/>
              Verbose Debug Logging
            </label>
          </div>
        </div>
      )}

      {/* ── WATCHLIST PANEL ── */}
      {showWatchlist&&Object.keys(watchlist).length>0&&(()=>{
        const grouped={};
        Object.values(watchlist).forEach((p)=>{const c=p.country||'Unknown';if(!grouped[c])grouped[c]=[];grouped[c].push(p);});
        const countries=Object.keys(grouped).sort();
        return(
        <div style={{position:'fixed',top:70,right:configOpen?390:18,zIndex:150,background:'#121b35',border:'1px solid rgba(255,171,61,0.50)',borderRadius:9,padding:16,width:300,maxHeight:420,overflowY:'auto',boxShadow:'0 8px 32px rgba(0,0,0,0.6)'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
            <span style={{fontSize:12,fontWeight:700,color:'#ffab3d',display:'flex',alignItems:'center',gap:6}}><Bookmark size={12} fill="currentColor"/> Watchlist</span>
            <button onClick={()=>setShowWatchlist(false)} style={{background:'none',border:'none',color:'#5d6e96',cursor:'pointer',fontSize:18,lineHeight:1}}>&#215;</button>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            {countries.map(country=>(
              <div key={country}>
                <div style={{fontSize:10,fontWeight:700,color:'#5d6e96',textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4,paddingBottom:3,borderBottom:'1px solid #1f2b4e'}}>{country}</div>
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  {grouped[country].map((p)=>(
                    <div key={p.id} style={{display:'flex',alignItems:'center',background:'#060a16',border:'1px solid #1f2b4e',borderRadius:6,padding:'5px 8px',gap:6}}>
                      <div style={{minWidth:0,flex:1}}>
                        <a href={`https://app.warera.io/user/${p.id}`} target="_blank" rel="noopener noreferrer" style={{fontFamily:"IBM Plex Mono, monospace",fontSize:11,color:'#4fc3e8',display:'block',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',textDecoration:'none'}}>{p.name}</a>
                      </div>
                      <button onClick={()=>{setShowWatchlist(false);startScan(p.id);}} style={{background:'rgba(79,195,232,0.12)',border:'1px solid rgba(79,195,232,0.25)',borderRadius:4,color:'#4fc3e8',cursor:'pointer',padding:'2px 5px',fontSize:10,display:'flex',alignItems:'center',gap:3,flexShrink:0}} title="Scan now"><Play size={9}/> Scan</button>
                      <button onClick={()=>toggleWatchlist(p.id,p.name,p.country)} style={{background:'none',border:'none',color:'#5d6e96',cursor:'pointer',padding:'2px',flexShrink:0}} title="Remove"><Trash2 size={11}/></button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        );
      })()}
    </div>
  );
}
