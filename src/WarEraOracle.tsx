import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  ShieldAlert, Play, Square, Activity, ChevronRight, 
  ChevronDown, AlertTriangle, Users, Database, UserX, 
  ExternalLink, Settings, Search, Star, Coins,
  Target, Zap, Network, Clock, Download, Filter,
  SortAsc, SortDesc, RefreshCw, BarChart2, Info,
  Baby, Moon, Heart, Timer, CheckSquare
} from 'lucide-react';

// ─────────────────────────────────────────────
//  API LAYER
// ─────────────────────────────────────────────
const WarEraAPI = {
  fetch: async (endpoint, payload, activeKey, baseUrl) => {
    const isGateway = baseUrl.includes('gateway');
    const url = `${baseUrl}${endpoint}`;
    const headers = { 'Content-Type': 'application/json' };
    if (activeKey && activeKey.trim() !== '') headers['X-API-Key'] = activeKey.trim();
    let res;
    try {
      if (isGateway) {
        res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
      } else {
        const input = encodeURIComponent(JSON.stringify({ "0": payload }));
        res = await fetch(`${url}?batch=1&input=${input}`, { headers });
      }
    } catch (e) { throw new Error(`Network Error: ${e.message}`); }
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
//  DETECTION MODULES  (split from monolithic analyzePlayer)
// ─────────────────────────────────────────────

/** Returns suspicion objects for automation-pattern heuristics */
const detectAutomation = (player, settings) => {
  const suspicions = [];

  if (player.sniperHits >= 5) {
    // NEW: time-of-day concentration check
    const hourCounts = {};
    (player.sniperDetails || []).forEach(s => {
      const h = new Date(s.offerTimeMs + s.timeMs).getUTCHours();
      hourCounts[h] = (hourCounts[h] || 0) + 1;
    });
    const maxHour = Object.entries(hourCounts).sort((a,b)=>b[1]-a[1])[0];
    const concentrationNote = maxHour && maxHour[1] >= Math.ceil(player.sniperHits * 0.6)
      ? ` All ${maxHour[1]} snipes concentrated in UTC hour ${maxHour[0]}:00 — strongly indicates automated scheduling.`
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
    // NEW: flag if pacing is within a single action type (stronger signal)
    const singleTypePacing = player.pacingSingleType
      ? ` All paced actions are of type "${player.pacingSingleType}" — single-action-type pacing is a near-certain script indicator.`
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

  // NEW: Mutual Hermit Pair detection
  if (player.isMutualHermit) {
    suspicions.push({
      type: 'mutual_hermit', severity: 'critical',
      desc: `Mutual Hermit Pair: This account and "${player.mutualHermitPartnerName}" trade almost exclusively with each other (bidirectional isolation). High probability of being the same operator.`,
      workers: [{ uid: player.id, normalizedName: player.name + " (SELF)", normalizedLevel: player.level || '?' }],
      detectionWeight: player.hermitTxCount || 5
    });
  }

  return suspicions;
};

/** Returns suspicion objects for economic network heuristics */
const detectEconomicNetwork = (player, allWorkers, settings, globalCache) => {
  const suspicions = [];

  // Item Market Wash Trading
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

      // Compute net profit for the ring leader perspective
      let bossNetProfit = 0;
      partnerList.forEach(p => bossNetProfit += (p.netProfit || 0));
      const isNetZero = Math.abs(bossNetProfit) < 0.01;

      suspicions.push({
        type: 'transaction_abuse', severity: isNetZero ? 'high' : 'critical',
        desc: `Item Market Wash Trading detected with ${descParts.join(' and ')}.${isNetZero ? ' Net profit is zero — possible technique testing or practice ring.' : ''}`,
        partners: partnerList, detectionWeight: isNetZero ? Math.max(1, Math.floor(detectionWeight * 0.5)) : detectionWeight
      });
    }
  }

  return { suspicions, totalCoinsWashed };
};

/** Returns suspicion objects for worker-level heuristics */
const detectWorkerPatterns = (allWorkers, settings, globalCache) => {
  const suspicions = [];
  const suspiciousWorkers = new Set();

  // Low wage
  const lowWageWorkers = allWorkers.filter(w => w.normalizedWage <= settings.suspiciousWageThreshold);
  if (lowWageWorkers.length >= 2) {
    suspicions.push({
      type: 'low_wage', severity: lowWageWorkers.length > 4 ? 'high' : 'medium',
      desc: `Found ${lowWageWorkers.length} workers with wages ≤ ${settings.suspiciousWageThreshold}`,
      workers: lowWageWorkers
    });
    lowWageWorkers.forEach(w => suspiciousWorkers.add(w));
  }

  // Naming pattern
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

  // Cloned progression
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

  // Symmetric wage — only consider active workers with fidelity >= 7 (loyal, invested workers)
  const highFidelityWorkers = allWorkers.filter(w => w.isActive !== false && w.normalizedFidelity >= 7 && w.normalizedWage > settings.suspiciousWageThreshold);
  const activeWages = highFidelityWorkers.map(w => w.normalizedWage);
  if (activeWages.length >= 4) {
    const mean = activeWages.reduce((a,b) => a+b, 0) / activeWages.length;
    const variance = activeWages.reduce((a,b) => a + Math.pow(b - mean, 2), 0) / activeWages.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev < 0.005) {
      suspicions.push({
        type: 'wage_uniformity', severity: 'high',
        desc: `Wage Uniformity: All ${activeWages.length} high-fidelity workers (≥7/10) paid identical wages of ${mean.toFixed(3)} coins (std dev: ${stdDev.toFixed(4)}). While wage negotiation is uncommon, perfectly identical wages across all long-term workers may indicate a single operator managing alts.`,
        workers: highFidelityWorkers,
        detectionWeight: activeWages.length
      });
    }
  }

  // Fidelity Maximization Ring
  const maxFidelityWorkers = allWorkers.filter(w => w.normalizedFidelity === 10 && w.isActive !== false);
  const totalActiveWorkers = allWorkers.filter(w => w.isActive !== false).length;
  if (maxFidelityWorkers.length >= 4) {
    const fidelityPct = totalActiveWorkers > 0 ? Math.round((maxFidelityWorkers.length / totalActiveWorkers) * 100) : 100;
    suspicions.push({
      type: 'fidelity_ring', severity: 'medium',
      desc: `Fidelity Ring: ${maxFidelityWorkers.length}/${totalActiveWorkers} active workers (${fidelityPct}%) have max fidelity (10/10). Legitimate workers often job-hop; a workforce this loyal may suggest controlled alt accounts.`,
      workers: maxFidelityWorkers, detectionWeight: maxFidelityWorkers.length
    });
    maxFidelityWorkers.forEach(w => suspiciousWorkers.add(w));
  }

  return { suspicions, suspiciousWorkers };
};

/** Returns suspicion objects for money laundering heuristics */
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

  // NEW: MU Donation Timing Correlation — check if workers donated within same 10-min window
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
      suspicions.push({ type: 'money_laundering', severity: 'critical', desc: `Massive outbound donations from this account. Likely a burner funnel.`, workers: [selfWorker], detectionWeight: 3 });
    }
    totalLaunderedCoins += player.directLaunderAmount;
    hasLaundering = true;
    launderingWorkerCount += 1;
  }

  return { suspicions, suspiciousWorkers, hasLaundering, launderingWorkerCount, totalLaunderedCoins };
};

/** Returns suspicion objects for shell company heuristics */
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

/** Level-relative wealth baseline — updated as players are scanned.
 *  Stores { companiesAtLevel, maxAELevelAtLevel } bucketed per 5-level band.
 *  Exported so processPlayer can call it after resolving each worker.
 */
const levelWealthBaseline = {};

const recordPlayerWealthBaseline = (level, companyCount, maxAELevel) => {
  const band = Math.floor((level || 1) / 5) * 5;
  if (!levelWealthBaseline[band]) levelWealthBaseline[band] = { companySamples: [], aeSamples: [] };
  if (companyCount > 0) levelWealthBaseline[band].companySamples.push(companyCount);
  if (maxAELevel > 0) levelWealthBaseline[band].aeSamples.push(maxAELevel);
};

const getBaselineForLevel = (level) => {
  const band = Math.floor((level || 1) / 5) * 5;
  // Walk up bands until we find one with enough samples
  for (let b = band; b <= 50; b += 5) {
    const bl = levelWealthBaseline[b];
    if (bl && bl.companySamples.length >= 5) {
      const sortedC = [...bl.companySamples].sort((a,b)=>a-b);
      const p75Companies = sortedC[Math.floor(sortedC.length * 0.75)];
      const sortedAE = [...bl.aeSamples].sort((a,b)=>a-b);
      const p75AE = sortedAE[Math.floor(sortedAE.length * 0.75)];
      return { p75Companies, p75AE, sampleSize: bl.companySamples.length };
    }
  }
  return null;
};

/** Account age vs wealth disparity detection — uses dynamic level baseline where available */
const detectAgeDateAnomaly = (player, allWorkers) => {
  const suspicions = [];
  const now = Date.now();

  const youngRichWorkers = [];

  allWorkers.forEach(w => {
    if (!w.resolvedUser?.createdAt) return;
    const age = now - new Date(w.resolvedUser.createdAt).getTime();
    const ageInDays = age / (24 * 60 * 60 * 1000);
    if (ageInDays >= 45) return; // Only flag accounts under 45 days old

    const level = w.normalizedLevel || 1;
    const companyCount = w.ownedCompanies?.length || 0;
    // Automated Engine level — look across all the worker's companies
    const maxAELevel = w.ownedCompanies
      ? Math.max(0, ...w.ownedCompanies.map(c => c.automatedEngine || c.aeLevel || c.engineLevel || 0))
      : 0;

    const baseline = getBaselineForLevel(level);
    let isSuspicious = false;
    let reason = '';

    if (baseline) {
      // Dynamic comparison: flag if significantly above p75 for their level
      const companyAnomaly = companyCount > baseline.p75Companies * 1.5 && companyCount >= 3;
      const aeAnomaly = maxAELevel >= 5 && (baseline.p75AE === 0 || maxAELevel > baseline.p75AE * 1.3);
      if (companyAnomaly || aeAnomaly) {
        isSuspicious = true;
        const parts = [];
        if (companyAnomaly) parts.push(`${companyCount} companies (p75 for level ${level}: ${baseline.p75Companies})`);
        if (aeAnomaly) parts.push(`AE level ${maxAELevel} (p75: ${baseline.p75AE || 0})`);
        reason = `${parts.join(' and ')} — significantly above peers at this level (n=${baseline.sampleSize}).`;
      }
    } else {
      // Fallback heuristic when no baseline data: flag high AE or many companies on very new accounts
      const companyAnomaly = companyCount >= 4 && level < 20;
      // AE level 5+ on accounts under 45 days is a strong signal regardless of level
      const aeAnomaly = maxAELevel >= 5 && ageInDays < 30;
      if (companyAnomaly || aeAnomaly) {
        isSuspicious = true;
        const parts = [];
        if (companyAnomaly) parts.push(`${companyCount} companies at level ${level}`);
        if (aeAnomaly) parts.push(`Automated Engine at level ${maxAELevel}`);
        reason = `${parts.join(' and ')} for an account only ${Math.floor(ageInDays)} days old.`;
      }
    }

    if (isSuspicious) {
      w.accountAgeDays = Math.floor(ageInDays);
      w.wealthReason = reason;
      w.wealthMaxAELevel = maxAELevel;
      youngRichWorkers.push(w);
    }
  });

  if (youngRichWorkers.length >= 1) {
    suspicions.push({
      type: 'newborn_wealthy', severity: youngRichWorkers.length >= 2 ? 'critical' : 'high',
      desc: `${youngRichWorkers.length} young worker account(s) show disproportionate wealth relative to age and level. This may indicate funding from a main account.`,
      workers: youngRichWorkers, detectionWeight: youngRichWorkers.length * 2
    });
  }

  // Check the boss account itself
  if (player.accountCreatedAt) {
    const ageDays = (now - new Date(player.accountCreatedAt).getTime()) / (24 * 60 * 60 * 1000);
    const companyCount = player.companies?.length || 0;
    const maxAELevel = player.companies
      ? Math.max(0, ...player.companies.map(c => c.automatedEngine || c.aeLevel || c.engineLevel || 0))
      : 0;
    const baseline = getBaselineForLevel(player.level);
    let bossFlag = false, bossReason = '';

    if (baseline && ageDays < 45) {
      const companyAnomaly = companyCount > baseline.p75Companies * 1.5 && companyCount >= 3;
      const aeAnomaly = maxAELevel >= 5 && (baseline.p75AE === 0 || maxAELevel > baseline.p75AE * 1.3);
      if (companyAnomaly || aeAnomaly) {
        bossFlag = true;
        const parts = [];
        if (companyAnomaly) parts.push(`${companyCount} companies`);
        if (aeAnomaly) parts.push(`AE level ${maxAELevel}`);
        bossReason = `${parts.join(' and ')} at level ${player.level} (p75 for level: ${baseline.p75Companies} cos, ${baseline.p75AE||0} AE). Account is only ${Math.floor(ageDays)} days old.`;
      }
    } else if (ageDays < 30 && companyCount >= 6) {
      bossFlag = true;
      bossReason = `${companyCount} companies at only ${Math.floor(ageDays)} days old, without enough baseline data to compare.`;
    } else if (ageDays < 30 && maxAELevel >= 5) {
      bossFlag = true;
      bossReason = `Automated Engine at level ${maxAELevel} on an account only ${Math.floor(ageDays)} days old.`;
    }

    if (bossFlag) {
      suspicions.push({
        type: 'newborn_wealthy', severity: 'high',
        desc: `Boss account may be a recently funded alt: ${bossReason}`,
        workers: [{ uid: player.id, normalizedName: player.name + " (SELF)", normalizedLevel: player.level || '?', accountAgeDays: Math.floor(ageDays), wealthReason: bossReason, wealthMaxAELevel: maxAELevel }],
        detectionWeight: 3
      });
    }
  }

  return suspicions;
};

/** NEW: Temporal activity clustering (sleep pattern) detection */
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

// ─────────────────────────────────────────────
//  MAIN ANALYZER  (orchestrates modules)
// ─────────────────────────────────────────────
const analyzePlayer = (player, settings, globalCache, actionTimes = [], _forceRun = false) => {
  if (!player) return null;

  let rawWorkers = player.companies ? player.companies.flatMap(c => c.workers || []) : [];
  const uniqueWorkersMap = new Map();
  rawWorkers.forEach(w => {
    const rawUser = w.user;
    const resolvedUserId = typeof rawUser === 'string' ? rawUser : (rawUser?._id || rawUser?.id || null);
    const uid = w._id || w.id || resolvedUserId || Math.random().toString(36).slice(2);
    w.uid = uid;
    // If user is an object with profile data, pre-populate resolvedUser
    if (typeof rawUser === 'object' && rawUser !== null && !w.resolvedUser) {
      w.resolvedUser = rawUser;
    }
    uniqueWorkersMap.set(uid, w);
  });
  let allWorkers = Array.from(uniqueWorkersMap.values());
  const washPartners = player.washPartners || {};
  const hasAdvancedFlags = player.sniperHits >= 5 || player.maxConcurrentTxs >= 5 || player.isHermit || player.isMutualHermit || player.pacingHits >= settings.pacingMinHits;
  if (!_forceRun && allWorkers.length < 2 && Object.keys(washPartners).length === 0 && !player.isDirectLaunderer && !hasAdvancedFlags) return null;

  // Normalize workers
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

  // Run all detection modules
  const automationSuspicions = detectAutomation(player, settings);
  const { suspicions: econSuspicions, totalCoinsWashed } = detectEconomicNetwork(player, allWorkers, settings, globalCache);
  const ageSuspicions = !settings.ringOfFireMode ? detectAgeDateAnomaly(player, allWorkers) : [];
  const temporalSuspicions = !settings.ringOfFireMode ? detectTemporalClustering(player, actionTimes) : [];

  let workerSuspicions = [], workerSuspiciousSet = new Set();
  let launderSuspicions = [], launderSuspiciousSet = new Set(), hasLaundering = false, launderingWorkerCount = 0, totalLaunderedCoins = 0;
  let shellSuspicions = [], shellSuspiciousSet = new Set(), zeroBonusCompanyCount = 0, bossNoBonusPercentage = 0;

  if (!settings.ringOfFireMode) {
    ({ suspicions: workerSuspicions, suspiciousWorkers: workerSuspiciousSet } = detectWorkerPatterns(allWorkers, settings, globalCache));
    ({ suspicions: launderSuspicions, suspiciousWorkers: launderSuspiciousSet, hasLaundering, launderingWorkerCount, totalLaunderedCoins } = detectLaundering(allWorkers, player, settings, globalCache));
    ({ suspicions: shellSuspicions, suspiciousWorkers: shellSuspiciousSet, zeroBonusCompanyCount, bossNoBonusPercentage } = detectShellCompanies(allWorkers, settings, globalCache));
  }

  const allSuspicions = [
    ...automationSuspicions,
    ...econSuspicions,
    ...ageSuspicions,
    ...temporalSuspicions,
    ...launderSuspicions,
    ...workerSuspicions,
    ...shellSuspicions,
  ];

  if (allSuspicions.length === 0) return null;

  // Build summary
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
  const ageSus = allSuspicions.find(s => s.type === 'newborn_wealthy');
  if (ageSus) summaryParts.push(`New accounts with disproportionate wealth detected.`);
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
    const order = ['coordinated_donation','money_laundering','transaction_abuse','market_automation','superhuman_apm','script_pacing','mutual_hermit','hermit_network','newborn_wealthy'];
    const ai = order.indexOf(a.type); const bi = order.indexOf(b.type);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1; if (bi !== -1) return 1;
    return (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0);
  });

  return {
    player, summary: summaryParts.join(' '), suspicions: allSuspicions,
    detections: allSuspicions.reduce((acc, s) => acc + (s.detectionWeight !== undefined ? s.detectionWeight : (s.workers?.length || s.partners?.length || 1)), 0),
    zeroBonusCompanyCount, bossNoBonusPercentage, hasLaundering, launderingWorkerCount,
    totalLaunderedCoins, washPartners, washPartnerCount: Object.keys(washPartners).length, totalCoinsWashed,
    // Attach contribution breakdown for tooltip
    scoreBreakdown: allSuspicions.map(s => ({
      type: s.type, weight: s.detectionWeight !== undefined ? s.detectionWeight : (s.workers?.length || s.partners?.length || 1), severity: s.severity
    }))
  };
};

// ─────────────────────────────────────────────
//  PHASE 1 ANALYZER  (transaction-derived only, no workers)
// ─────────────────────────────────────────────
const analyzePhase1 = (player, settings, globalCache) => {
  if (!player) return null;

  const washPartners = player.washPartners || {};
  const hasAdvancedFlags = player.sniperHits >= 5 || player.maxConcurrentTxs >= 5 ||
    player.isHermit || player.isMutualHermit || player.pacingHits >= settings.pacingMinHits;

  if (Object.keys(washPartners).length === 0 && !player.isDirectLaunderer &&
      !hasAdvancedFlags && !player.tipAbuse) return null;

  const automationSuspicions = detectAutomation(player, settings);
  const { suspicions: econSuspicions, totalCoinsWashed } = detectEconomicNetwork(player, [], settings, globalCache);

  const allSuspicions = [...automationSuspicions, ...econSuspicions];

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
      desc: 'Massive outbound donations from this account. Likely a burner funnel.',
      workers: [selfWorker], detectionWeight: 3
    });
  }

  if (player.tipAbuse) {
    const { heavyTippers, repeatTippers } = player.tipAbuse;
    allSuspicions.push({
      type: 'tip_farming', severity: 'high',
      desc: `Article Tip Farming: ${heavyTippers} account(s) tipped this player 5+ times; ${repeatTippers} unique account(s) tipped 3+ times. Coordinated engagement inflation.`,
      workers: [{ uid: player.id, normalizedName: player.name + ' (SELF)', normalizedLevel: player.level || '?' }],
      detectionWeight: heavyTippers * 2 + repeatTippers
    });
  }

  if (allSuspicions.length === 0) return null;

  allSuspicions.sort((a, b) => {
    const order = ['money_laundering', 'transaction_abuse', 'market_automation', 'superhuman_apm', 'script_pacing', 'mutual_hermit', 'hermit_network', 'tip_farming'];
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
  if (player.tipAbuse) summaryParts.push(`Article tip farming (${player.tipAbuse.heavyTippers} heavy, ${player.tipAbuse.repeatTippers} repeat tippers).`);
  const abuseSus = allSuspicions.find(s => s.type === 'transaction_abuse');
  if (abuseSus) summaryParts.push(`Wash Trading ring with ${abuseSus?.partners?.length || 0} partners.`);

  const detections = allSuspicions.reduce((acc, s) => acc + (s.detectionWeight !== undefined ? s.detectionWeight : (s.workers?.length || s.partners?.length || 1)), 0);

  return {
    player,
    summary: summaryParts.join(' ') || 'Phase 1 transaction flags — load worker analysis for full details.',
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

// ─────────────────────────────────────────────
//  UNION FIND
// ─────────────────────────────────────────────
class UnionFind {
  constructor() { this.parent = {}; }
  add(id) { if (!this.parent[id]) this.parent[id] = id; }
  find(id) { if (this.parent[id] !== id) this.parent[id] = this.find(this.parent[id]); return this.parent[id]; }
  union(id1, id2) { this.add(id1); this.add(id2); const r1=this.find(id1),r2=this.find(id2); if(r1!==r2) this.parent[r2]=r1; }
}

// ─────────────────────────────────────────────
//  WASH NETWORK TREE
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
//  TREE NODE
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
//  SCORE BREAKDOWN TOOLTIP
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
//  ACTIVITY HEATMAP (for temporal clustering)
// ─────────────────────────────────────────────
const ActivityHeatmap = ({ hourBuckets }) => {
  if (!hourBuckets) return null;
  const max = Math.max(...hourBuckets, 1);
  return (
    <div className="mt-2">
      <div className="text-[10px] text-slate-500 mb-1">UTC Hour Activity (0–23)</div>
      <div className="flex gap-0.5">
        {hourBuckets.map((v, h) => {
          const intensity = v / max;
          const bg = intensity === 0 ? 'bg-slate-900' : intensity < 0.3 ? 'bg-pink-900/40' : intensity < 0.6 ? 'bg-pink-700/60' : 'bg-pink-500';
          return <div key={h} className={`h-6 flex-1 rounded-sm ${bg} relative group`} title={`UTC ${h}:00 — ${v} actions`}><div className="hidden group-hover:block absolute bottom-full left-1/2 -translate-x-1/2 bg-slate-800 text-slate-200 text-[9px] px-1 rounded whitespace-nowrap">{h}:00 ({v})</div></div>;
        })}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
//  MAIN APP
// ─────────────────────────────────────────────
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
    ringOfFireMode: false,
    rofDays: 30,
    sniperThresholdMs: 2500,
    apmWindowMs: 500,
    pacingToleranceMs: 50,
    pacingMinHits: 6,
    verboseDebug: false,
    phase2AutoThreshold: 3,
  });
  const [apiKey, setApiKey] = useState('');
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
  const globalCacheRef = useRef({ countries: {}, regions: {}, names: {} });
  const globalWashPartners = useRef({});
  const globalBans = useRef({});
  const globalHermitPrimaries = useRef({}); // uid -> { partnerId, volume }
  const phase2DataRef = useRef({});
  const didLogTipPayloadRef = useRef(false);
  const scanQueueRef = useRef([]);
  // (worker endpoint is now fixed to worker.getWorkers with companyId — no ref needed)

  // ── Filter / Sort state ──
  const [filterType, setFilterType] = useState('all');
  const [sortMode, setSortMode] = useState('score_desc'); // score_desc, score_asc, name_asc
  const [minScore, setMinScore] = useState(0);
  const [showFilterPanel, setShowFilterPanel] = useState(false);

  // ── Session persistence ──
  const [savedSession, setSavedSession] = useState(null);
  const [showRestorePrompt, setShowRestorePrompt] = useState(false);

  // ── Import / export / clipboard ──
  const fileInputRef = useRef(null);
  const [copiedId, setCopiedId] = useState(null);

  const addLog = useCallback((msg, type='info') => {
    if (type === 'debug' && !settings.verboseDebug) return;
    setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), msg, type }]);
  }, [settings.verboseDebug]);

  useEffect(() => {
    if (showLogs && logsContainerRef.current) logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
  }, [logs, showLogs]);

  useEffect(() => {
    const ticker = setInterval(() => setTick(t => t+1), 250);
    return () => clearInterval(ticker);
  }, []);

  useEffect(() => {
    if (apiKey && apiKey.trim().length > 20 && availableRegions.length === 0 && !isScanning) fetchRegions();
  }, [apiKey]);

  // Load saved session from storage on mount
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

  // Save session whenever findings change
  useEffect(() => {
    if (Object.keys(findings).length > 0) {
      try {
        sessionStorage.setItem('warera_oracle_session', JSON.stringify({ findings, savedAt: Date.now() }));
      } catch(e) {}
    }
  }, [findings]);

  const getToken = async (forceOfficial=false) => {
    while (isScanningRef.current) {
      while (globalRateLimitRelease.current > Date.now()) {
        if (!isScanningRef.current) throw new Error("Scan Aborted");
        const waitMs = globalRateLimitRelease.current - Date.now();
        setIsRateLimited(true);
        setLimitTimer(Math.ceil(waitMs / 1000));
        setCurrentTask(`PAUSED: API COOLDOWN (${Math.ceil(waitMs/1000)}s remaining)`);
        await new Promise(r => setTimeout(r, 500));
      }
      if (isRateLimited) {
        setIsRateLimited(false);
        setCurrentTask(`Executing Concurrency Pool (x${settings.concurrencyLimit})...`);
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
      globalRateLimitRelease.current = Date.now() + waitMs;
    }
    throw new Error("Scan Aborted");
  };

  const smartFetch = async (endpoint, payload, forceOfficial=false) => {
    // Try the Vercel Redis cache proxy first (1.5s timeout — fall through on any failure)
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);
      const cacheRes = await fetch('/api/cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint, payload, forceOfficial, apiKey: apiKey.trim() }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (cacheRes.ok) {
        const cacheJson = await cacheRes.json();
        if (cacheJson?.data !== undefined) return cacheJson.data;
      }
    } catch(e) { /* cache proxy unavailable or timed out — fall through to direct */ }

    // Direct path (used when running outside Vercel, or proxy failed)
    let route;
    if (isScanningRef.current) { route = await getToken(forceOfficial); }
    else { route = forceOfficial ? 'official' : (isGatewayDead.current ? 'official' : 'gateway'); }
    const baseUrl = route === 'gateway' ? 'https://gateway.warerastats.io/trpc/' : 'https://api2.warera.io/trpc/';
    const activeKey = apiKey.trim();
    try {
      return await WarEraAPI.fetch(endpoint, payload, activeKey, baseUrl);
    } catch (e) {
      if (e.message.includes('RATE LIMIT')) {
        globalRateLimitRelease.current = Date.now() + 10000;
        addLog(`[WARNING] HTTP 429 on ${route.toUpperCase()}. Pausing all threads...`, 'warning');
        while (globalRateLimitRelease.current > Date.now()) {
          if (!isScanningRef.current) throw new Error("Scan Aborted");
          await new Promise(r => setTimeout(r, 500));
        }
        return await smartFetch(endpoint, payload, forceOfficial);
      }
      const msg = e.message.toLowerCase();
      const isSchemaErr = msg.includes('no procedure') || msg.includes('too_big') || msg.includes('unrecognized key') || msg.includes('invalid_type');
      if (route === 'gateway' && !isSchemaErr) {
        gatewayFails.current += 1;
        if (gatewayFails.current >= 4 && !isGatewayDead.current) {
          isGatewayDead.current = true;
          addLog(`[CRITICAL] Gateway failed 4 times. Circuit Breaker tripped. Falling back to Official API.`, 'warning');
          setTimeout(() => { if (isScanningRef.current) { isGatewayDead.current=false; gatewayFails.current=0; addLog(`[INFO] Gateway routing resurrected.`, 'info'); } }, 60000);
        } else if (!isGatewayDead.current) {
          addLog(`[DEBUG] Gateway miss (${endpoint}): ${e.message.split('\n')[0]}. Falling back...`, 'debug');
        }
        const isOfficialEnabled = apiKey && apiKey.trim() !== '';
        if (!isOfficialEnabled) throw new Error("Gateway failed and no Live API Key provided for fallback.");
        return await smartFetch(endpoint, payload, true);
      }
      throw e;
    }
  };

  const fetchRegions = async () => {
    addLog('Pinging WarEra API for regions...', 'info');
    // Use the official API directly — this runs outside a scan so smartFetch
    // would route through the cache proxy which may not be available locally.
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey && apiKey.trim()) headers['X-API-Key'] = apiKey.trim();

    const directFetch = async (endpoint, payload = {}) => {
      // Try gateway first, then official
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
        } catch(e) { /* try next */ }
      }
      throw new Error(`${endpoint} unreachable`);
    };

    try {
      // Step 1: countries (dropdown list + specialization cache)
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

      // Step 2: region map (used for production bonus checks)
      // region.getRegionsObject returns { regionId: regionObj, ... } — an object, not array
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
    for (const ep of ['company.getCompanies']) {
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

  // ── PHASE 1: transaction-derived analysis (runs for every player) ──
  const processPlayerPhase1 = async (playerObj) => {
    const uId = playerObj._id || playerObj.id;
    let foundName = playerObj.username || playerObj.name || 'Unknown';
    let bossMuId = null, hasMuLeadership = false;

    try {
      const uData = await smartFetch('user.getUserLite', { userId: uId });
      if (uData) {
        foundName = uData.username || uData.name || foundName;
        playerObj.level = uData.leveling?.level || '?';
        playerObj.accountCreatedAt = uData.createdAt || uData.registeredAt || null;
        if (uData.isBanned || uData.banned) { addLog(`[OK] ${foundName} cleared (banned).`, 'info'); return; }
        if (!settings.ringOfFireMode) {
          bossMuId = uData.mu ? (typeof uData.mu==='object'?uData.mu._id||uData.mu.id:uData.mu) : (uData.militaryUnit?(typeof uData.militaryUnit==='object'?uData.militaryUnit._id||uData.militaryUnit.id:uData.militaryUnit):(uData.muId||null));
        }
      }
    } catch(e) { addLog(`[DEBUG] getUserLite failed for ${uId}: ${e.message}`, 'debug'); }

    if (!settings.ringOfFireMode && bossMuId) {
      try {
        const muData = await smartFetch('mu.getById', { muId: bossMuId });
        if (muData) {
          const managers = muData.roles?.managers || [];
          const commanders = muData.roles?.commanders || [];
          if (managers.includes(uId) || commanders.includes(uId)) hasMuLeadership = true;
        }
      } catch(e) {}
    }

    // ── Fetch item market transactions ──
    let itemMarketTxs = [];
    const lookbackDays = settings.ringOfFireMode ? settings.rofDays : 60;
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
    } catch(e) { addLog(`[DEBUG] itemMarket fetch failed for ${foundName}: ${e.message}`, 'debug'); }

    // ── Compute automation metrics ──
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

    // ── Wash trading ──
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

    // ── Hermit centrality ──
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
        for(let i=0;i<txs.length-1;i++){const tx1=txs[i];const s1=typeof tx1.seller==='object'?tx1.seller?._id:(tx1.sellerId||tx1.seller);const b1=typeof tx1.buyer==='object'?tx1.buyer?._id:(tx1.buyerId||tx1.buyer);for(let j=i+1;j<txs.length;j++){const tx2=txs[j];const s2=typeof tx2.seller==='object'?tx2.seller?._id:(tx2.sellerId||tx2.seller);const b2=typeof tx2.buyer==='object'?tx2.buyer?._id:(tx2.buyerId||tx2.buyer);const p1=parseFloat(tx1.money||tx1.price||tx1.value||0);const p2=parseFloat(tx2.money||tx2.price||tx2.value||0);if(s1===primaryBossId&&b1===uId&&s2===uId&&b2!==primaryBossId){itemsSoldToMarketAfter++;profitFromMarketAfter+=(p2-p1);}if(s1!==primaryBossId&&b1===uId&&s2===uId&&b2===primaryBossId){itemsSoldToBossAfter++;profitFromBossAfter+=(p2-p1);}}}
      });
      if (itemsSoldToMarketAfter>0) hermitResaleDetails+=` | Resale: ${itemsSoldToMarketAfter} items to Market (Net: ${profitFromMarketAfter>0?'+':''}${profitFromMarketAfter.toFixed(1)})`;
      else if (itemsSoldToBossAfter>0) hermitResaleDetails+=` | Resale: ${itemsSoldToBossAfter} items back to Boss (Net: ${profitFromBossAfter>0?'+':''}${profitFromBossAfter.toFixed(1)})`;
    }

    let isDirectLaunderer=false, directLaunderAmount=0;
    let pacingHits=0, pacingAvgMs=0, pacingEdges=[], pacingSingleType=null;
    let tipAbuse = null;

    if (!settings.ringOfFireMode) {
      // Fetch donations, articleTip (recipient), and pacing actions in parallel
      const [outTxResult, tipTxResult, ...pacingTxResults] = await Promise.allSettled([
        smartFetch('transaction.getPaginatedTransactions', { transactionType: 'donation', userId: uId, limit: 100 }),
        smartFetch('transaction.getPaginatedTransactions', { transactionType: 'articleTip', userId: uId, limit: 100 }),
        smartFetch('transaction.getPaginatedTransactions', { transactionType: 'openCase', userId: uId, limit: 100 }),
        smartFetch('transaction.getPaginatedTransactions', { transactionType: 'craftItem', userId: uId, limit: 100 }),
        smartFetch('transaction.getPaginatedTransactions', { transactionType: 'dismantleItem', userId: uId, limit: 100 }),
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

      // ── articleTip: log payload shape, then detect tip farming ──
      if (tipTxResult.status === 'fulfilled') {
        const tipItems = Array.isArray(tipTxResult.value) ? tipTxResult.value : (tipTxResult.value?.items||tipTxResult.value?.data||tipTxResult.value?.transactions||[]);
        if (!didLogTipPayloadRef.current) {
          didLogTipPayloadRef.current = true;
          addLog(`[TIP PAYLOAD] raw top-level: ${JSON.stringify(tipTxResult.value).substring(0, 400)}`, 'info');
          if (tipItems.length > 0) addLog(`[TIP PAYLOAD] item[0]: ${JSON.stringify(tipItems[0])}`, 'info');
        }
        const tipperCounts = {};
        tipItems.forEach(tx => {
          const recipientId = typeof tx.recipient==='object' ? (tx.recipient?._id||tx.recipient?.id) : (tx.recipientId||tx.receiverId||tx.receiver||tx.toId||tx.to);
          const tipperId = typeof tx.sender==='object' ? (tx.sender?._id||tx.sender?.id) : (tx.senderId||tx.sender||tx.fromId||tx.from||tx.authorId);
          if (recipientId===uId && tipperId && tipperId!==uId) {
            tipperCounts[tipperId] = (tipperCounts[tipperId]||0) + 1;
          }
        });
        const heavyTippers = Object.values(tipperCounts).filter(c => c >= 5).length;
        const repeatTippers = Object.values(tipperCounts).filter(c => c >= 3).length;
        if (heavyTippers >= 1 || repeatTippers >= 2) tipAbuse = { heavyTippers, repeatTippers, tipperCounts };
      } else {
        addLog(`[DEBUG] articleTip fetch failed for ${foundName}: ${tipTxResult.reason?.message}`, 'debug');
      }

      ['openCase','craftItem','dismantleItem'].forEach((aType, idx) => {
        const r = pacingTxResults[idx];
        if (r.status === 'fulfilled') {
          const items = Array.isArray(r.value) ? r.value : (r.value?.items||r.value?.data||r.value?.transactions||[]);
          items.forEach(tx => {
            const txTime=new Date(tx.createdAt||tx.timestamp||tx.date||Date.now()).getTime();
            if (txTime>=cutoffTime) actionTimes.push({ time: txTime, type: aType });
          });
        } else { addLog(`[DEBUG] ${aType} pacing fetch failed: ${r.reason?.message}`, 'debug'); }
      });

      playerObj.isDirectLaunderer=isDirectLaunderer; playerObj.directLaunderAmount=directLaunderAmount;

      // ── Pacing detection ──
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

    // ── Early return: no phase-1 signals ──
    const hasP1Flags = Object.keys(washPartners).length > 0 || isDirectLaunderer ||
      sniperHits >= 5 || maxConcurrentTxs >= 5 || isHermit || isMutualHermit ||
      pacingHits >= settings.pacingMinHits || tipAbuse !== null;

    if (!hasP1Flags) { addLog(`[OK] ${foundName} cleared (no transaction flags).`, 'info'); return; }

    const livePlayer = {
      id: uId, name: foundName, isBanned: playerObj.isBanned, country: playerObj.scanContext||'Unknown Target',
      companies: [],
      washPartners, isDirectLaunderer, directLaunderAmount,
      sniperHits, sniperDetails, maxConcurrentTxs, apmDetails: { avgGapMs: apmAvgGapMs, txs: worstApmWindow },
      pacingHits: playerObj.pacingHits||0, pacingAvgMs: playerObj.pacingAvgMs||0, pacingEdges: playerObj.pacingEdges||[],
      pacingSingleType: playerObj.pacingSingleType||null,
      totalMarketVolume, uniqueTradingPartnersSize: uniqueTradingPartners.size,
      isHermit, isMutualHermit, mutualHermitPartnerName: isMutualHermit ? (globalCacheRef.current.names[primaryBossId]||primaryBossId) : null,
      centralityPercentage, hermitTxCount, hermitResaleDetails, hermitBossId: primaryBossId, hermitBossName,
      accountCreatedAt: playerObj.accountCreatedAt,
      tipAbuse,
    };

    if (!settings.ringOfFireMode) {
      phase2DataRef.current[uId] = { livePlayer, actionTimes, hasMuLeadership, bossMuId, foundName, country: livePlayer.country };
    }

    const phase1Result = analyzePhase1(livePlayer, settings, globalCacheRef.current);
    if (phase1Result) {
      phase1Result.phase2Status = settings.ringOfFireMode ? 'complete' : 'pending';
      addLog(`[WARNING] Phase 1 flags: ${foundName} (score ${phase1Result.detections})`, 'warning');
      setFindings(prev => {
        const newState = { ...prev };
        if (!newState[livePlayer.country]) newState[livePlayer.country]=[];
        if (!newState[livePlayer.country].some(r=>r.player.id===phase1Result.player.id)) newState[livePlayer.country].push(phase1Result);
        return newState;
      });
      if (!settings.ringOfFireMode && phase1Result.detections >= settings.phase2AutoThreshold) {
        await processPlayerPhase2(uId, livePlayer.country, true);
      }
    } else {
      addLog(`[OK] ${foundName} cleared.`, 'info');
    }
  };

  // ── PHASE 2: worker analysis (runs on-demand or when phase-1 score >= threshold) ──
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

      if (parsedCompanies.length > 0) {
        await Promise.all(parsedCompanies.map(async company => {
          if (fromScan && !isScanningRef.current) return;
          const cId=company._id||company.id;
          try {
            const rawWorkers=await smartFetch('worker.getWorkers', { companyId: cId });
            let flatWorkers=Array.isArray(rawWorkers)?rawWorkers:(rawWorkers?.workers||Object.values(rawWorkers||{}));
            flatWorkers=flatWorkers.flat(3).filter(w=>typeof w==='object'&&w!==null);
            await Promise.all(flatWorkers.map(async w => {
              const rawUser = w.user;
              const userId = typeof rawUser === 'string' ? rawUser : (rawUser?._id||rawUser?.id||rawUser?.userId||null);
              if (typeof rawUser === 'object' && rawUser !== null && (rawUser.username||rawUser.name)) {
                w.resolvedUser = w.resolvedUser || rawUser;
              }
              if (userId) {
                try {
                  const uData = w.resolvedUser?.username ? w.resolvedUser : await smartFetch('user.getUserLite', { userId });
                  if (uData) {
                    w.resolvedUser=uData; w.isBanned=!!(uData.isBanned||uData.banned||uData.infos?.isBanned);
                    globalCacheRef.current.names[userId]=uData.username||uData.name||userId;
                    let workerMuId=uData.mu?(typeof uData.mu==='object'?uData.mu._id||uData.mu.id:uData.mu):(uData.militaryUnit?(typeof uData.militaryUnit==='object'?uData.militaryUnit._id||uData.militaryUnit.id:uData.militaryUnit):(uData.muId||null));
                    w.workerMuId=workerMuId;
                  }
                  const level=uData?.leveling?.level||1;
                  const isActive=uData?.isActive;
                  if (isActive!==false&&level<30) w.ownedCompanies=await fetchUserCompaniesFull(userId);
                  else w.ownedCompanies=[];
                  const workerAELevel = w.ownedCompanies ? Math.max(0, ...w.ownedCompanies.map(c => c.automatedEngine||c.aeLevel||c.engineLevel||0)) : 0;
                  recordPlayerWealthBaseline(level, w.ownedCompanies?.length||0, workerAELevel);
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

      const fullPlayer = { ...livePlayer, companies: parsedCompanies };
      const result = analyzePlayer(fullPlayer, settings, globalCacheRef.current, actionTimes, true);

      setFindings(prev => {
        const newState = { ...prev };
        if (!newState[country]) newState[country] = [];
        const idx = newState[country].findIndex(r => r.player.id === playerId);
        if (result) {
          result.phase2Status = 'complete';
          if (idx >= 0) newState[country][idx] = result;
          else newState[country].push(result);
        } else {
          if (idx >= 0) newState[country][idx] = { ...newState[country][idx], phase2Status: 'complete' };
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

  const startScan = async () => {
    setIsScanning(true); isScanningRef.current=true; setProgress(0); setFindings({}); setLogs([]);
    gatewayFails.current=0; isGatewayDead.current=false; globalRateLimitRelease.current=0; setIsRateLimited(false);
    globalWashPartners.current={}; globalBans.current={}; globalHermitPrimaries.current={};
    phase2DataRef.current={}; didLogTipPayloadRef.current=false;
    scanQueueRef.current=[];
    // worker endpoint is fixed, no refs to reset

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

    if (targetUserId) {
      let actualTargetId=targetUserId.trim();
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
          else { addLog(`[CRITICAL] Could not resolve "${targetUserId}".`, 'warning'); setIsScanning(false); isScanningRef.current=false; setCurrentTask('Idle'); return; }
        } catch(e) { addLog(`Search failed: ${e.message}`, 'warning'); }
      }
      scanQueueRef.current=[{ _id: actualTargetId, scanContext: 'Targeted User' }];
    } else if (targetRegionId) {
      let targetRegions = targetRegionId==='ALL' ? availableRegions.map(r=>r._id||r.id) : [targetRegionId];
      let allCitizens=[];
      for (const regionId of targetRegions) {
        if (!isScanningRef.current) break;
        const rName=availableRegions.find(r=>(r._id||r.id)===regionId)?.name||regionId;
        let success=false;
        for (const ep of ['user.getUsersByCountry']) {
          if (success) break;
          let nextCursor=null, page=1, hasMore=true, loopSeenSet=new Set();
          try {
            do {
              if (!isScanningRef.current) break;
              while (globalRateLimitRelease.current>Date.now()) await new Promise(r=>setTimeout(r,500));
              const payload={countryId:regionId,limit:100};
              if (nextCursor) payload.cursor=nextCursor; else if (page>1) payload.page=page;
              const res=await smartFetch(ep,payload);
              let pageData=Array.isArray(res)?res:(res?.data||res?.items||res?.citizens||Object.values(res||{}));
              pageData=pageData.flat(3).filter(c=>typeof c==='object'&&c!==null);
              let newCount=0; const uniqueC=[];
              pageData.forEach(c=>{ const id=c._id||c.id||c.userId; if(!loopSeenSet.has(id)){loopSeenSet.add(id);c.scanContext=rName;uniqueC.push(c);newCount++;} });
              if (uniqueC.length>0) { allCitizens.push(...uniqueC); success=true; }
              if (pageData.length===0||newCount===0) hasMore=false;
              else {
                const nextC=res?.nextCursor||res?.meta?.nextCursor||null;
                if (nextC) { nextCursor=nextC; hasMore=true; }
                else if (pageData.length>=100) hasMore=true;
                else hasMore=false;
                if (hasMore) page++;
              }
              if (allCitizens.length>(targetRegionId==='ALL'?100000:2000)) { hasMore=false; break; }
            } while (hasMore);
          } catch(e) { addLog(`[DEBUG] ${ep} failed: ${e.message.substring(0,80)}`, 'debug'); }
        }
      }
      const finalMap=new Map(); allCitizens.forEach(c=>{ const id=c._id||c.id||c.userId; finalMap.set(id,c); });
      allCitizens=Array.from(finalMap.values());
      if (allCitizens.length>0) { addLog(`✅ ${allCitizens.length} users acquired.`, 'info'); scanQueueRef.current=allCitizens; }
    }

    if (scanQueueRef.current.length===0) { addLog(`[CRITICAL] No targets acquired.`, 'warning'); setIsScanning(false); isScanningRef.current=false; setCurrentTask('Idle'); return; }

    const processedIds=new Set(); let playersScanned=0; let activePromises=[];
    setCurrentTask(`Executing Concurrency Pool (x${settings.concurrencyLimit})...`);
    try {
      while (isScanningRef.current&&(scanQueueRef.current.length>0||activePromises.length>0)) {
        while (scanQueueRef.current.length>0&&activePromises.length<settings.concurrencyLimit) {
          const player=scanQueueRef.current.shift();
          const pid=player._id||player.id;
          if (processedIds.has(pid)) continue; processedIds.add(pid);
          const p=(async()=>{ await new Promise(r=>setTimeout(r,10)); try { await processPlayerPhase1(player); } catch(err) { addLog(`[CRITICAL] Engine crash on ${player.name||player._id}: ${err.message}`, 'warning'); } })();
          p.finally(()=>{ activePromises=activePromises.filter(pr=>pr!==p); playersScanned++; const total=playersScanned+activePromises.length+scanQueueRef.current.length; setProgress(Math.floor((playersScanned/total)*100)); });
          activePromises.push(p);
        }
        if (activePromises.length>0) await Promise.race(activePromises);
        else await new Promise(r=>setTimeout(r,100));
      }
      await Promise.all(activePromises);
    } finally {
      setIsRateLimited(false);
      if (isScanningRef.current) { setCurrentTask('Scan Complete'); setProgress(100); addLog('Scan sequence terminated.', 'info'); }
      setIsScanning(false); isScanningRef.current=false;
    }
  };

  const abortScan = () => { setIsScanning(false); isScanningRef.current=false; setIsRateLimited(false); setCurrentTask('Scan Aborted'); addLog('Scan manually aborted.', 'warning'); };

  // ── Export all findings (full-fidelity — can be re-imported) ──
  const exportFindings = () => {
    const data = {
      _oracleExport: true,
      exportedAt: new Date().toISOString(),
      totalFlags: Object.values(findings).flat().length,
      findings,  // full result objects so they can be restored
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=`warera-oracle-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Export a single player's findings ──
  const exportSinglePlayer = (result) => {
    const data = {
      _oracleExport: true,
      exportedAt: new Date().toISOString(),
      totalFlags: 1,
      findings: { [result.player.country]: [result] },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=`oracle-${result.player.name}-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Import JSON file and restore findings ──
  const handleImportJson = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        if (!parsed._oracleExport || !parsed.findings) {
          alert('Invalid Oracle export file. Make sure you exported from WarEra Oracle.');
          return;
        }
        setFindings(parsed.findings); // clear and replace — import is authoritative
        addLog(`✅ Imported ${Object.values(parsed.findings).flat().length} findings from ${file.name}`, 'info');
      } catch(err) {
        alert(`Failed to parse file: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // reset so same file can be re-imported
  };

  // ── Build 500-char summary for clipboard ──
  const buildShortSummary = (result) => {
    const name = result.player.name;
    const parts = [];

    // Money laundering
    const launderSus = result.suspicions.find(s => s.type === 'money_laundering');
    if (launderSus) {
      const workerNames = launderSus.workers.filter(w => !w.normalizedName.includes('(SELF)')).map(w => w.normalizedName);
      const total = result.totalLaunderedCoins?.toFixed(1) || '?';
      if (workerNames.length > 0) parts.push(`${workerNames.length} worker(s) (${workerNames.slice(0,3).join(', ')}${workerNames.length>3?'…':''}) donated ${total} coins to ${name}'s MU in large transactions.`);
      else parts.push(`${name} sent ${total} coins to their MU in large outbound donations.`);
    }

    // Wash trading
    const washSus = result.suspicions.find(s => s.type === 'transaction_abuse');
    if (washSus) {
      const banned = (washSus.partners || []).filter(p => p.isBanned);
      const netProfit = (washSus.partners || []).reduce((s,p) => s + (p.netProfit || 0), 0);
      const profitStr = Math.abs(netProfit) < 0.01 ? 'no net gain' : netProfit > 0 ? `gaining ${netProfit.toFixed(1)} coins` : `losing ${Math.abs(netProfit).toFixed(1)} coins`;
      parts.push(`Ring-traded with ${(washSus.partners||[]).length} partner(s) (${profitStr})${banned.length > 0 ? `, ${banned.length} since banned` : ''}.`);
    }

    // Low wage
    const wageSus = result.suspicions.find(s => s.type === 'low_wage');
    if (wageSus) parts.push(`${wageSus.workers.length} workers paid minimum wage.`);

    // Cloned skills
    const cloneSus = result.suspicions.filter(s => s.type === 'cloned_progression');
    if (cloneSus.length > 0) {
      const total = cloneSus.reduce((s,c) => s + c.workers.length, 0);
      parts.push(`${total} workers have cloned skills.`);
    }

    // Shell companies
    const shellSus = result.suspicions.find(s => s.type === 'no_production_bonus');
    if (shellSus && result.bossNoBonusPercentage > 0) parts.push(`${result.bossNoBonusPercentage}% of worker companies have no regional production bonuses.`);

    // Naming patterns
    const nameSus = result.suspicions.filter(s => s.type === 'naming_pattern');
    if (nameSus.length > 0) {
      const groupStrings = nameSus.map(s => `(${s.workers.map(w=>w.normalizedName).join(', ')})`).join(', ');
      parts.push(`Workers with overlapping names: ${groupStrings}.`);
    }

    // Sniper
    const sniperSus = result.suspicions.find(s => s.type === 'market_automation');
    if (sniperSus) parts.push(`Sniper bot: bought ${result.player.sniperHits} items within ${settings.sniperThresholdMs}ms of listing.`);

    // Pacing
    const paceSus = result.suspicions.find(s => s.type === 'script_pacing');
    if (paceSus) parts.push(`Script pacing: ${result.player.pacingHits} actions at ~${result.player.pacingAvgMs}ms intervals.`);

    let summary = parts.join(' ');
    // Trim to 500 chars, breaking at a word boundary
    if (summary.length > 500) {
      summary = summary.substring(0, 497).replace(/\s\S*$/, '') + '…';
    }
    return summary;
  };

  const copySummaryToClipboard = (result) => {
    const text = buildShortSummary(result);
    // navigator.clipboard requires a secure top-level context; use textarea fallback
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  };

  const fallbackCopy = (text) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); } catch(e) { console.warn('Copy failed', e); }
    document.body.removeChild(ta);
  };

  // ── Re-scan a single player ──
  const rescanPlayer = (playerId, country) => {
    delete phase2DataRef.current[playerId];
    setFindings(prev => { const n={...prev}; if(n[country]) n[country]=n[country].filter(r=>r.player.id!==playerId); return n; });
    scanQueueRef.current.unshift({ _id: playerId, scanContext: country });
    if (!isScanningRef.current) {
      setIsScanning(true); isScanningRef.current=true; setProgress(0);
      setCurrentTask('Re-scanning player...');
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

  // ── Derived token metrics ──
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

  const getBadgeClass = (detections) => {
    if (detections>=15) return 'bg-fuchsia-900/50 text-fuchsia-400 border-fuchsia-800';
    if (detections>=10) return 'bg-red-900/50 text-red-400 border-red-800';
    if (detections>=5) return 'bg-yellow-900/50 text-yellow-400 border-yellow-800';
    return 'bg-slate-800 text-slate-400 border-slate-700';
  };

  // ── Filter + sort findings ──
  const getFilteredFindings = (countryFindings) => {
    let results = [...countryFindings];
    if (filterType !== 'all') results = results.filter(r => r.suspicions.some(s => s.type === filterType));
    if (minScore > 0) results = results.filter(r => (r.adjustedDetections ?? r.detections) >= minScore);
    if (sortMode === 'score_desc') results.sort((a,b) => (b.adjustedDetections??b.detections)-(a.adjustedDetections??a.detections));
    else if (sortMode === 'score_asc') results.sort((a,b) => (a.adjustedDetections??a.detections)-(b.adjustedDetections??b.detections));
    else if (sortMode === 'name_asc') results.sort((a,b) => a.player.name.localeCompare(b.player.name));
    return results;
  };

  const allSuspicionTypes = [...new Set(Object.values(findings).flat().flatMap(r => r.suspicions.map(s=>s.type)))];

  const suspicionTypeIcon = (type) => {
    const map = {
      money_laundering: <Star fill="#ef4444" size={13} className="text-red-500"/>,
      coordinated_donation: <Timer size={13} className="text-red-400"/>,
      transaction_abuse: <Star fill="#facc15" size={13} className="text-yellow-400"/>,
      market_automation: <Target size={13} className="text-red-500"/>,
      superhuman_apm: <Zap size={13} className="text-purple-500"/>,
      hermit_network: <Network size={13} className="text-orange-500"/>,
      mutual_hermit: <Network size={13} className="text-red-400"/>,
      script_pacing: <Clock size={13} className="text-pink-500"/>,
      newborn_wealthy: <Baby size={13} className="text-cyan-400"/>,
      temporal_clustering: <Moon size={13} className="text-indigo-400"/>,
      fidelity_ring: <Heart size={13} className="text-rose-400"/>,
      wage_uniformity: <CheckSquare size={13} className="text-amber-400"/>,
      low_wage: <AlertTriangle size={13} className="text-yellow-500"/>,
      naming_pattern: <AlertTriangle size={13} className="text-orange-400"/>,
      cloned_progression: <AlertTriangle size={13} className="text-yellow-400"/>,
      no_production_bonus: <AlertTriangle size={13} className="text-orange-500"/>,
      tip_farming: <Star size={13} className="text-amber-400"/>,
    };
    return map[type] || <AlertTriangle size={13} className="text-slate-400"/>;
  };

  const renderGroupedFindings = (countryFindings) => {
    const filtered = getFilteredFindings(countryFindings);
    const uf=new UnionFind();
    filtered.forEach(f=>{ uf.add(f.player.id); Object.keys(f.washPartners||{}).forEach(pid=>{ uf.add(pid); uf.union(f.player.id,pid); }); });

    const washGroups={}, hermitGroups={}, sniperGroup=[], apmGroup=[], pacingGroup=[], standalone=[];
    filtered.forEach(f=>{
      if (f.washPartners&&Object.keys(f.washPartners).length>0) { const root=uf.find(f.player.id); if(!washGroups[root])washGroups[root]=[]; washGroups[root].push(f); }
      else if ((f.player.isHermit||f.player.isMutualHermit)&&f.player.hermitBossId) { const bId=f.player.hermitBossId; if(!hermitGroups[bId])hermitGroups[bId]=[]; hermitGroups[bId].push(f); }
      else if (f.player.sniperHits>=5) sniperGroup.push(f);
      else if (f.player.maxConcurrentTxs>=5) apmGroup.push(f);
      else if (f.player.pacingHits>=settings.pacingMinHits) pacingGroup.push(f);
      else standalone.push(f);
    });

    const getGroupIcons=(membersList)=>{
      let hasSniper=false,hasApm=false,hasHermit=false,hasPacing=false,hasMutualHermit=false;
      membersList.forEach(m=>{ if(m.player.sniperHits>=5)hasSniper=true; if(m.player.maxConcurrentTxs>=5)hasApm=true; if(m.player.isHermit)hasHermit=true; if(m.player.pacingHits>=settings.pacingMinHits)hasPacing=true; if(m.player.isMutualHermit)hasMutualHermit=true; });
      if(!hasSniper&&!hasApm&&!hasHermit&&!hasPacing&&!hasMutualHermit) return null;
      return <span className="flex items-center font-bold drop-shadow-md mr-1 bg-slate-900/80 px-1.5 py-0.5 rounded border border-slate-700/50">
        {hasSniper&&<Target size={12} className="text-red-500 mx-0.5" title="Sniper Bot"/>}
        {hasApm&&<Zap size={12} className="text-purple-500 mx-0.5" title="Superhuman APM"/>}
        {(hasHermit||hasMutualHermit)&&<Network size={12} className={`mx-0.5 ${hasMutualHermit?'text-red-400':'text-orange-500'}`} title={hasMutualHermit?"Mutual Hermit":"Hermit Network"}/>}
        {hasPacing&&<Clock size={12} className="text-pink-500 mx-0.5" title="Script Pacing"/>}
      </span>;
    };

    const finalNodes=[];
    const groupStats=[];

    Object.entries(washGroups).forEach(([rootId, members])=>{
      const allMemberIds=new Set(), uniqueEdges=new Set();
      let totalVolume=0, totalDet=0;
      const ringLeader=members.reduce((p,c)=>p.detections>c.detections?p:c);
      const trueRootId=ringLeader.player.id;
      let ringNetProfit=0;
      const leaderPartners=globalWashPartners.current[trueRootId]||{};
      Object.values(leaderPartners).forEach(p=>ringNetProfit+=(p.netProfit||0));
      const isNetZero=Math.abs(ringNetProfit)<0.01;
      let ringLaunderCount=0, ringLaunderedCoins=0;
      const uniqueLaunderers=new Set();

      members.forEach(m=>{
        allMemberIds.add(m.player.id);
        let mDet=m.detections||0;
        if (isNetZero) { const ws=m.suspicions.find(s=>s.type==='transaction_abuse'); if(ws) mDet-=(ws.detectionWeight!==undefined?ws.detectionWeight:ws.partners.length); }
        m.adjustedDetections=mDet; totalDet+=mDet;
        Object.entries(m.washPartners||{}).forEach(([pid,pData])=>{ allMemberIds.add(pid); const eid=[m.player.id,pid].sort().join('_'); if(!uniqueEdges.has(eid)){uniqueEdges.add(eid);totalVolume+=Math.abs(pData.netProfit!==0?pData.netProfit:pData.volume);} });
        if (m.hasLaundering) { const ls=m.suspicions.find(s=>s.type==='money_laundering'); if(ls) ls.workers.forEach(w=>{ if(!uniqueLaunderers.has(w.uid)){uniqueLaunderers.add(w.uid);ringLaunderCount++;ringLaunderedCoins+=(w.largeDonations30Days||w.totalDonatedAllTime||0);} }); }
      });
      groupStats.push({ rootId, trueRootId, ringLeader, members, allMemberIds, totalVolume, totalDet, ringLaunderCount, ringLaunderedCoins, ringNetProfit });
    });

    groupStats.sort((a,b)=>b.totalVolume-a.totalVolume).forEach(stats=>{
      if (stats.allMemberIds.size<=1) { finalNodes.push(...stats.members.map((r,i)=>renderResultNode(r,i))); return; }
      let ringBannedCount=0; stats.allMemberIds.forEach(id=>{ if(globalBans.current[id])ringBannedCount++; });
      const rootName=stats.ringLeader.player.name;
      const profitDisplay=Math.abs(stats.ringNetProfit)<0.01?"0.0 NET":stats.ringNetProfit>0?`+${stats.ringNetProfit.toFixed(1)} NET`:`-${Math.abs(stats.ringNetProfit).toFixed(1)} NET`;
      finalNodes.push(
        <TreeNode key={`group_${stats.rootId}`}
          label={<span className="flex items-center gap-1">Trading Ring ({stats.allMemberIds.size} <Users size={12}/>{ringBannedCount>0?`, ${ringBannedCount} BANNED`:''}) — <span className="font-bold text-yellow-500 ml-1">{rootName}</span></span>}
          icon={Activity} defaultOpen={false}
          badge={<span className="flex items-center gap-1">{getGroupIcons(stats.members)}<span>Score: {stats.totalDet}</span></span>}
          badgeClass={getBadgeClass(stats.totalDet)}
          extraData={<span className="flex items-center gap-2 font-bold ml-2"><span className="text-yellow-400 flex items-center gap-1">| {profitDisplay} <Coins size={12}/></span>{stats.ringLaunderCount>0&&<span className="text-red-500 flex items-center gap-1">| {stats.ringLaunderCount}x <Star fill="#ef4444" size={12}/> {stats.ringLaunderedCoins.toFixed(1)} <Coins size={12}/></span>}</span>}
        >
          <div className="ml-6 my-2 space-y-2 border-l border-slate-800 pl-4 py-2">
            <div className="bg-slate-900 border border-slate-700/50 rounded p-3 text-sm mb-4">
              <div className="text-xs font-bold text-slate-400 mb-2 uppercase tracking-wider">WASH TRADING NETWORK MAP</div>
              <WashNetworkTree rootId={stats.trueRootId} washPartners={globalWashPartners.current} processedNodes={new Set()} globalBans={globalBans.current} globalNames={globalCacheRef.current.names}/>
            </div>
            {stats.members.sort((a,b)=>(b.adjustedDetections??b.detections)-(a.adjustedDetections??a.detections)).map((r,i)=>renderResultNode(r,i,true))}
          </div>
        </TreeNode>
      );
    });

    Object.entries(hermitGroups).sort((a,b)=>b[1].length-a[1].length).forEach(([bossId,members])=>{
      const bossName=globalCacheRef.current.names[bossId]||members[0].player.hermitBossName||bossId;
      const totalDet=members.reduce((s,m)=>s+(m.adjustedDetections??m.detections),0);
      const hasMutualInGroup=members.some(m=>m.player.isMutualHermit);
      finalNodes.push(
        <TreeNode key={`hermit_${bossId}`}
          label={<span className="flex items-center gap-1">{hasMutualInGroup?'Mutual ':''}Hermit Network ({members.length} <Network size={12}/>) — Boss: <span className={`font-bold ml-1 ${hasMutualInGroup?'text-red-400':'text-orange-400'}`}>{String(bossName)}</span></span>}
          icon={Network} defaultOpen={false}
          badge={<span className="flex items-center gap-1">{getGroupIcons(members)}<span>Score: {totalDet}</span></span>}
          badgeClass={getBadgeClass(totalDet)}
          extraData={<a href={`https://app.warera.io/user/${bossId}`} target="_blank" rel="noopener noreferrer" className="hover:text-blue-400 hover:underline flex items-center gap-1" onClick={e=>e.stopPropagation()}><ExternalLink size={10}/></a>}
        >
          <div className="ml-6 my-2 space-y-2 border-l border-slate-800 pl-4 py-2">
            {members.sort((a,b)=>b.detections-a.detections).map((r,i)=>renderResultNode(r,i,true))}
          </div>
        </TreeNode>
      );
    });

    if (sniperGroup.length>0) {
      const totalDet=sniperGroup.reduce((s,m)=>s+m.detections,0);
      finalNodes.push(<TreeNode key="sniperGroup" label={`Market Automation: Snipers (${sniperGroup.length})`} icon={Target} defaultOpen={false} badge={<span className="flex items-center gap-1">{getGroupIcons(sniperGroup)}<span>Score: {totalDet}</span></span>} badgeClass={getBadgeClass(totalDet)}><div className="ml-6 my-2 space-y-2 border-l border-slate-800 pl-4 py-2">{sniperGroup.sort((a,b)=>b.detections-a.detections).map((r,i)=>renderResultNode(r,i,true))}</div></TreeNode>);
    }
    if (apmGroup.length>0) {
      const totalDet=apmGroup.reduce((s,m)=>s+m.detections,0);
      finalNodes.push(<TreeNode key="apmGroup" label={`API Automation: Superhuman APM (${apmGroup.length})`} icon={Zap} defaultOpen={false} badge={<span className="flex items-center gap-1">{getGroupIcons(apmGroup)}<span>Score: {totalDet}</span></span>} badgeClass={getBadgeClass(totalDet)}><div className="ml-6 my-2 space-y-2 border-l border-slate-800 pl-4 py-2">{apmGroup.sort((a,b)=>b.detections-a.detections).map((r,i)=>renderResultNode(r,i,true))}</div></TreeNode>);
    }
    if (pacingGroup.length>0) {
      const totalDet=pacingGroup.reduce((s,m)=>s+m.detections,0);
      finalNodes.push(<TreeNode key="pacingGroup" label={`Action Automation: Script Pacing (${pacingGroup.length})`} icon={Clock} defaultOpen={false} badge={<span className="flex items-center gap-1">{getGroupIcons(pacingGroup)}<span>Score: {totalDet}</span></span>} badgeClass={getBadgeClass(totalDet)}><div className="ml-6 my-2 space-y-2 border-l border-slate-800 pl-4 py-2">{pacingGroup.sort((a,b)=>b.detections-a.detections).map((r,i)=>renderResultNode(r,i,true))}</div></TreeNode>);
    }
    standalone.sort((a,b)=>(b.adjustedDetections??b.detections)-(a.adjustedDetections??a.detections)).forEach((r,i)=>finalNodes.push(renderResultNode(r,i)));
    return finalNodes;
  };

  const renderResultNode = (result, idx, forceOpen=false) => {
    let redStars=0, yellowStars=0;
    if (result.hasLaundering) redStars=result.launderingWorkerCount;
    if (result.washPartners&&Object.keys(result.washPartners).length>0) yellowStars=Object.keys(result.washPartners).length;
    const activeDetections=result.adjustedDetections??result.detections;
    const hasSniper=result.player.sniperHits>=5, hasApm=result.player.maxConcurrentTxs>=5;
    const hasHermit=result.player.isHermit, hasMutualHermit=result.player.isMutualHermit;
    const hasPacing=result.player.pacingHits>=settings.pacingMinHits;
    const country=result.player.country;

    return (
      <TreeNode key={result.player.id}
        label={<><span className="truncate">{String(result.player.name)}</span>{result.player.isBanned&&<span className="ml-2 bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded text-[9px] border border-red-700/50 font-bold tracking-wider align-middle shrink-0">BANNED</span>}</>}
        icon={UserX} defaultOpen={forceOpen&&idx===0}
        badge={
          <span className="flex items-center gap-1">
            {(redStars>0||yellowStars>0)&&<span className="flex items-center font-bold drop-shadow-md mr-1 bg-purple-900/40 px-1.5 py-0.5 rounded border border-purple-800/50">{redStars>0&&<span className="flex items-center text-red-500 mr-2">{redStars>1?`${redStars}x`:''}<Star fill="#ef4444" size={12} className="mx-1"/>{result.totalLaunderedCoins?.toFixed(1)||'0'}<Coins size={10} className="ml-0.5"/></span>}{yellowStars>0&&<span className="flex items-center text-yellow-400">{yellowStars>1?`${yellowStars}x`:''}<Star fill="#facc15" size={12} className="ml-0.5"/></span>}</span>}
            {(hasSniper||hasApm||hasHermit||hasMutualHermit||hasPacing)&&<span className="flex items-center font-bold drop-shadow-md mr-1 bg-slate-900/80 px-1.5 py-0.5 rounded border border-slate-700/50">{hasSniper&&<Target size={12} className="text-red-500 mx-0.5"/>}{hasApm&&<Zap size={12} className="text-purple-500 mx-0.5"/>}{(hasHermit||hasMutualHermit)&&<Network size={12} className={`mx-0.5 ${hasMutualHermit?'text-red-400':'text-orange-500'}`}/>}{hasPacing&&<Clock size={12} className="text-pink-500 mx-0.5"/>}</span>}
            <span>{result.zeroBonusCompanyCount>0?`(${result.zeroBonusCompanyCount} No-Prod, ${result.bossNoBonusPercentage}%) `:''}Score: {activeDetections}</span>
            <ScoreTooltip breakdown={result.scoreBreakdown}/>
          </span>
        }
        badgeClass={getBadgeClass(activeDetections)}
        extraData={<span className="flex items-center gap-1 ml-2">
          {result.phase2Status === 'pending' && (
            <button onClick={e=>{e.stopPropagation();runPhase2(result.player.id,country);}} className="flex items-center gap-1 px-2 py-1 bg-indigo-900/60 hover:bg-indigo-700/80 text-indigo-300 hover:text-indigo-100 rounded border border-indigo-700/60 text-[10px] font-semibold transition-colors shrink-0" title="Fetch companies & workers and run full detection">
              <Users size={9}/><span>Load Worker Analysis</span>
            </button>
          )}
          {result.phase2Status === 'running' && (
            <span className="flex items-center gap-1 px-2 py-1 bg-slate-800 text-slate-400 rounded border border-slate-700 text-[10px] font-semibold animate-pulse shrink-0">
              <Activity size={9}/><span>Analyzing…</span>
            </span>
          )}
          <span className="inline-flex items-center rounded-md border border-slate-700 overflow-hidden text-[10px] font-semibold shrink-0">
            <button onClick={e=>{e.stopPropagation();rescanPlayer(result.player.id,country);}} className="flex items-center gap-1 px-2 py-1 bg-slate-900 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors border-r border-slate-700" title="Re-scan"><RefreshCw size={9}/><span className="hidden sm:inline">Rescan</span></button>
            <button onClick={e=>{e.stopPropagation();exportSinglePlayer(result);}} className="flex items-center gap-1 px-2 py-1 bg-slate-900 hover:bg-blue-900/50 text-slate-400 hover:text-blue-300 transition-colors border-r border-slate-700" title="Export JSON"><Download size={9}/><span className="hidden sm:inline">Export</span></button>
            <button onClick={e=>{e.stopPropagation();copySummaryToClipboard(result);setCopiedId(result.player.id);setTimeout(()=>setCopiedId(null),2500);}} className={`flex items-center gap-1 px-2 py-1 transition-colors ${copiedId===result.player.id?'bg-emerald-900/50 text-emerald-400':'bg-slate-900 hover:bg-emerald-900/30 text-slate-400 hover:text-emerald-400'}`} title="Copy 500-char summary">{copiedId===result.player.id?<CheckSquare size={9}/>:<CheckSquare size={9}/>}<span className="hidden sm:inline">{copiedId===result.player.id?'Copied!':'Summary'}</span></button>
          </span>
        </span>}
        linkId={result.player.id}
      >
        <div className="ml-2 md:ml-6 my-2 space-y-2 border-l border-slate-800 pl-2 md:pl-4 py-2">
          <div className="bg-slate-900 border border-slate-700/50 rounded p-3 text-sm mb-4">
            <div className="text-xs font-bold text-slate-400 mb-1 flex items-center gap-1"><Activity size={12}/> Analysis Summary</div>
            <p className="text-slate-300 leading-relaxed">{String(result.summary)}</p>
            {result.phase2Status === 'pending' && (
              <p className="text-indigo-400 text-xs mt-2 flex items-center gap-1"><Users size={11}/> Worker analysis pending — click <strong>Load Worker Analysis</strong> or wait for auto-trigger (threshold: {settings.phase2AutoThreshold}).</p>
            )}
            {result.phase2Status === 'running' && (
              <p className="text-slate-400 text-xs mt-2 animate-pulse flex items-center gap-1"><Activity size={11}/> Fetching companies, workers, and profiles…</p>
            )}
          </div>
          <div className="text-xs uppercase font-bold text-slate-500 mb-2">Detected Anomalies</div>
          {result.suspicions.map((suspicion, sIdx) => (
            <div key={sIdx} className="bg-slate-900 border border-slate-800 rounded p-2 text-sm">
              <div className="flex items-center gap-2 font-semibold text-slate-200 mb-1">
                {suspicionTypeIcon(suspicion.type)}
                {String(suspicion.type).replace(/_/g,' ').toUpperCase()}
                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-bold ml-auto ${suspicion.severity==='critical'?'bg-red-900/50 text-red-400 border-red-800':suspicion.severity==='high'?'bg-orange-900/50 text-orange-400 border-orange-800':'bg-yellow-900/50 text-yellow-500 border-yellow-800'}`}>{suspicion.severity.toUpperCase()}</span>
              </div>
              <p className="text-slate-400 text-xs mb-2 flex items-center gap-1 flex-wrap">
                {String(suspicion.desc).split('Coins').map((part,i,arr)=>(
                  <React.Fragment key={i}>{part}{i!==arr.length-1&&<Coins size={10} className="text-yellow-400 inline -mt-0.5"/>}</React.Fragment>
                ))}
              </p>

              {/* Temporal clustering heatmap */}
              {suspicion.type==='temporal_clustering'&&suspicion.hourBuckets&&<ActivityHeatmap hourBuckets={suspicion.hourBuckets}/>}

              {suspicion.type==='transaction_abuse'?(
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-2 mt-2">
                  {suspicion.partners.map((p,pIdx)=>{
                    const partnerProfit=-(p.netProfit||0);
                    let badgeColors="bg-slate-800 text-slate-300 border-slate-700", profitText="";
                    if (Math.abs(partnerProfit)<0.01){badgeColors="bg-slate-800 text-slate-300 border-slate-700";profitText=`0.0 NET (${(p.volume||0).toFixed(1)} VOL)`;}
                    else if (partnerProfit>0){badgeColors="bg-green-900/40 text-green-400 border-green-700/50";profitText=`+${partnerProfit.toFixed(1)} GAINED`;}
                    else{badgeColors="bg-red-900/40 text-red-400 border-red-700/50";profitText=`-${Math.abs(partnerProfit).toFixed(1)} LOST`;}
                    return (
                      <a key={pIdx} href={`https://app.warera.io/user/${p.id}`} target="_blank" rel="noopener noreferrer" className="bg-slate-950 p-2 rounded border border-slate-800 flex flex-col gap-1 hover:border-blue-500 transition-colors group block">
                        <div className="flex justify-between items-center">
                          <span className="font-mono text-xs text-blue-300 flex items-center flex-wrap gap-0">
                            {String(p.name)}{p.isBanned&&<span className="bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded text-[9px] ml-1 border border-red-700/50 font-bold tracking-wider">[BANNED]</span>}
                            <span className={`${badgeColors} px-1.5 py-0.5 rounded text-[9px] ml-1 border font-bold tracking-wider flex items-center gap-1`}>[WASH: {p.txCount} | {profitText} <Coins size={8} className="inline -mt-0.5"/>]</span>
                            {p.isWorker&&<span className="bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded text-[9px] ml-1 border border-red-700/50 font-bold tracking-wider">WORKER (2x)</span>}
                          </span>
                          <span className="text-[10px] bg-slate-800 px-1 rounded text-slate-400 group-hover:bg-blue-900 group-hover:text-blue-200 transition-colors whitespace-nowrap">Lvl {p.level} <ExternalLink size={8} className="inline ml-0.5 opacity-50"/></span>
                        </div>
                        <div className="text-[10px] font-mono mt-1 text-slate-500">Latest: {p.latestTrade?new Date(p.latestTrade).toLocaleDateString():'Unknown'}</div>
                      </a>
                    );
                  })}
                </div>
              ):(
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-2 mt-2">
                  {(suspicion.workers||[]).map((w,wIdx)=>{
                    let dispName=String(w.normalizedName), isSelf=false, isHermitNode=false;
                    if (dispName.includes('(SELF)')){isSelf=true;dispName=dispName.replace(' (SELF)','');}
                    if (dispName.includes('(HERMIT NODE)')){isHermitNode=true;dispName=dispName.replace(' (HERMIT NODE)','');}
                    return (
                      <a key={wIdx} href={`https://app.warera.io/user/${w.resolvedUser?._id||w.uid}`} target="_blank" rel="noopener noreferrer" className="bg-slate-950 p-2 rounded border border-slate-800 flex flex-col gap-1 hover:border-blue-500 transition-colors group block">
                        <div className="flex justify-between items-start">
                          <span className="font-mono text-xs text-blue-300 flex flex-col gap-1 w-full">
                            <div className="flex flex-wrap items-center gap-1">
                              <span>
                                {suspicion.type==='naming_pattern'?(
                                  dispName.split(new RegExp(`(${suspicion.overlapString})`, 'gi')).map((part,i)=>part.toLowerCase()===suspicion.overlapString.toLowerCase()?<span key={i} className="text-yellow-400 font-bold">{part}</span>:<span key={i}>{part}</span>)
                                ):dispName}
                              </span>
                              {/* APM tooltip */}
                              {suspicion.type==='superhuman_apm'&&suspicion.apmDetails&&isSelf&&(
                                <span className="relative group/tooltip inline-block text-purple-400 cursor-help font-bold text-[10px] bg-purple-900/30 px-1.5 py-0.5 rounded border border-purple-800/50 ml-1">
                                  [AVG GAP: {suspicion.apmDetails.avgGapMs}ms]
                                  <div className="absolute left-0 top-full mt-2 hidden group-hover/tooltip:block bg-slate-800 text-slate-300 text-[10px] p-2 rounded shadow-xl border border-slate-600 z-[60] whitespace-nowrap min-w-[150px]">
                                    <div className="font-bold text-slate-400 mb-1 border-b border-slate-700 pb-1">Listed Items (Window: {settings.apmWindowMs}ms)</div>
                                    {(suspicion.apmDetails.txs||[]).slice(0,15).map((t,i)=><div key={i} className="flex justify-between gap-4 py-0.5 border-b border-slate-700/50 last:border-0"><span className="text-slate-400 font-mono">{new Date(t.offerTimeMs).toISOString().replace('T',' ').substring(0,23)}</span><span className="text-purple-300 font-mono text-right">{t.itemCode}</span></div>)}
                                    {(suspicion.apmDetails.txs||[]).length>15&&<div className="text-slate-500 mt-1 italic">...and {(suspicion.apmDetails.txs||[]).length-15} more</div>}
                                  </div>
                                </span>
                              )}
                              {/* Pacing tooltip */}
                              {suspicion.type==='script_pacing'&&suspicion.pacingDetails&&isSelf&&(
                                <span className="relative group/tooltip inline-block text-pink-400 cursor-help font-bold text-[10px] bg-pink-900/30 px-1.5 py-0.5 rounded border border-pink-800/50 ml-1">
                                  [PACING: {suspicion.pacingDetails.avgGapMs}ms{suspicion.pacingDetails.singleType?` / ${suspicion.pacingDetails.singleType}`:''}]
                                  <div className="absolute left-0 top-full mt-2 hidden group-hover/tooltip:block bg-slate-800 text-slate-300 text-[10px] p-2 rounded shadow-xl border border-slate-600 z-[60] whitespace-nowrap min-w-[250px]">
                                    <div className="font-bold text-slate-400 mb-1 border-b border-slate-700 pb-1">Identical Gaps (±{settings.pacingToleranceMs}ms)</div>
                                    {(suspicion.pacingDetails.edges||[]).slice(0,15).map((edge,i)=><div key={i} className="flex justify-between items-center gap-4 py-0.5 border-b border-slate-700/50 last:border-0"><span className="text-pink-300 font-mono font-bold w-12">{edge.delta}ms</span><span className="text-slate-500 font-mono text-[9px]">{new Date(edge.end).toISOString().replace('T',' ').substring(0,23)}</span><span className="text-slate-400 font-mono text-right truncate max-w-[80px] capitalize">{edge.type}</span></div>)}
                                    {(suspicion.pacingDetails.edges||[]).length>15&&<div className="text-slate-500 mt-1 italic">...and {(suspicion.pacingDetails.edges||[]).length-15} more</div>}
                                  </div>
                                </span>
                              )}
                              {/* Sniper tooltip */}
                              {suspicion.type==='market_automation'&&suspicion.sniperDetails&&isSelf&&(
                                <span className="relative group/tooltip inline-block text-red-400 cursor-help font-bold text-[10px] bg-red-900/30 px-1.5 py-0.5 rounded border border-red-800/50 ml-1">
                                  [AVG: {Math.round((suspicion.sniperDetails||[]).reduce((a,b)=>a+b.timeMs,0)/Math.max(1,(suspicion.sniperDetails||[]).length))}ms]
                                  <div className="absolute left-0 top-full mt-2 hidden group-hover/tooltip:block bg-slate-800 text-slate-300 text-[10px] p-2 rounded shadow-xl border border-slate-600 z-[60] whitespace-nowrap min-w-[250px]">
                                    <div className="font-bold text-slate-400 mb-1 border-b border-slate-700 pb-1">Sniped Items (Fastest First)</div>
                                    {[...(suspicion.sniperDetails||[])].sort((a,b)=>a.timeMs-b.timeMs).slice(0,15).map((t,i)=><div key={i} className="flex justify-between items-center gap-4 py-0.5 border-b border-slate-700/50 last:border-0"><span className="text-red-300 font-mono font-bold w-12">{t.timeMs}ms</span><span className="text-slate-500 font-mono text-[9px]">{new Date(t.offerTimeMs+t.timeMs).toISOString().replace('T',' ').substring(0,23)}</span><span className="text-slate-400 font-mono text-right truncate max-w-[80px]">{t.itemCode}</span></div>)}
                                    {(suspicion.sniperDetails||[]).length>15&&<div className="text-slate-500 mt-1 italic">...and {(suspicion.sniperDetails||[]).length-15} more</div>}
                                  </div>
                                </span>
                              )}
                              {/* Hermit badge */}
                              {suspicion.type==='hermit_network'&&isHermitNode&&<span className="text-orange-500 font-bold text-[10px] bg-orange-900/30 px-1.5 py-0.5 rounded border border-orange-800/50 ml-1">[HERMIT NODE]</span>}
                              {/* Account age badge */}
                              {suspicion.type==='newborn_wealthy'&&w.accountAgeDays!==undefined&&(
                                <span className="text-cyan-400 font-bold text-[10px] bg-cyan-900/30 px-1.5 py-0.5 rounded border border-cyan-800/50 ml-1">
                                  [{w.accountAgeDays}d OLD{w.wealthMaxAELevel>0?` | AE Lvl ${w.wealthMaxAELevel}`:''}]
                                </span>
                              )}
                              {suspicion.type==='newborn_wealthy'&&w.wealthReason&&(
                                <span className="text-slate-500 text-[9px] block mt-0.5 normal-case font-normal">{w.wealthReason}</span>
                              )}
                              {/* Status badges */}
                              {w.isBanned&&<span className="bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded text-[9px] border border-red-700/50 font-bold tracking-wider">[BANNED]</span>}
                              {w.isActive===false&&!w.isBanned&&<span className="bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded text-[9px] border border-red-700/50 font-bold tracking-wider">[INACTIVE]</span>}
                              {w.noBonusPercentage>0&&suspicion.type==='no_production_bonus'&&<span className="bg-orange-900/80 text-orange-300 px-1.5 py-0.5 rounded text-[9px] border border-orange-700/50 font-bold tracking-wider">[{w.noBonusPercentage}% NO-PROD, {w.noBonusCount}/{w.totalOwnedCount}]</span>}
                              {w.isLaundering&&suspicion.type==='money_laundering'&&<span className="bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded text-[9px] border border-red-700/50 font-bold tracking-wider flex items-center gap-1">[{w.largeDonations30Days.toFixed(1)} <Coins size={8} className="inline -mt-0.5"/> IN LARGE DONATIONS]</span>}
                              {suspicion.type==='fidelity_ring'&&<span className="text-rose-400 font-bold text-[10px] bg-rose-900/30 px-1.5 py-0.5 rounded border border-rose-800/50 ml-1">[FIDELITY 10/10]</span>}
                            </div>
                          </span>
                          <span className="text-[10px] bg-slate-800 px-1 rounded text-slate-400 group-hover:bg-blue-900 group-hover:text-blue-200 transition-colors whitespace-nowrap shrink-0 ml-2 mt-0.5">Lvl {w.normalizedLevel} <ExternalLink size={8} className="inline ml-0.5 opacity-50"/></span>
                        </div>
                        {(w.normalizedWage!==undefined||w.normalizedFidelity!==undefined)&&(
                          <div className="flex justify-between items-center text-[10px] font-mono mt-1">
                            {w.normalizedWage!==undefined?<span className={w.normalizedWage<=settings.suspiciousWageThreshold?'text-red-400':'text-green-400'}>Wage: {Number(w.normalizedWage).toFixed(3)}</span>:<span/>}
                            {w.normalizedFidelity!==undefined&&<span className="text-slate-500">Fid: <span className={w.normalizedFidelity===10?'text-blue-400 font-bold':'text-slate-300'}>{w.normalizedFidelity}</span>/10</span>}
                          </div>
                        )}
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </TreeNode>
    );
  };

  const totalFlags = Object.values(findings).flat().length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-300 font-sans flex flex-col">

      {/* Progress bar */}
      <div className="w-full bg-slate-900 h-5 overflow-hidden relative border-b border-slate-800">
        <div className={`h-5 transition-all duration-300 ${isRateLimited?'bg-yellow-500/80':'bg-blue-600'}`} style={{width:`${progress}%`}}></div>
        {isRateLimited&&(
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[12px] font-bold text-white tracking-widest drop-shadow-md">PAUSED: API COOLDOWN ({limitTimer}s REMAINING)</span>
          </div>
        )}
      </div>

      {/* Session restore prompt */}
      {showRestorePrompt&&savedSession&&(
        <div className="bg-amber-900/30 border-b border-amber-700/50 px-4 py-2 flex items-center justify-between text-sm">
          <span className="text-amber-300 font-medium">Previous scan found ({Object.values(savedSession.findings).flat().length} flags, saved {new Date(savedSession.savedAt).toLocaleTimeString()})</span>
          <div className="flex gap-2">
            <button onClick={()=>{setFindings(savedSession.findings);setShowRestorePrompt(false);}} className="px-3 py-1 bg-amber-700 hover:bg-amber-600 text-white rounded text-xs font-medium">Restore</button>
            <button onClick={()=>{setShowRestorePrompt(false);sessionStorage.removeItem('warera_oracle_session');}} className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-xs font-medium">Dismiss</button>
          </div>
        </div>
      )}

      <header className="bg-slate-900 border-b border-slate-800 p-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <ShieldAlert className="text-red-500" size={28}/>
          <div>
            <h1 className="text-xl font-bold text-slate-100 leading-tight tracking-widest uppercase">Palantirish</h1>
            <p className="text-xs text-slate-500 font-mono">Multi-Account & Bot Net Detection — WarEra</p>
          </div>
        </div>
        <a href="https://warerastats.io/" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300 hover:underline font-mono px-3 py-1 bg-blue-900/20 border border-blue-900/50 rounded-full transition-colors hidden sm:block">Powered by warerastats.io</a>
      </header>

      <main className="flex-1 flex flex-col md:flex-row overflow-hidden overflow-y-auto md:overflow-hidden">

        {/* ── LEFT PANEL ── */}
        <div className="w-full md:w-1/3 bg-slate-900/50 border-b md:border-b-0 md:border-r border-slate-800 flex flex-col p-4 gap-4 overflow-y-visible md:overflow-y-auto shrink-0">

          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 shrink-0">
            <h2 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2"><Settings size={16}/> Target & Parameters</h2>
            <div className="space-y-4">

              <div>
                <label className="text-xs text-slate-400 block mb-1">Your WarEra API Key</label>
                <input type="text" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="Optional API Key"
                  className={`w-full bg-slate-950 border rounded p-2 text-sm outline-none font-mono transition-colors ${apiKey&&!apiKey.startsWith('wae_')?'border-red-500 text-red-400 focus:border-red-400':'border-slate-800 text-slate-200 focus:border-blue-500'}`} disabled={isScanning}/>
                {apiKey&&!apiKey.startsWith('wae_')&&<span className="text-[10px] text-red-500 font-bold mt-1 block">Must start with "wae_"</span>}
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Specific User</label>
                <input type="text" value={targetUserId} onChange={e=>setTargetUserId(e.target.value)} placeholder="(Optional)"
                  className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-sm text-slate-200 outline-none focus:border-blue-500 font-mono disabled:opacity-50" disabled={isScanning||(!apiKey||!apiKey.startsWith('wae_'))}/>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Target Region</label>
                <select value={targetRegionId} onChange={e=>setTargetRegionId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-sm text-slate-200 outline-none focus:border-blue-500 disabled:opacity-50"
                  disabled={isScanning||!!targetUserId||availableRegions.length===0||(!apiKey||!apiKey.startsWith('wae_'))}>
                  {availableRegions.length===0&&<option value="">{(!apiKey||!apiKey.startsWith('wae_'))?'Awaiting Valid API Key...':'Pending Network Ping...'}</option>}
                  {availableRegions.length>0&&<option value="ALL">🌍 Global Scan (All Regions)</option>}
                  {availableRegions.map(r=><option key={r._id||r.id} value={r._id||r.id}>{r.name}</option>)}
                </select>
              </div>

              <div className="border-t border-slate-800 pt-4 mt-2 space-y-4">
                <label className="flex items-center gap-2 cursor-pointer text-sm font-semibold text-orange-500 hover:text-orange-400 transition-colors">
                  <input type="checkbox" checked={settings.ringOfFireMode} onChange={e=>setSettings({...settings,ringOfFireMode:e.target.checked})} className="accent-orange-500 w-4 h-4" disabled={isScanning}/>
                  🔥 Ring of Fire Mode (Wash Trading Only)
                </label>

                {settings.ringOfFireMode?(
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">History Lookback (Days)</label>
                    <div className="flex items-center gap-2">
                      <input type="range" min="1" max="60" step="1" value={settings.rofDays} onChange={e=>setSettings({...settings,rofDays:parseInt(e.target.value)})} className="flex-1 accent-orange-500" disabled={isScanning}/>
                      <span className="text-sm font-mono bg-slate-950 px-2 py-1 rounded w-16 text-center border border-orange-900/50 text-orange-400">{settings.rofDays}d</span>
                    </div>
                  </div>
                ):(
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Suspicious Wage Threshold</label>
                    <div className="flex items-center gap-2">
                      <input type="range" min="0.01" max="0.15" step="0.001" value={settings.suspiciousWageThreshold} onChange={e=>setSettings({...settings,suspiciousWageThreshold:parseFloat(e.target.value)})} className="flex-1 accent-red-500" disabled={isScanning}/>
                      <span className="text-sm font-mono bg-slate-950 px-2 py-1 rounded w-16 text-center border border-slate-800">{settings.suspiciousWageThreshold.toFixed(3)}</span>
                    </div>
                  </div>
                )}

                {[
                  {label:'Sniper Threshold (ms)',key:'sniperThresholdMs',min:100,max:5000,step:100,accent:'accent-red-500',fmt:v=>v},
                  {label:'Superhuman APM Window (ms)',key:'apmWindowMs',min:100,max:20000,step:100,accent:'accent-purple-500',fmt:v=>v},
                  {label:'Pacing Tolerance (ms)',key:'pacingToleranceMs',min:1,max:100,step:1,accent:'accent-pink-500',fmt:v=>`±${v}`},
                  {label:'Pacing Min Hits',key:'pacingMinHits',min:4,max:20,step:1,accent:'accent-pink-500',fmt:v=>v},
                  {label:'Phase 2 Auto-Trigger Score',key:'phase2AutoThreshold',min:1,max:20,step:1,accent:'accent-indigo-500',fmt:v=>v},
                ].map(({label,key,min,max,step,accent,fmt})=>(
                  <div key={key}>
                    <label className="text-xs text-slate-400 block mb-1">{label}</label>
                    <div className="flex items-center gap-2">
                      <input type="range" min={min} max={max} step={step} value={settings[key]} onChange={e=>setSettings({...settings,[key]:key==='pacingToleranceMs'||key==='pacingMinHits'?parseInt(e.target.value):parseInt(e.target.value)})} className={`flex-1 ${accent}`} disabled={isScanning}/>
                      <span className="text-sm font-mono bg-slate-950 px-2 py-1 rounded w-16 text-center border border-slate-800">{fmt(settings[key])}</span>
                    </div>
                  </div>
                ))}

                <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-400 hover:text-slate-300 transition-colors">
                  <input type="checkbox" checked={settings.verboseDebug} onChange={e=>setSettings({...settings,verboseDebug:e.target.checked})} className="accent-slate-400 w-4 h-4" disabled={isScanning}/>
                  Verbose Debug Logging
                </label>
              </div>
            </div>

            <div className="mt-6 flex gap-2">
              {!isScanning?(
                <button onClick={startScan} className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2 px-4 rounded flex items-center justify-center gap-2 font-medium transition-colors">
                  <Play size={16} fill="currentColor"/> Initialize Scan
                </button>
              ):(
                <button onClick={abortScan} className="flex-1 bg-slate-700 hover:bg-slate-600 text-white py-2 px-4 rounded flex items-center justify-center gap-2 font-medium transition-colors">
                  <Square size={16} fill="currentColor"/> Abort Scan
                </button>
              )}
            </div>
          </div>

          {/* Telemetry */}
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col shrink-0">
            <div className="flex justify-between items-center cursor-pointer hover:bg-slate-800 p-1 -m-1 rounded transition-colors" onClick={()=>setShowLogs(!showLogs)}>
              <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2"><Activity size={16}/> Scanner Telemetry</h2>
              <div className="flex items-center gap-2 text-xs font-mono">
                <span className={isRateLimited?"text-yellow-400 font-bold animate-pulse":"text-blue-400 truncate max-w-[150px]"}>{currentTask}</span>
                <span className="text-slate-500">[{progress}%]</span>
                {showLogs?<ChevronDown size={14} className="text-slate-500"/>:<ChevronRight size={14} className="text-slate-500"/>}
              </div>
            </div>
            {showLogs&&(
              <div className="mt-3 h-64 bg-slate-950 border border-slate-800 rounded p-3 overflow-y-auto font-mono text-xs flex flex-col gap-1">
                {logs.map((log,i)=>(
                  <div key={i} className={`${log.type==='warning'?'text-red-400':log.type==='debug'?'text-slate-600':'text-slate-400'} flex gap-2`}>
                    <span className="text-slate-600 opacity-50 shrink-0">[{log.time}]</span>
                    <span className="break-all">{log.msg}</span>
                  </div>
                ))}
                <div ref={logsContainerRef}/>
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT PANEL ── */}
        <div className="w-full md:w-2/3 p-4 md:p-6 bg-slate-950 overflow-y-visible md:overflow-y-auto flex-1">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4 border-b border-slate-800 pb-4">
            <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2"><Database size={20} className="text-slate-400"/> Analysis Results</h2>

            <div className="flex flex-wrap items-center gap-3 font-mono text-sm">
              {/* API rate bars */}
              <div className="bg-slate-900 border border-slate-800 px-3 py-2 rounded flex items-center w-full sm:w-56 text-xs">
                <div className="flex flex-col gap-1.5 w-full">
                  <div className="flex justify-between text-[10px] text-slate-300 font-semibold leading-none items-center">
                    <span>WarEraStats.io Cache</span>
                    <span className="text-slate-500 font-mono text-[9px]">{gatewayNext>0?`Next: ${gatewayNext}s`:'Max'}</span>
                  </div>
                  <div className="w-full bg-slate-950 rounded-full h-1.5 border border-slate-800 overflow-hidden">
                    <div className={`h-full transition-all duration-300 ${gatewayPercent<20?'bg-red-500':gatewayPercent<50?'bg-yellow-500':'bg-blue-500'}`} style={{width:`${gatewayPercent}%`}}></div>
                  </div>
                  <div className={`flex justify-between text-[10px] font-semibold leading-none mt-1 items-center ${isOfficialEnabled?'text-slate-300':'text-slate-600'}`}>
                    <span>WarEra Live API</span>
                    {isOfficialEnabled&&<span className="text-slate-500 font-mono text-[9px]">{officialNext>0?`Next: ${officialNext}s`:'Max'}</span>}
                  </div>
                  <div className="w-full bg-slate-950 rounded-full h-1.5 border border-slate-800 overflow-hidden">
                    <div className={`h-full transition-all duration-300 ${!isOfficialEnabled?'bg-transparent':officialPercent<20?'bg-red-500':officialPercent<50?'bg-yellow-500':'bg-emerald-500'}`} style={{width:`${!isOfficialEnabled?0:officialPercent}%`}}></div>
                  </div>
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800 px-3 py-1 rounded flex items-center">
                <span className="text-slate-500 mr-2">Flags:</span>
                <span className="text-red-400 font-bold text-lg">{totalFlags}</span>
              </div>

              {/* Import button */}
              <button onClick={()=>fileInputRef.current?.click()} className="bg-slate-900 border border-slate-700 hover:border-emerald-500 px-3 py-1 rounded flex items-center gap-1 text-slate-300 hover:text-emerald-300 transition-colors text-xs" title="Import Oracle JSON file">
                <Download size={13} className="rotate-180"/> Import
              </button>
              <input ref={fileInputRef} type="file" accept=".json" onChange={handleImportJson} className="hidden"/>

              {/* Export all button */}
              {totalFlags>0&&(
                <button onClick={exportFindings} className="bg-slate-900 border border-slate-700 hover:border-blue-500 px-3 py-1 rounded flex items-center gap-1 text-slate-300 hover:text-blue-300 transition-colors text-xs" title="Export all findings as JSON">
                  <Download size={13}/> Export All
                </button>
              )}
            </div>
          </div>

          {/* Filter / Sort bar */}
          {totalFlags>0&&(
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <button onClick={()=>setShowFilterPanel(!showFilterPanel)} className={`flex items-center gap-1 px-3 py-1.5 rounded border text-xs transition-colors ${showFilterPanel?'border-blue-500 bg-blue-900/20 text-blue-300':'border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500'}`}>
                <Filter size={12}/> Filter & Sort
              </button>
              {showFilterPanel&&(
                <div className="flex flex-wrap items-center gap-2 animate-in slide-in-from-top-1 duration-150">
                  <select value={filterType} onChange={e=>setFilterType(e.target.value)} className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 outline-none focus:border-blue-500">
                    <option value="all">All Types</option>
                    {allSuspicionTypes.map(t=><option key={t} value={t}>{t.replace(/_/g,' ')}</option>)}
                  </select>
                  <select value={sortMode} onChange={e=>setSortMode(e.target.value)} className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 outline-none focus:border-blue-500">
                    <option value="score_desc">Score ↓</option>
                    <option value="score_asc">Score ↑</option>
                    <option value="name_asc">Name A→Z</option>
                  </select>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-slate-500">Min score:</span>
                    <input type="number" min="0" max="50" value={minScore} onChange={e=>setMinScore(parseInt(e.target.value)||0)} className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 outline-none focus:border-blue-500 w-16"/>
                  </div>
                  {(filterType!=='all'||sortMode!=='score_desc'||minScore>0)&&(
                    <button onClick={()=>{setFilterType('all');setSortMode('score_desc');setMinScore(0);}} className="text-xs text-slate-500 hover:text-slate-300 underline">Reset</button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Results */}
          {Object.keys(findings).length===0?(
            <div className="h-full flex flex-col items-center justify-center text-slate-600 py-10">
              <Search size={48} className="mb-4 opacity-20"/>
              <p>Awaiting scan findings...</p>
              <p className="text-sm mt-2 max-w-md text-center opacity-50 px-4">The engine dynamically load-balances across the community Gateway cache and the Official API to rapidly map multi-account networks concurrently.</p>
            </div>
          ):(
            <div className="space-y-2">
              {Object.keys(findings).sort().map(country=>(
                <TreeNode key={country} label={`${country}: Sus Results`} icon={Database} isRoot={true} defaultOpen={true} badge={`${getFilteredFindings(findings[country]).length} Suspects`}>
                  {renderGroupedFindings(findings[country])}
                </TreeNode>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
