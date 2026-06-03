import React, { useState, useEffect, useRef } from 'react';
import { 
  ShieldAlert, Play, Square, Activity, ChevronRight, 
  ChevronDown, AlertTriangle, Users, Database, UserX, 
  ExternalLink, RefreshCw, Settings, Search, Star, Coins
} from 'lucide-react';

const WarEraAPI = {
  fetch: async (endpoint, payload, activeKey, baseUrl) => {
    const isGateway = baseUrl.includes('gateway');
    const url = `${baseUrl}${endpoint}`;
    
    const headers = { 'Content-Type': 'application/json' };
    if (activeKey && activeKey.trim() !== '') {
        headers['X-API-Key'] = activeKey.trim();
    }
    
    let res;
    try {
        if (isGateway) {
            // Gateway Proxy Override: Unbatched POST
            res = await fetch(url, { 
                method: 'POST', 
                headers, 
                body: JSON.stringify(payload) 
            });
        } else {
            // Official API: Standard Batched GET
            const input = encodeURIComponent(JSON.stringify({ "0": payload }));
            res = await fetch(`${url}?batch=1&input=${input}`, { headers });
        }
    } catch (e) {
        throw new Error(`Network Error: ${e.message}`);
    }
    
    const text = await res.text();
    let errorMessage = `HTTP ${res.status}`;
    
    if (res.status === 429 || text.includes('Rate limit exceeded') || text.includes('"status":429')) {
        throw new Error("RATE LIMIT TRIGGERED");
    }

    if (!res.ok) {
        try {
            const parsedError = JSON.parse(text);
            const errObj = Array.isArray(parsedError) ? parsedError[0] : parsedError;
            if (errObj?.error?.message) errorMessage = errObj.error.message;
            if (errObj?.error) errorMessage = JSON.stringify(errObj.error);
        } catch(e) {
            if (text.toLowerCase().includes('unknown method')) {
                throw new Error(`Unsupported Gateway Route: ${text}`);
            }
            throw new Error(`HTML response received (Possible Catch-All route). Snippet: ${text.substring(0, 50)}...`);
        }
        throw new Error(`http ${res.status}: ${errorMessage}`);
    }
    
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new Error(`Failed to parse JSON response. Snippet: ${text.substring(0, 50)}...`);
    }

    const resultObj = Array.isArray(data) ? data[0] : data;
    if (resultObj?.error) {
        throw new Error(resultObj.error.message || JSON.stringify(resultObj.error));
    }
    
    return resultObj?.result?.data?.json || resultObj?.result?.data || resultObj;
  }
};

const analyzePlayer = (player, settings, globalCache, addLog) => {
  if (!player) return null;
  
  let rawWorkers = player.companies ? player.companies.flatMap(c => c.workers || []) : [];
  
  const uniqueWorkersMap = new Map();
  rawWorkers.forEach(w => {
    const uid = w._id || w.id || w.user || Math.random().toString(36).slice(2);
    w.uid = uid;
    uniqueWorkersMap.set(uid, w);
  });
  
  let allWorkers = Array.from(uniqueWorkersMap.values());
  const washPartners = player.washPartners || {};
  
  if (allWorkers.length < 2 && Object.keys(washPartners).length === 0) return null;

  const suspiciousWorkers = new Set();
  const validWorkers = [];
  
  allWorkers.forEach(w => {
    w.normalizedName = w.resolvedUser?.username || w.name || 'Unknown';
    w.normalizedWage = w.wage !== undefined ? w.wage : (w.salary || 0);
    w.normalizedLevel = w.resolvedUser?.leveling?.level || w.level || 1;
    w.isActive = w.resolvedUser?.isActive;
    w.normalizedFidelity = w.fidelity !== undefined ? w.fidelity : 0;
    
    if (w.isActive === false && w.normalizedWage > settings.suspiciousWageThreshold) {
        return; 
    }
    
    let signature = 'NO_DATA';
    if (w.resolvedUser?.skills) {
        const skills = w.resolvedUser.skills;
        const skillMap = {};
        
        Object.entries(skills).forEach(([key, data]) => {
          if (typeof data === 'object' && data !== null) {
            let val = 0;
            if (data.total !== undefined && data.total !== null) val = data.total;
            else if (data.value !== undefined && data.value !== null) val = data.value;
            
            if (typeof val === 'number' && val > 0) {
              skillMap[key] = Math.floor(val);
            }
          }
        });
        
        const sortedKeys = Object.keys(skillMap).sort();
        if (sortedKeys.length > 0) {
          const ECO_DEFAULTS = {
            energy: 30,
            production: 10,
            management: 4,
            entrepreneurship: 30
          };
          
          const ecoStats = [];
          sortedKeys.forEach(k => {
            const lowerKey = k.toLowerCase();
            if (ECO_DEFAULTS[lowerKey] !== undefined) {
              const val = skillMap[k];
              if (val > ECO_DEFAULTS[lowerKey]) {
                ecoStats.push(`${k.substring(0,3).toUpperCase()}:${val}`);
              }
            }
          });
          
          if (ecoStats.length > 0) {
            signature = ecoStats.join(' | ');
          } else {
            signature = 'DEFAULT_ECO';
          }
        }
    }
    w.normalizedBuild = signature;
    validWorkers.push(w);
  });

  allWorkers = validWorkers;
  const suspicions = [];

  // --- ITEM MARKET WASH TRADING ---
  let totalCoinsWashed = 0;
  if (Object.keys(washPartners).length > 0) {
      const partnerList = Object.entries(washPartners)
          .map(([id, data]) => {
              const isWorker = allWorkers.some(w => w.uid === id);
              return { id, isWorker, ...data };
          })
          .filter(p => Math.abs(p.netProfit !== 0 ? p.netProfit : p.volume) >= 1); // Discard < 1 coin washes
      
      if (partnerList.length > 0) {
          const workersInvolved = partnerList.filter(p => p.isWorker);
          const othersInvolved = partnerList.filter(p => !p.isWorker);
          
          let detectionWeight = 0;
          let descParts = [];
          
          if (workersInvolved.length > 0) {
              detectionWeight += workersInvolved.length * 2;
              descParts.push(`${workersInvolved.length} Workers (2x Penalty)`);
          }
          if (othersInvolved.length > 0) {
              detectionWeight += othersInvolved.length * 1;
              descParts.push(`${othersInvolved.length} Outside Users`);
          }
          
          partnerList.forEach(p => totalCoinsWashed += Math.abs(p.netProfit !== 0 ? p.netProfit : p.volume));

          suspicions.push({
              type: 'transaction_abuse',
              severity: 'critical',
              desc: `Item Market Wash Trading detected with ${descParts.join(' and ')}. Traded item back-and-forth to launder money.`,
              partners: partnerList,
              detectionWeight
          });
      }
  }

  const lowWageWorkers = allWorkers.filter(w => w.normalizedWage <= settings.suspiciousWageThreshold);
  if (lowWageWorkers.length >= 2) {
    suspicions.push({
      type: 'low_wage',
      severity: lowWageWorkers.length > 4 ? 'high' : 'medium',
      desc: `Found ${lowWageWorkers.length} workers with wages below or equal to ${settings.suspiciousWageThreshold}`,
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
                     overlappingGroups[sub].add(w1);
                     overlappingGroups[sub].add(w2);
                 }
             }
         }
     });
  });
  
  const processedNamingUids = new Set();
  Object.keys(overlappingGroups).sort((a, b) => b.length - a.length).forEach(sub => {
      const groupWorkers = Array.from(overlappingGroups[sub]);
      const unflagged = groupWorkers.filter(w => !processedNamingUids.has(w.uid));
      
      if (unflagged.length >= 2) {
          suspicions.push({
            type: 'naming_pattern',
            severity: 'high',
            desc: `Naming overlap detected: ${unflagged.length} workers share the string "${sub}"`,
            workers: unflagged,
            overlapString: sub 
          });
          unflagged.forEach(w => {
            suspiciousWorkers.add(w);
            processedNamingUids.add(w.uid);
          });
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
      suspicions.push({
        type: 'cloned_progression',
        severity: 'medium',
        desc: `Detected ${group.length} workers with identical skill signatures [${buildSignature}] in level band ${band}+`,
        workers: group
      });
      group.forEach(w => suspiciousWorkers.add(w));
    }
  });

  // --- TARGETED MONEY LAUNDERING HEURISTIC ---
  const launderingWorkers = [];
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  allWorkers.forEach(w => {
      if (w.normalizedLevel >= 22) return; 
      if (!w.muDonations || w.muDonations.length === 0) return;

      let totalDonatedWeekly = 0;
      let largeDonations30Days = 0;
      let totalDonatedAllTime = 0;
      let maxSingleDonation = 0;

      w.muDonations.forEach(tx => {
          const txTime = new Date(tx.createdAt || tx.timestamp || tx.date || Date.now()).getTime();
          
          if (txTime < thirtyDaysAgo) return; 
          
          let amount = tx.amount ?? tx.quantity ?? tx.value ?? tx.gold ?? tx.money ?? tx.total;
          if (typeof amount === 'object' && amount !== null) {
              amount = amount.amount ?? amount.value ?? amount.quantity ?? amount.gold ?? 0;
          }
          if (typeof amount !== 'number') amount = parseFloat(amount) || 0;
          
          if (amount === 0) {
              const possibleVals = Object.values(tx).filter(v => typeof v === 'number' && v < 1000000000000 && v > 0);
              if (possibleVals.length > 0) amount = Math.max(...possibleVals);
          }

          maxSingleDonation = Math.max(maxSingleDonation, amount);
          totalDonatedAllTime += amount;
          
          // Exclude 5g and 25g quest donations from large laundering counts
          if (Math.abs(amount - 5) > 0.01 && Math.abs(amount - 25) > 0.01) {
              largeDonations30Days += amount;
          }
          
          if (txTime >= oneWeekAgo) {
              totalDonatedWeekly += amount;
          }
      });

      w.totalDonatedWeekly = totalDonatedWeekly;
      w.largeDonations30Days = largeDonations30Days;
      w.totalDonatedAllTime = totalDonatedAllTime;
      w.maxDonation = maxSingleDonation;
      
      w.isLaundering = w.maxDonation > 25 || w.totalDonatedWeekly > 60;

      if (w.isLaundering) {
          launderingWorkers.push(w);
      }
  });

  let hasLaundering = false;
  let launderingWorkerCount = 0;
  let totalLaunderedCoins = 0;

  if (launderingWorkers.length > 0) {
      totalLaunderedCoins = launderingWorkers.reduce((sum, w) => sum + (w.largeDonations30Days || w.totalDonatedAllTime || 0), 0);
      suspicions.push({
          type: 'money_laundering',
          severity: 'critical', 
          desc: `Money sent to Boss's MU via large donations (>25 Coins single or >60 Coins total/week) in the past 30 days.`,
          workers: launderingWorkers,
          detectionWeight: launderingWorkers.length
      });
      launderingWorkers.forEach(w => suspiciousWorkers.add(w));
      hasLaundering = true;
      launderingWorkerCount = launderingWorkers.length;
  }

  const shellCompanyWorkers = [];
  const allNoBonusWorkers = []; 
  let zeroBonusCompanyCount = 0;
  let totalWorkerCompanyCount = 0;

  allWorkers.forEach(w => {
      w.noBonusOwnedCompanies = [];
      if (!w.ownedCompanies || w.ownedCompanies.length === 0) return;

      if (w.isActive === false || w.normalizedLevel >= 30) return;

      w.ownedCompanies.forEach(comp => {
          const itemCode = typeof comp.itemCode === 'object' ? comp.itemCode?._id || comp.itemCode?.code : comp.itemCode;
          const regionId = typeof comp.region === 'object' ? comp.region?._id : comp.region;
          if (!itemCode || !regionId) return;

          const regionObj = globalCache.regions[regionId];
          if (!regionObj) return;

          let hasTimedDeposit = false;
          if (regionObj.bonuses && Array.isArray(regionObj.bonuses)) {
              hasTimedDeposit = regionObj.bonuses.some(b => {
                  const bCode = typeof b.item === 'object' ? b.item?._id || b.item?.code : b.item;
                  return String(bCode).toLowerCase() === String(itemCode).toLowerCase();
              });
          }
          if (hasTimedDeposit) return;

          const countryId = typeof regionObj.country === 'object' ? regionObj.country?._id : (regionObj.country || regionObj.countryId);
          const countryObj = globalCache.countries[countryId];
          
          if (!countryObj || !countryObj.specializedItem) return; 

          const specialized = String(typeof countryObj.specializedItem === 'object' ? countryObj.specializedItem.code || countryObj.specializedItem._id : countryObj.specializedItem).toLowerCase();
          const produced = String(itemCode).toLowerCase();

          if (specialized !== produced && specialized !== 'undefined' && produced !== 'undefined') {
              w.noBonusOwnedCompanies.push(comp);
          }
      });

      // Track aggregate portfolio counts for ALL valid workers
      totalWorkerCompanyCount += w.ownedCompanies.length;
      zeroBonusCompanyCount += w.noBonusOwnedCompanies.length;

      if (w.noBonusOwnedCompanies.length > 0) {
          w.noBonusPercentage = Math.round((w.noBonusOwnedCompanies.length / w.ownedCompanies.length) * 100);
          w.noBonusCount = w.noBonusOwnedCompanies.length;
          w.totalOwnedCount = w.ownedCompanies.length;
          
          allNoBonusWorkers.push(w);
          
          if (w.noBonusPercentage > 25) {
              shellCompanyWorkers.push(w);
          }
      }
  });

  let bossNoBonusPercentage = 0;
  if (totalWorkerCompanyCount > 0) {
      bossNoBonusPercentage = Math.round((zeroBonusCompanyCount / totalWorkerCompanyCount) * 100);
  }

  const isOnlyNoProd = suspicions.length === 0 && shellCompanyWorkers.length > 0;
  let shouldFlagNoProd = true;
  
  if (isOnlyNoProd) {
      const severeShells = shellCompanyWorkers.filter(w => w.noBonusPercentage >= 50);
      if (severeShells.length < 2 || bossNoBonusPercentage < 50) {
          shouldFlagNoProd = false;
      }
  }

  if (shellCompanyWorkers.length > 0 && shouldFlagNoProd) {
      suspicions.push({
          type: 'no_production_bonus',
          severity: 'high',
          desc: `Found ${shellCompanyWorkers.length} workers where >25% of their portfolio are NO production bonus companies.`,
          workers: allNoBonusWorkers, // Display all >0% in the UI box
          detectionWeight: shellCompanyWorkers.length // Only add >25% to detection weight
      });
      allNoBonusWorkers.forEach(w => suspiciousWorkers.add(w)); 
  }

  if (suspicions.length > 0) {
    let summaryParts = [];
    
    const wageSus = suspicions.find(s => s.type === 'low_wage');
    if (wageSus) {
        summaryParts.push(`${wageSus.workers.length} workers are paid very low wages.`);
    }

    if (hasLaundering) {
        summaryParts.push(`${launderingWorkerCount} workers have donated a total of ${totalLaunderedCoins.toFixed(1)} Coins to their Boss's MU in large transactions.`);
    }

    const cloneSus = suspicions.filter(s => s.type === 'cloned_progression');
    if (cloneSus.length > 0) {
        const totalClonedWorkers = cloneSus.reduce((sum, cluster) => sum + cluster.workers.length, 0);
        summaryParts.push(`${totalClonedWorkers} workers have cloned skills.`);
    }

    const shellSus = suspicions.find(s => s.type === 'no_production_bonus');
    if (shellSus) {
        summaryParts.push(`${bossNoBonusPercentage}% of worker companies have no regional production bonuses.`);
    }

    const nameSus = suspicions.filter(s => s.type === 'naming_pattern');
    if (nameSus.length > 0) {
        const uniqueNamedWorkers = new Set();
        nameSus.forEach(cluster => cluster.workers.forEach(w => uniqueNamedWorkers.add(w.uid)));
        summaryParts.push(`${uniqueNamedWorkers.size} workers have overlapping naming patterns.`);
    }

    if (Object.keys(washPartners).length > 0) {
        const abuseSus = suspicions.find(s => s.type === 'transaction_abuse');
        summaryParts.push(`Wash Trading ring detected with ${abuseSus?.partners?.length || 0} partners.`);
    }

    suspicions.sort((a, b) => {
        if (a.type === 'money_laundering') return -1;
        if (b.type === 'money_laundering') return 1;
        return (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0);
    });

    return {
      player,
      summary: summaryParts.join(' '),
      suspicions,
      detections: suspicions.reduce((acc, s) => acc + (s.detectionWeight !== undefined ? s.detectionWeight : s.workers.length), 0),
      zeroBonusCompanyCount,
      bossNoBonusPercentage,
      hasLaundering,
      launderingWorkerCount,
      totalLaunderedCoins,
      washPartners,
      washPartnerCount: washPartners ? Object.keys(washPartners).length : 0,
      totalCoinsWashed
    };
  }

  return null;
};

class UnionFind {
    constructor() {
        this.parent = {};
    }
    add(id) {
        if (!this.parent[id]) {
            this.parent[id] = id;
        }
    }
    find(id) {
        if (this.parent[id] !== id) {
            this.parent[id] = this.find(this.parent[id]);
        }
        return this.parent[id];
    }
    union(id1, id2) {
        this.add(id1);
        this.add(id2);
        const root1 = this.find(id1);
        const root2 = this.find(id2);
        if (root1 !== root2) {
            this.parent[root2] = root1;
        }
    }
}

const WashNetworkTree = ({ rootId, washPartners, processedNodes = new Set(), globalBans = {}, globalNames = {}, isRootNode = true }) => {
    if (processedNodes.has(rootId)) return null;
    
    const currentProcessed = new Set(processedNodes);
    currentProcessed.add(rootId);
    
    const partners = Object.entries(washPartners[rootId] || {}).map(([id, data]) => ({id, ...data}));
    const validPartners = partners.filter(p => !currentProcessed.has(p.id));
    
    if (validPartners.length === 0 && isRootNode && processedNodes.size > 0) return null;

    const rootName = globalNames[rootId] || rootId;

    return (
        <div className={`flex flex-col ${isRootNode ? '' : 'mt-2'}`}>
            <div className={`inline-flex items-center border rounded px-2 py-1 w-fit z-10 bg-slate-900 hover:bg-slate-800 transition-colors ${isRootNode ? 'border-yellow-700/50' : 'border-slate-700'}`}>
                <a href={`https://app.warera.io/user/${rootId}`} target="_blank" rel="noopener noreferrer" className={`hover:underline flex items-center gap-1 font-mono text-xs ${isRootNode ? 'text-yellow-500 font-bold' : 'text-slate-300'}`} onClick={(e) => e.stopPropagation()}>
                    {rootName}
                    {isRootNode && <ExternalLink size={8} className="opacity-50"/>}
                </a>
                {globalBans[rootId] && <span className="ml-2 bg-red-900/80 text-red-300 px-1 py-0.5 rounded text-[8px] border border-red-700/50 font-bold tracking-wider shrink-0">BANNED</span>}
            </div>
            
            {validPartners.length > 0 && (
                <div className="ml-4 border-l border-slate-700 pl-4 flex flex-col relative pt-1 pb-1">
                    {validPartners.map((p) => (
                        <div key={p.id} className="relative">
                            <div className="absolute w-4 h-[1px] bg-slate-700 -left-4 top-4"></div>
                            <WashNetworkTree 
                                rootId={p.id} 
                                washPartners={washPartners} 
                                processedNodes={currentProcessed} 
                                globalBans={globalBans} 
                                globalNames={globalNames}
                                isRootNode={false}
                            />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

const TreeNode = ({ label, icon: Icon, children, isRoot = false, defaultOpen = false, badge = null, badgeClass = null, extraData = null, linkId = null }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`ml-${isRoot ? '0' : '4'} mt-1 border-l border-slate-700 pl-2`}>
      <div 
        className={`flex items-center gap-2 py-1.5 px-2 rounded hover:bg-slate-800 cursor-pointer text-sm ${isRoot ? 'font-semibold text-slate-100' : 'text-slate-300'}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        {children ? (
          isOpen ? <ChevronDown size={14} className="text-slate-500 shrink-0" /> : <ChevronRight size={14} className="text-slate-500 shrink-0" />
        ) : (
          <span className="w-[14px] shrink-0"></span>
        )}
        {Icon && <Icon size={14} className={`shrink-0 ${isRoot ? "text-blue-400" : "text-slate-400"}`} />}
        
        <span className="flex-1 flex items-center min-w-0">
          {linkId ? (
            <a href={`https://app.warera.io/user/${linkId}`} target="_blank" rel="noopener noreferrer" className="hover:text-blue-400 hover:underline flex items-center gap-1 w-fit truncate" onClick={e => e.stopPropagation()}>
              <span className="truncate">{label}</span>
              <ExternalLink size={10} className="shrink-0" />
            </a>
          ) : (
            <span className="truncate">{label}</span>
          )}
        </span>
        
        {badge && (
          <span className={`text-xs px-2 py-0.5 rounded-full font-mono border whitespace-nowrap shrink-0 ${badgeClass || 'bg-red-900/50 text-red-400 border-red-800'}`}>
            {badge}
          </span>
        )}
        {extraData && <span className="text-xs text-slate-500 font-mono whitespace-nowrap shrink-0">{extraData}</span>}
      </div>
      {isOpen && children && (
        <div className="ml-2 animate-in slide-in-from-top-1 duration-200">
          {children}
        </div>
      )}
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
    concurrencyLimit: 50 
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
  const scanQueueRef = useRef([]);

  const addLog = (msg, type = 'info') => {
    setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), msg, type }]);
  };

  useEffect(() => {
    if (showLogs && logsContainerRef.current) {
        logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [logs, showLogs]);

  useEffect(() => {
    const ticker = setInterval(() => {
      setTick(t => t + 1);
    }, 250); 
    return () => clearInterval(ticker);
  }, []);

  useEffect(() => {
    if (apiKey && apiKey.trim().length > 20 && availableRegions.length === 0 && !isScanning) {
        fetchRegions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  const getToken = async (forceOfficial = false) => {
      while (isScanningRef.current) {
          
          while (globalRateLimitRelease.current > Date.now()) {
              if (!isScanningRef.current) throw new Error("Scan Aborted");
              
              const waitMs = globalRateLimitRelease.current - Date.now();
              setIsRateLimited(true);
              setLimitTimer(Math.ceil(waitMs / 1000));
              setCurrentTask(`PAUSED: API COOLDOWN`);
              
              await new Promise(r => setTimeout(r, 500));
          }
          if (isRateLimited) {
              setIsRateLimited(false);
              setCurrentTask(prev => prev.includes('PAUSED') ? `Executing Concurrency Pool (x${settings.concurrencyLimit})...` : prev);
          }

          const now = Date.now();
          gatewayTokens.current = gatewayTokens.current.filter(t => now - t < 60000);
          officialTokens.current = officialTokens.current.filter(t => now - t < 60000);
          
          setTick(t => t + 1); 

          const isOfficialEnabled = apiKey && apiKey.trim() !== '';

          let gCapacity = (3500 - gatewayTokens.current.length) / 3500;
          let oCapacity = isOfficialEnabled ? ((400 - officialTokens.current.length) / 400) : 0;

          if (forceOfficial) gCapacity = -1; 
          if (isGatewayDead.current) gCapacity = -1;

          if (gCapacity > 0 || oCapacity > 0) {
              if (oCapacity > gCapacity) {
                  officialTokens.current.push(now);
                  setTick(t => t + 1);
                  return 'official';
              } else {
                  gatewayTokens.current.push(now);
                  setTick(t => t + 1);
                  return 'gateway';
              }
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

  const smartFetch = async (endpoint, payload, forceOfficial = false) => {
      let route;
      
      if (isScanningRef.current) {
          route = await getToken(forceOfficial);
      } else {
          route = forceOfficial ? 'official' : (isGatewayDead.current ? 'official' : 'gateway');
      }

      const baseUrl = route === 'gateway' ? 'https://gateway.warerastats.io/trpc/' : 'https://api2.warera.io/trpc/';
      const activeKey = apiKey.trim();
      
      try {
          return await WarEraAPI.fetch(endpoint, payload, activeKey, baseUrl);
      } catch (e) {
          if (e.message.includes('RATE LIMIT')) {
              globalRateLimitRelease.current = Date.now() + 10000;
              addLog(`[WARNING] HTTP 429: Rate Limit hit on ${route.toUpperCase()}! Pausing all threads...`, 'warning');
              
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
                  addLog(`[CRITICAL] Gateway failed 4 times. Circuit Breaker snapped. Falling back to Official API entirely.`, 'warning');
                  
                  setTimeout(() => {
                      if (isScanningRef.current) {
                          isGatewayDead.current = false;
                          gatewayFails.current = 0;
                          addLog(`[INFO] Gateway routing resurrected.`, 'info');
                      }
                  }, 60000);
                  
              } else if (!isGatewayDead.current) {
                  addLog(`[DEBUG] Gateway miss on (${endpoint}): ${e.message.split('\n')[0]}. Silent fallback to Official...`, 'warning');
              }
              const isOfficialEnabled = apiKey && apiKey.trim() !== '';
              if (!isOfficialEnabled) throw new Error("Gateway failed and no Live API Key provided for fallback.");
              
              return await smartFetch(endpoint, payload, true); 
          }
          throw e;
      }
  };

  const fetchRegions = async () => {
    addLog('Pinging APIs to retrieve live regions...', 'info');
    let regions = [];
    let success = false;
    
    const endpoints = ['country.getAllCountries', 'country.getCountries', 'country.getAll'];
    for (const ep of endpoints) {
        if (success) break;
        try {
            const data = await smartFetch(ep, {});
            let rList = Array.isArray(data) ? data : (data?.countries || Object.values(data || {}));
            regions = rList.flat().filter(r => r.name);
            
            if (regions.length > 0) {
                regions.sort((a, b) => a.name.localeCompare(b.name));
                setAvailableRegions(regions);
                setTargetRegionId(regions[0]._id || regions[0].id);
                success = true;
                addLog(`✅ Server Ping Success. Retrieved ${regions.length} regions.`, 'info');
                
                regions.forEach(c => globalCacheRef.current.countries[c._id || c.id] = c);

                let regionSuccess = false;
                const regionEps = ['region.getRegionsObject', 'region.getAllRegions', 'region.getAll', 'region.getRegions'];
                for (const regEp of regionEps) {
                    if (regionSuccess) break;
                    try {
                        const rData = await smartFetch(regEp, {});
                        let rArray = Array.isArray(rData) ? rData : (rData?.regions || rData?.data || Object.values(rData || {}));
                        rArray = rArray.flat().filter(r => r && typeof r === 'object' && (r._id || r.id));
                        
                        if (rArray.length > 0) {
                            rArray.forEach(r => globalCacheRef.current.regions[r._id || r.id] = r);
                            regionSuccess = true;
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {
            addLog(`[DEBUG] Region fetch via ${ep} failed: ${e.message.split('\n')[0]}`, 'warning');
        }
    }
  };

  const fetchUserCompaniesFull = async (userId) => {
      let parsed = [];
      for (const ep of ['company.getCompanies', 'company.getUserCompanies', 'company.getCompaniesByUserId']) {
          try {
              const data = await smartFetch(ep, { userId });
              let flat = Array.isArray(data) ? data : (data?.companies || Object.values(data || {}));
              flat = flat.flat(3).filter(c => c !== null);
              if (flat.length > 0) {
                  parsed = flat.map(c => typeof c === 'string' ? { _id: c.split('|').pop(), id: c.split('|').pop() } : c);
                  break;
              }
          } catch(e) {}
      }
      
      await Promise.all(parsed.map(async (c) => {
          if (!isScanningRef.current) return;
          const cId = c._id || c.id;
          if (cId && !c.itemCode) {
              try {
                  const details = await smartFetch('company.getById', { companyId: cId });
                  if (details) Object.assign(c, details);
              } catch(e) {}
          }
      }));
      
      const unique = [];
      const seen = new Set();
      for (const c of parsed) {
          const cid = c._id || c.id;
          if (cid && !seen.has(cid)) {
              seen.add(cid);
              unique.push(c);
          }
      }
      return unique;
  };

  const processPlayer = async (playerObj) => {
      const uId = playerObj._id || playerObj.id;
      let foundName = playerObj.username || playerObj.name || 'Unknown';
      
      let bossMuId = null;
      let hasMuLeadership = false;
      
      try {
          const uData = await smartFetch('user.getUserLite', { userId: uId });
          if (uData) {
              foundName = uData.username || uData.name || foundName;
              if (uData.isBanned || uData.banned) {
                  addLog(`[OK] Player ${foundName} cleared (Account is banned).`, 'info');
                  return;
              }
              if (uData.mu) bossMuId = typeof uData.mu === 'object' ? (uData.mu._id || uData.mu.id) : uData.mu;
              else if (uData.militaryUnit) bossMuId = typeof uData.militaryUnit === 'object' ? (uData.militaryUnit._id || uData.militaryUnit.id) : uData.militaryUnit;
              else if (uData.muId) bossMuId = uData.muId;
          }
      } catch (e) {}

      if (bossMuId) {
          try {
              const muData = await smartFetch('mu.getById', { muId: bossMuId });
              if (muData) {
                  const managers = muData.roles?.managers || [];
                  const commanders = muData.roles?.commanders || [];
                  
                  if (managers.includes(uId) || commanders.includes(uId)) {
                      hasMuLeadership = true;
                  }
              }
          } catch(e) {}
      }
      
      let itemMarketTxs = [];
      try {
          let nextCursor = null;
          do {
              if (!isScanningRef.current) break;
              const txPayload = { transactionType: 'itemMarket', userId: uId, limit: 100 };
              if (nextCursor) txPayload.cursor = nextCursor;
              
              const txData = await smartFetch('transaction.getPaginatedTransactions', txPayload);
              let items = Array.isArray(txData) ? txData : (txData?.items || txData?.data || txData?.transactions || []);
              itemMarketTxs.push(...items);
              
              nextCursor = txData?.nextCursor || txData?.meta?.nextCursor || null;
              if (itemMarketTxs.length >= 1000) break; 
          } while (nextCursor);
      } catch(e) {}

      const washPartners = {};
      const itemGroups = {};
      
      itemMarketTxs.forEach(tx => {
          let pseudoItemId;
          if (typeof tx.item === 'object' && tx.item !== null) {
              const itemCode = tx.itemCode || tx.item.code || 'unknown';
              const acqTime = tx.item.lastAcquisitionAt || 'no_time';
              let statsStr = 'no_stats';
              if (tx.item.skills) {
                  statsStr = Object.entries(tx.item.skills)
                      .map(([k, v]) => `${k}:${typeof v === 'object' && v !== null ? (v.value ?? v.total ?? 0) : v}`)
                      .sort().join('-');
              }
              pseudoItemId = `${itemCode}_${acqTime}_${statsStr}`;
          } else {
              pseudoItemId = tx.item || tx._id;
          }
          tx.pseudoItemId = pseudoItemId;
          
          if (!pseudoItemId) return;
          if (!itemGroups[pseudoItemId]) itemGroups[pseudoItemId] = [];
          itemGroups[pseudoItemId].push(tx);
      });

      Object.entries(itemGroups).forEach(([itemId, txs]) => {
          if (txs.length < 2) return;
          
          txs.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
          
          for (let i = 0; i < txs.length - 1; i++) {
              const tx1 = txs[i];
              const s1 = typeof tx1.seller === 'object' ? tx1.seller?._id : (tx1.sellerId || tx1.seller);
              const b1 = typeof tx1.buyer === 'object' ? tx1.buyer?._id : (tx1.buyerId || tx1.buyer);
              
              if (s1 !== uId && b1 !== uId) continue;

              for (let j = i + 1; j < txs.length; j++) {
                  const tx2 = txs[j];
                  const s2 = typeof tx2.seller === 'object' ? tx2.seller?._id : (tx2.sellerId || tx2.seller);
                  const b2 = typeof tx2.buyer === 'object' ? tx2.buyer?._id : (tx2.buyerId || tx2.buyer);
                  
                  if (s2 !== uId && b2 !== uId) continue;
                  if (s1 === b1 || s2 === b2) continue; 

                  let isCircular = false;
                  let p1, p2;

                  if (s1 === uId && b2 === uId) { 
                      isCircular = true; p1 = b1; p2 = s2;
                  } else if (b1 === uId && s2 === uId) { 
                      if (s1 === b2) {
                          isCircular = true; p1 = s1; p2 = b2;
                      }
                  }

                  if (isCircular) {
                      const isClassic = (p1 === p2);
                      const threshold = isClassic ? 1 : 25; 
                      
                      const m1 = parseFloat(tx1.money || tx1.price || tx1.value || 0);
                      const m2 = parseFloat(tx2.money || tx2.price || tx2.value || 0);
                      
                      if (m1 < threshold || m2 < threshold) continue;
                      
                      const processLeg = (partnerId, money, txId, txTime, bossIsSeller) => {
                          if (!partnerId || partnerId === uId) return;
                          if (!washPartners[partnerId]) washPartners[partnerId] = { volume: 0, netProfit: 0, txCount: 0, items: new Set(), latestTrade: 0 };
                          
                          if (!washPartners[partnerId].items.has(txId)) {
                              washPartners[partnerId].txCount += 1;
                              washPartners[partnerId].items.add(txId);
                              washPartners[partnerId].volume += money;
                              washPartners[partnerId].latestTrade = Math.max(washPartners[partnerId].latestTrade || 0, txTime);
                              
                              if (bossIsSeller) washPartners[partnerId].netProfit += money;
                              else washPartners[partnerId].netProfit -= money;
                          }
                      };

                      processLeg(p1, m1, tx1._id, new Date(tx1.createdAt || 0).getTime(), s1 === uId);
                      processLeg(p2, m2, tx2._id, new Date(tx2.createdAt || 0).getTime(), s2 === uId);
                  }
              }
          }
      });

      for (const partnerId of Object.keys(washPartners)) {
          if (!globalWashPartners.current[uId]) globalWashPartners.current[uId] = {};
          globalWashPartners.current[uId][partnerId] = { ...washPartners[partnerId] };
          
          try {
              const pData = await smartFetch('user.getUserLite', { userId: partnerId });
              if (pData) {
                  washPartners[partnerId].name = pData.username || pData.name || partnerId;
                  washPartners[partnerId].level = pData.leveling?.level || '?';
                  globalCacheRef.current.names[partnerId] = washPartners[partnerId].name;
                  
                  const isPBanned = !!(pData.isBanned || pData.banned || pData.infos?.isBanned);
                  washPartners[partnerId].isBanned = isPBanned;
                  globalBans.current[partnerId] = isPBanned;
              }
          } catch(e) {
              washPartners[partnerId].name = partnerId;
              washPartners[partnerId].level = '?';
          }
          
          if (!playerObj.isSecondaryScan) {
              scanQueueRef.current.push({ _id: partnerId, scanContext: playerObj.scanContext, isSecondaryScan: true });
          }
      }

      const parsedCompanies = await fetchUserCompaniesFull(uId);

      if (parsedCompanies.length < 1 && Object.keys(washPartners).length === 0) { 
          addLog(`[OK] Player ${foundName} cleared.`, 'info');
          return;
      }

      let successfulWorkerEndpoint = null;
      let successfulWorkerSchema = null;
      
      if (parsedCompanies.length > 0) {
          const testCid = parsedCompanies[0]._id || parsedCompanies[0].id;
          if (testCid) {
               const workerEndpoints = ['worker.getWorkers', 'company.getWorkers', 'company.getEmployees'];
               for (const wep of workerEndpoints) {
                   if (successfulWorkerEndpoint) break;
                   try {
                       await smartFetch(wep, { companyId: testCid });
                       successfulWorkerEndpoint = wep;
                       successfulWorkerSchema = 'companyId';
                       break; 
                   } catch (e1) {
                       try {
                           await smartFetch(wep, { id: testCid });
                       successfulWorkerEndpoint = wep;
                       successfulWorkerSchema = 'id';
                       break;
                       } catch (e2) {}
                   }
               }
          }

          if (successfulWorkerEndpoint) {
               await Promise.all(parsedCompanies.map(async (company) => {
                   if (!isScanningRef.current) return;
                   const cId = company._id || company.id;
                   const schema = successfulWorkerSchema === 'companyId' ? { companyId: cId } : { id: cId };
                   try {
                       const rawWorkers = await smartFetch(successfulWorkerEndpoint, schema);
                       let flatWorkers = Array.isArray(rawWorkers) ? rawWorkers : (rawWorkers?.workers || Object.values(rawWorkers || {}));
                       flatWorkers = flatWorkers.flat(3).filter(w => typeof w === 'object' && w !== null);
                       
                       await Promise.all(flatWorkers.map(async (w) => {
                           if (w.user && typeof w.user === 'string') {
                               try {
                                   const uData = await smartFetch('user.getUserLite', { userId: w.user });
                                   if (uData) {
                                       w.resolvedUser = uData;
                                       w.isBanned = !!(uData.isBanned || uData.banned || uData.infos?.isBanned);
                                       globalCacheRef.current.names[w.user] = uData.username || uData.name || w.user;
                                       
                                       let workerMuId = null;
                                       if (uData.mu) workerMuId = typeof uData.mu === 'object' ? (uData.mu._id || uData.mu.id) : uData.mu;
                                       else if (uData.militaryUnit) workerMuId = typeof uData.militaryUnit === 'object' ? (uData.militaryUnit._id || uData.militaryUnit.id) : uData.militaryUnit;
                                       else if (uData.muId) workerMuId = uData.muId;
                                       
                                       w.workerMuId = workerMuId;
                                   }
                                   
                                   const level = uData?.leveling?.level || 1;
                                   const isActive = uData?.isActive;
                                   
                                   if (isActive !== false && level < 30) {
                                       w.ownedCompanies = await fetchUserCompaniesFull(w.user);
                                   } else {
                                       w.ownedCompanies = [];
                                   }

                                   if (hasMuLeadership && bossMuId && w.workerMuId === bossMuId) {
                                       try {
                                           const txData = await smartFetch('transaction.getPaginatedTransactions', { 
                                               userId: w.user, 
                                               muId: bossMuId, 
                                               transactionType: 'donation', 
                                               limit: 100 
                                           });
                                           const items = Array.isArray(txData) ? txData : (txData?.items || txData?.data || txData?.transactions || []);
                                           w.muDonations = items;
                                       } catch(e) {}
                                   }

                               } catch (e) {}
                           }
                       }));
                       company.workers = flatWorkers;
                   } catch(err) {}
               }));
          }
      }

      const livePlayer = { id: uId, name: foundName, isBanned: playerObj.isBanned, country: playerObj.scanContext || 'Unknown Target', companies: parsedCompanies, washPartners };
      const result = analyzePlayer(livePlayer, settings, globalCacheRef.current, addLog);
      
      if (result) {
          addLog(`[WARNING] Suspicious patterns detected for player: ${foundName}`, 'warning');
          setFindings(prev => {
            const newState = { ...prev };
            if (!newState[livePlayer.country]) newState[livePlayer.country] = [];
            if (!newState[livePlayer.country].some(r => r.player.id === result.player.id)) {
                newState[livePlayer.country].push(result);
            }
            return newState;
          });
      } else {
          addLog(`[OK] Player ${foundName} cleared.`, 'info');
      }
  };

  const startScan = async () => {
    setIsScanning(true);
    isScanningRef.current = true;
    setProgress(0);
    setFindings({});
    setLogs([]);
    gatewayFails.current = 0;
    isGatewayDead.current = false;
    globalRateLimitRelease.current = 0;
    setIsRateLimited(false);
    
    globalWashPartners.current = {};
    globalBans.current = {};
    scanQueueRef.current = [];

    addLog(`Initializing High-Concurrency Oracle Engine...`, 'info');

    if (apiKey && apiKey.startsWith('wae_')) {
        addLog(`Verifying API key authorization...`, 'info');
        try {
            const testUrl = 'https://api2.warera.io/trpc/user.getUsers?batch=1&input=%7B%220%22%3A%7B%22limit%22%3A1%7D%7D';
            const testRes = await fetch(testUrl, { headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey.trim() }});
            if (testRes.status === 401 || testRes.status === 403) throw new Error("Auth Failed");
            const testText = await testRes.text();
            if (testText.toLowerCase().includes('unauthorized') || testText.toLowerCase().includes('invalid api key')) throw new Error("Auth Failed");
            addLog(`✅ API Key Authorized.`, 'info');
        } catch (e) {
            if (e.message === 'Auth Failed' || e.message.includes('401') || e.message.includes('403')) {
                addLog(`[CRITICAL] API Key rejected (Unauthorized). Please check your key.`, 'warning');
                setIsScanning(false);
                isScanningRef.current = false;
                setCurrentTask('Idle');
                return;
            }
        }
    }
    
    if (targetUserId) {
        let actualTargetId = targetUserId.trim();
        
        if (actualTargetId && !/^[0-9a-fA-F]{24}$/.test(actualTargetId)) {
            addLog(`Attempting to resolve exact username "${actualTargetId}" via global search...`, 'info');
            try {
                const searchData = await smartFetch('search.searchAnything', { searchText: actualTargetId });
                
                let foundExactId = null;
                const targetLower = actualTargetId.toLowerCase();

                const extractIds = (obj) => {
                    let ids = [];
                    if (Array.isArray(obj)) {
                        for (let item of obj) {
                            if (typeof item === 'string' && /^[0-9a-fA-F]{24}$/.test(item)) ids.push(item);
                            else if (typeof item === 'object') ids.push(...extractIds(item));
                        }
                    } else if (typeof obj === 'object' && obj !== null) {
                        for (let key in obj) {
                            if (key === 'userIds' && Array.isArray(obj[key])) ids.push(...obj[key].filter(i => /^[0-9a-fA-F]{24}$/.test(i)));
                            else if (typeof obj[key] === 'object') ids.push(...extractIds(obj[key]));
                        }
                    }
                    return ids;
                };

                const possibleIds = extractIds(searchData);
                
                if (possibleIds.length > 0) {
                    addLog(`[LIVE] Search returned ${possibleIds.length} potential IDs. Verifying exact match...`, 'info');
                    for (const id of possibleIds) {
                        try {
                            const uProfile = await smartFetch('user.getUserLite', { userId: id });
                            if (uProfile && (String(uProfile.username || '').toLowerCase() === targetLower || String(uProfile.name || '').toLowerCase() === targetLower)) {
                                foundExactId = id;
                                break;
                            }
                        } catch(e) {}
                    }
                }
                
                if (foundExactId) {
                    actualTargetId = foundExactId;
                    addLog(`[LIVE] Resolved exact match "${targetUserId}" to ID: ${actualTargetId}`, 'info');
                } else {
                     addLog(`Could not locate an exact match for "${targetUserId}" in the search results.`, 'warning');
                     addLog(`[CRITICAL] Failed to resolve "${targetUserId}" to a valid Database ID. Scan aborted.`, 'warning');
                     setIsScanning(false);
                     isScanningRef.current = false;
                     setCurrentTask('Idle');
                     return;
                }
            } catch (e) {
                addLog(`Global search failed: ${e.message}`, 'warning');
            }
        }

        scanQueueRef.current = [{ _id: actualTargetId, scanContext: 'Targeted User' }];
        addLog(`Initiating targeted API scan for User ID: ${actualTargetId}`, 'info');
    } else if (targetRegionId) {
        const rName = availableRegions.find(r => (r._id || r.id) === targetRegionId)?.name || targetRegionId;
        addLog(`Initiating regional scan for: ${rName}...`, 'info');
        
        let allCitizens = [];
        let nextCursor = null;
        let success = false;
        const endpoints = ['user.getUsersByCountry', 'user.getUsers', 'country.getCitizens'];
        
        for (const ep of endpoints) {
            if (success) break;
            try {
                do {
                    if (!isScanningRef.current) break;
                    
                    while (globalRateLimitRelease.current > Date.now()) {
                        await new Promise(r => setTimeout(r, 500));
                    }

                    const payload = { countryId: targetRegionId, limit: 100 };
                    if (nextCursor) payload.cursor = nextCursor;
                    
                    const res = await smartFetch(ep, payload);
                    let pageData = Array.isArray(res) ? res : (res?.data || res?.items || res?.citizens || Object.values(res || {}));
                    pageData = pageData.flat(3).filter(c => typeof c === 'object' && c !== null);
                    
                    const uniqueCitizens = [];
                    const seenCitizens = new Set();
                    pageData.forEach(c => {
                        const id = c._id || c.id || c.userId;
                        if (!seenCitizens.has(id)) {
                            seenCitizens.add(id);
                            uniqueCitizens.push(c);
                        }
                    });
                    
                    if (uniqueCitizens.length > 0) {
                        allCitizens.push(...uniqueCitizens);
                        success = true;
                        nextCursor = res?.nextCursor || res?.meta?.nextCursor || null;
                        if (nextCursor) addLog(`[LIVE] Fetched page ${allCitizens.length / pageData.length}. Found nextCursor...`, 'info');
                    } else {
                        nextCursor = null;
                    }
                    
                    if (allCitizens.length > 2000) {
                        addLog(`[WARNING] Safety cap reached (2000 users). Terminating region fetch.`, 'warning');
                        break;
                    }
                } while (nextCursor);
            } catch (e) {
                addLog(`[DEBUG] Endpoint ${ep} failed: ${e.message.split('\n')[0].substring(0, 100)}...`, 'warning');
            }
        }
        
        const finalCitizensMap = new Map();
        allCitizens.forEach(c => {
            const id = c._id || c.id || c.userId;
            finalCitizensMap.set(id, c);
        });
        allCitizens = Array.from(finalCitizensMap.values());
        
        if (allCitizens.length > 0) {
            allCitizens.forEach(c => c.scanContext = rName);
            addLog(`[LIVE] Acquired ${allCitizens.length} users in region.`, 'info');
            scanQueueRef.current = allCitizens;
        }
    }

    if (scanQueueRef.current.length === 0) {
        addLog(`[CRITICAL] No targets acquired.`, 'warning');
        setIsScanning(false);
        isScanningRef.current = false;
        setCurrentTask('Idle');
        return;
    }

    const processedIds = new Set();
    let playersScanned = 0;
    
    let activePromises = [];
    setCurrentTask(`Executing Concurrency Pool (x${settings.concurrencyLimit})...`);

    try {
        while (isScanningRef.current && (scanQueueRef.current.length > 0 || activePromises.length > 0)) {
            
            while (scanQueueRef.current.length > 0 && activePromises.length < settings.concurrencyLimit) {
                const player = scanQueueRef.current.shift();
                
                const pid = player._id || player.id;
                if (processedIds.has(pid)) continue;
                processedIds.add(pid);
                
                const p = (async () => {
                    await new Promise(r => setTimeout(r, 10)); 
                    try {
                        await processPlayer(player);
                    } catch (err) {
                        addLog(`[CRITICAL] Engine crash on player ${player.name || player._id}: ${err.message}`, 'warning');
                    }
                })();
                
                p.finally(() => {
                    activePromises = activePromises.filter(prom => prom !== p);
                    playersScanned++;
                    
                    const totalEstimated = playersScanned + scanQueueRef.current.length;
                    setProgress(Math.floor((playersScanned / totalEstimated) * 100));
                });
                activePromises.push(p);
            }
            
            if (activePromises.length > 0) {
                await Promise.race(activePromises);
            } else {
                await new Promise(r => setTimeout(r, 100));
            }
        }
        
        await Promise.all(activePromises);
    } finally {
        setIsRateLimited(false);
        if (isScanningRef.current) {
          setCurrentTask('Scan Complete');
          setProgress(100);
          addLog('Scan sequence terminated.', 'info');
        }
        setIsScanning(false);
        isScanningRef.current = false;
    }
  };

  const abortScan = () => {
    setIsScanning(false);
    isScanningRef.current = false;
    setIsRateLimited(false);
    setCurrentTask('Scan Aborted');
    addLog('Scan manually aborted by user.', 'warning');
  };

  const now = Date.now();
  gatewayTokens.current = gatewayTokens.current.filter(t => now - t < 60000);
  officialTokens.current = officialTokens.current.filter(t => now - t < 60000);

  const gatewayCount = gatewayTokens.current.length;
  const officialCount = officialTokens.current.length;

  const gatewayPercent = Math.max(0, ((3500 - gatewayCount) / 3500) * 100);
  const officialPercent = Math.max(0, ((400 - officialCount) / 400) * 100);
  const isOfficialEnabled = apiKey && apiKey.trim() !== '';

  const getNextRefill = (tokens) => {
    if (tokens.length === 0) return 0;
    return Math.ceil((60000 - (now - tokens[0])) / 1000);
  };
  
  const gatewayNext = getNextRefill(gatewayTokens.current);
  const officialNext = getNextRefill(officialTokens.current);

  const getBadgeClass = (detections) => {
      if (detections >= 15) return 'bg-fuchsia-900/50 text-fuchsia-400 border-fuchsia-800';
      if (detections >= 10) return 'bg-red-900/50 text-red-400 border-red-800';
      if (detections >= 5) return 'bg-yellow-900/50 text-yellow-400 border-yellow-800';
      return 'bg-slate-800 text-slate-400 border-slate-700';
  };

  const renderGroupedFindings = (countryFindings) => {
      const uf = new UnionFind();
      
      countryFindings.forEach(f => {
          uf.add(f.player.id);
          Object.keys(f.washPartners || {}).forEach(pid => {
              uf.add(pid);
              uf.union(f.player.id, pid);
          });
      });

      const groups = {};
      const standalone = [];

      countryFindings.forEach(f => {
          if (f.washPartners && Object.keys(f.washPartners).length > 0) {
              const root = uf.find(f.player.id);
              if (!groups[root]) groups[root] = [];
              groups[root].push(f);
          } else {
              standalone.push(f);
          }
      });

      const finalNodes = [];
      const groupStats = [];

      Object.entries(groups).forEach(([rootId, members]) => {
          const allMemberIds = new Set();
          const uniqueEdges = new Set();
          let totalVolume = 0;
          let totalDet = 0;
          const uniqueLaunderers = new Set();
          let ringLaunderCount = 0;
          let ringLaunderedCoins = 0;

          members.forEach(m => {
              allMemberIds.add(m.player.id);
              totalDet += (m.detections || 0);

              Object.entries(m.washPartners || {}).forEach(([pid, pData]) => {
                  allMemberIds.add(pid);
                  const edgeId = [m.player.id, pid].sort().join('_');
                  if (!uniqueEdges.has(edgeId)) {
                      uniqueEdges.add(edgeId);
                      totalVolume += Math.abs(pData.netProfit !== 0 ? pData.netProfit : pData.volume);
                  }
              });

              if (m.hasLaundering) {
                  const launderSus = m.suspicions.find(s => s.type === 'money_laundering');
                  if (launderSus) {
                      launderSus.workers.forEach(w => {
                          if (!uniqueLaunderers.has(w.uid)) {
                              uniqueLaunderers.add(w.uid);
                              ringLaunderCount++;
                              ringLaunderedCoins += (w.largeDonations30Days || w.totalDonatedAllTime || 0);
                          }
                      });
                  }
              }
          });

          groupStats.push({
              rootId,
              members,
              allMemberIds,
              totalVolume,
              totalDet,
              ringLaunderCount,
              ringLaunderedCoins
          });
      });

      groupStats.sort((a, b) => b.totalVolume - a.totalVolume).forEach(stats => {
          if (stats.allMemberIds.size <= 1) {
              finalNodes.push(...stats.members.map((result, idx) => renderResultNode(result, idx)));
              return;
          }

          let ringBannedCount = 0;
          stats.allMemberIds.forEach(id => {
              if (globalBans.current[id]) ringBannedCount++;
          });

          const ringLeader = stats.members.reduce((prev, current) => (prev.detections > current.detections) ? prev : current);
          const trueRootId = ringLeader.player.id;
          const rootName = ringLeader.player.name;

          finalNodes.push(
              <TreeNode 
                  key={`group_${stats.rootId}`} 
                  label={
                      <span className="flex items-center gap-1">
                          Trading Ring ({stats.allMemberIds.size} <Users size={12}/>{ringBannedCount > 0 ? `, ${ringBannedCount} BANNED` : ''}) - <span className="font-bold text-yellow-500 ml-1">{rootName}</span>
                      </span>
                  } 
                  icon={Activity}
                  defaultOpen={false}
                  badge={`${stats.totalDet} Detections`}
                  badgeClass={getBadgeClass(stats.totalDet)}
                  extraData={
                      <span className="flex items-center gap-2 font-bold ml-2">
                          <span className="text-yellow-400 flex items-center gap-1">| {stats.totalVolume.toFixed(1)} <Coins size={12}/> </span>
                          {stats.ringLaunderCount > 0 && (
                              <span className="text-red-500 flex items-center gap-1">| {stats.ringLaunderCount}x <Star fill="#ef4444" size={12}/> {stats.ringLaunderedCoins.toFixed(1)} <Coins size={12}/> </span>
                          )}
                      </span>
                  }
              >
                  <div className="ml-6 my-2 space-y-2 border-l border-slate-800 pl-4 py-2">
                      <div className="bg-slate-900 border border-slate-700/50 rounded p-3 text-sm mb-4">
                         <div className="text-xs font-bold text-slate-400 mb-2 flex items-center gap-1 uppercase tracking-wider">WASH TRADING NETWORK MAP</div>
                         <WashNetworkTree rootId={trueRootId} washPartners={globalWashPartners.current} processedNodes={new Set()} globalBans={globalBans.current} globalNames={globalCacheRef.current.names} />
                      </div>
                      
                      {stats.members.sort((a,b) => b.detections - a.detections).map((result, idx) => renderResultNode(result, idx, true))}
                  </div>
              </TreeNode>
          );
      });

      standalone.sort((a,b) => b.detections - a.detections).forEach((result, idx) => {
          finalNodes.push(renderResultNode(result, idx));
      });

      return finalNodes;
  };

  const renderResultNode = (result, idx, forceOpen = false) => {
      let redStars = 0;
      let yellowStars = 0;

      if (result.hasLaundering) redStars = result.launderingWorkerCount;
      if (result.washPartners && Object.keys(result.washPartners).length > 0) yellowStars = Object.keys(result.washPartners).length;

      return (
          <TreeNode 
            key={result.player.id} 
            label={
              <>
                <span className="truncate">{result.player.name}</span>
                {result.player.isBanned && (
                    <span className="ml-2 bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded text-[9px] border border-red-700/50 font-bold tracking-wider align-middle shrink-0">BANNED</span>
                )}
              </>
            } 
            icon={UserX}
            defaultOpen={forceOpen && idx === 0} 
            badge={
              <span className="flex items-center gap-1">
                {(redStars > 0 || yellowStars > 0) && (
                    <span className="flex items-center font-bold drop-shadow-md mr-1 bg-purple-900/40 px-1.5 py-0.5 rounded border border-purple-800/50">
                      {redStars > 0 && <span className="flex items-center text-red-500 mr-2">{redStars > 1 ? `${redStars}x ` : ''}<Star fill="#ef4444" size={12} className="mx-1" />{result.totalLaunderedCoins?.toFixed(1) || '0'}<Coins size={10} className="ml-0.5"/></span>}
                      {yellowStars > 0 && <span className="flex items-center text-yellow-400">{yellowStars > 1 ? `${yellowStars}x ` : ''}<Star fill="#facc15" size={12} className="ml-0.5" /></span>}
                    </span>
                )}
                <span>{result.zeroBonusCompanyCount > 0 ? `(${result.zeroBonusCompanyCount} No-Prod Cos, ${result.bossNoBonusPercentage}%) (${result.detections} Det)` : `${result.detections} Detections`}</span>
              </span>
            }
            badgeClass={getBadgeClass(result.detections)}
            extraData={`ID: ${result.player.id}`}
            linkId={result.player.id}
          >
            <div className="ml-2 md:ml-6 my-2 space-y-2 border-l border-slate-800 pl-2 md:pl-4 py-2">
              <div className="bg-slate-900 border border-slate-700/50 rounded p-3 text-sm mb-4">
                 <div className="text-xs font-bold text-slate-400 mb-1 flex items-center gap-1"><Activity size={12}/> Analysis Summary</div>
                 <p className="text-slate-300 leading-relaxed">{result.summary}</p>
              </div>
              
              <div className="text-xs uppercase font-bold text-slate-500 mb-2">Detected Anomalies</div>
              {result.suspicions.map((suspicion, sIdx) => (
                <div key={sIdx} className="bg-slate-900 border border-slate-800 rounded p-2 text-sm">
                  <div className="flex items-center gap-2 font-semibold text-slate-200 mb-1">
                    {suspicion.type === 'money_laundering' ? <Star fill="#ef4444" size={14} className="text-red-500"/> : 
                     suspicion.type === 'transaction_abuse' ? <Star fill="#facc15" size={14} className="text-yellow-400"/> :
                     <AlertTriangle size={14} className={suspicion.severity === 'high' ? 'text-red-500' : 'text-yellow-500'} />}
                    {suspicion.type.replace('_', ' ').toUpperCase()}
                  </div>
                  <p className="text-slate-400 text-xs mb-2 flex items-center gap-1 flex-wrap">
                      {suspicion.desc.split('Coins').map((part, i, arr) => (
                          <React.Fragment key={i}>
                              {part}
                              {i !== arr.length - 1 && <Coins size={10} className="text-yellow-400 inline -mt-0.5" />}
                          </React.Fragment>
                      ))}
                  </p>
                  
                  {suspicion.type === 'transaction_abuse' ? (
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2 mt-2">
                        {suspicion.partners.map((p, pIdx) => (
                          <a key={pIdx} href={`https://app.warera.io/user/${p.id}`} target="_blank" rel="noopener noreferrer" className="bg-slate-950 p-2 rounded border border-slate-800 flex flex-col gap-1 hover:border-blue-500 transition-colors group block">
                            <div className="flex justify-between items-center">
                              <span className="font-mono text-xs text-blue-300 flex items-center flex-wrap gap-0">
                                  {p.name}
                                  {p.isBanned && <span title="Banned Player" className="bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded text-[9px] ml-1 border border-red-700/50 font-bold tracking-wider">[BANNED]</span>}
                                  <span className="bg-purple-900/80 text-purple-300 px-1.5 py-0.5 rounded text-[9px] ml-1 border border-purple-700/50 font-bold tracking-wider flex items-center gap-1">
                                      [WASH: {p.txCount} TRADES | {Math.abs(p.netProfit !== 0 ? p.netProfit : p.volume).toFixed(1)} <Coins size={8} className="inline -mt-0.5"/> TRADED]
                                  </span>
                                  {p.isWorker && <span className="bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded text-[9px] ml-1 border border-red-700/50 font-bold tracking-wider">WORKER (2x)</span>}
                              </span>
                              <span className="text-[10px] bg-slate-800 px-1 rounded text-slate-400 group-hover:bg-blue-900 group-hover:text-blue-200 transition-colors whitespace-nowrap">
                                Lvl {p.level} <ExternalLink size={8} className="inline ml-0.5 opacity-50"/>
                              </span>
                            </div>
                            <div className="flex justify-between items-center text-[10px] font-mono mt-1 text-slate-500">
                               <span>Latest Trade: <span className="text-slate-400">{p.latestTrade ? new Date(p.latestTrade).toLocaleDateString() : 'Unknown'}</span></span>
                            </div>
                          </a>
                        ))}
                      </div>
                  ) : (
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2 mt-2">
                        {suspicion.workers.map((w, wIdx) => (
                          <a key={wIdx} href={`https://app.warera.io/user/${w.resolvedUser?._id || w.uid}`} target="_blank" rel="noopener noreferrer" className="bg-slate-950 p-2 rounded border border-slate-800 flex flex-col gap-1 hover:border-blue-500 transition-colors group block">
                            <div className="flex justify-between items-center">
                              <span className="font-mono text-xs text-blue-300 flex items-center flex-wrap gap-0">
                                <span>
                                  {suspicion.type === 'naming_pattern' ? (
                                      w.normalizedName.split(new RegExp(`(${suspicion.overlapString})`, 'gi')).map((part, i) => 
                                          part.toLowerCase() === suspicion.overlapString.toLowerCase() 
                                          ? <span key={i} className="text-yellow-400 font-bold">{part}</span> 
                                          : <span key={i}>{part}</span>
                                      )
                                  ) : w.normalizedName}
                                </span>
                                {w.isBanned && <span title="Banned Player" className="bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded text-[9px] ml-1 border border-red-700/50 font-bold tracking-wider">[BANNED]</span>}
                                {w.isActive === false && !w.isBanned && <span title="Inactive Player" className="bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded text-[9px] ml-1 border border-red-700/50 font-bold tracking-wider">[INACTIVE]</span>}
                                {w.noBonusPercentage > 0 && suspicion.type === 'no_production_bonus' && <span title="Shell Companies Detected" className="bg-orange-900/80 text-orange-300 px-1.5 py-0.5 rounded text-[9px] ml-1 border border-orange-700/50 font-bold tracking-wider">[{w.noBonusPercentage}% NO-PROD, {w.noBonusCount}/{w.totalOwnedCount}]</span>}
                                {w.isLaundering && suspicion.type === 'money_laundering' && (
                                    <span title="Money Laundering Detected" className="bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded text-[9px] ml-1 border border-red-700/50 font-bold tracking-wider flex items-center gap-1">
                                        [{w.largeDonations30Days.toFixed(1)} <Coins size={8} className="inline -mt-0.5"/> IN LARGE DONATIONS]
                                    </span>
                                )}
                              </span>
                              <span className="text-[10px] bg-slate-800 px-1 rounded text-slate-400 group-hover:bg-blue-900 group-hover:text-blue-200 transition-colors whitespace-nowrap">
                                Lvl {w.normalizedLevel} <ExternalLink size={8} className="inline ml-0.5 opacity-50"/>
                              </span>
                            </div>
                            <div className="flex justify-between items-center text-[10px] font-mono mt-1">
                              <span className={w.normalizedWage <= settings.suspiciousWageThreshold ? 'text-red-400' : 'text-green-400'}>
                                Wage: {w.normalizedWage.toFixed(3)}
                              </span>
                              <span className="text-slate-500">
                                Fid: <span className={w.normalizedFidelity === 10 ? 'text-blue-400 font-bold' : 'text-slate-300'}>{w.normalizedFidelity}</span>/10
                              </span>
                            </div>
                          </a>
                        ))}
                      </div>
                  )}
                </div>
              ))}
            </div>
          </TreeNode>
      );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-300 font-sans flex flex-col">
      
      <div className="w-full bg-slate-900 h-5 overflow-hidden relative border-b border-slate-800">
        <div 
          className={`h-5 transition-all duration-300 ${isRateLimited ? 'bg-yellow-500/80' : 'bg-blue-600'}`} 
          style={{ width: `${progress}%` }}
        ></div>
        {isRateLimited && (
          <div className="absolute inset-0 flex items-center justify-center">
             <span className="text-[12px] font-bold text-white tracking-widest drop-shadow-md">
               PAUSED: API COOLDOWN ({limitTimer}s)
             </span>
          </div>
        )}
      </div>

      <header className="bg-slate-900 border-b border-slate-800 p-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <ShieldAlert className="text-red-500" size={28} />
          <div>
            <h1 className="text-xl font-bold text-slate-100 leading-tight">WarEra Oracle</h1>
            <p className="text-xs text-slate-500 font-mono">Multi-Account & Bot Net Detection Heuristics</p>
          </div>
        </div>
        <a 
          href="https://warerastats.io/" 
          target="_blank" 
          rel="noopener noreferrer" 
          className="text-xs text-blue-400 hover:text-blue-300 hover:underline font-mono px-3 py-1 bg-blue-900/20 border border-blue-900/50 rounded-full transition-colors hidden sm:block"
        >
          Supported by warerastats.io
        </a>
      </header>

      <main className="flex-1 flex flex-col md:flex-row overflow-hidden overflow-y-auto md:overflow-hidden">
        
        <div className="w-full md:w-1/3 bg-slate-900/50 border-b md:border-b-0 md:border-r border-slate-800 flex flex-col p-4 gap-4 overflow-y-visible md:overflow-y-auto shrink-0">
          
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 shrink-0">
            <h2 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2">
              <Settings size={16}/> Target & Parameters
            </h2>
            
            <div className="space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Your WarEra API Key (Found in WarEra Settings)</label>
                <input 
                  type="text" 
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Optional API Key"
                  className={`w-full bg-slate-950 border rounded p-2 text-sm outline-none font-mono transition-colors ${
                      apiKey && !apiKey.startsWith('wae_') 
                      ? 'border-red-500 text-red-400 focus:border-red-400' 
                      : 'border-slate-800 text-slate-200 focus:border-blue-500'
                  }`}
                  disabled={isScanning}
                />
                {apiKey && !apiKey.startsWith('wae_') && (
                    <span className="text-[10px] text-red-500 font-bold mt-1 block">Invalid API Key format. Must start with "wae_".</span>
                )}
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Specific User</label>
                <input 
                  type="text" 
                  value={targetUserId}
                  onChange={(e) => setTargetUserId(e.target.value)}
                  placeholder="(Optional)"
                  className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-sm text-slate-200 outline-none focus:border-blue-500 font-mono disabled:opacity-50"
                  disabled={isScanning || (!apiKey || !apiKey.startsWith('wae_'))}
                />
              </div>

              <div>
                <div className="flex justify-between items-end mb-1">
                  <label className="text-xs text-slate-400 block">Target Region</label>
                </div>
                <select 
                  value={targetRegionId}
                  onChange={(e) => setTargetRegionId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-sm text-slate-200 outline-none focus:border-blue-500 disabled:opacity-50"
                  disabled={isScanning || !!targetUserId || availableRegions.length === 0 || (!apiKey || !apiKey.startsWith('wae_'))}
                >
                  {availableRegions.length === 0 && <option value="">{(!apiKey || !apiKey.startsWith('wae_')) ? 'Awaiting Valid API Key...' : 'Pending Network Ping...'}</option>}
                  {availableRegions.map(r => (
                    <option key={r._id || r.id} value={r._id || r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="border-t border-slate-800 pt-4 mt-2">
                <label className="text-xs text-slate-400 block mb-1">Suspicious Wage Threshold</label>
                <div className="flex items-center gap-2">
                  <input 
                    type="range" 
                    min="0.01" max="0.15" step="0.001" 
                    value={settings.suspiciousWageThreshold}
                    onChange={(e) => setSettings({...settings, suspiciousWageThreshold: parseFloat(e.target.value)})}
                    className="flex-1 accent-red-500"
                    disabled={isScanning}
                  />
                  <span className="text-sm font-mono bg-slate-950 px-2 py-1 rounded w-16 text-center border border-slate-800">
                    {settings.suspiciousWageThreshold.toFixed(3)}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-6 flex gap-2">
              {!isScanning ? (
                <button 
                  onClick={startScan}
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2 px-4 rounded flex items-center justify-center gap-2 font-medium transition-colors"
                >
                  <Play size={16} fill="currentColor" /> Initialize Scan
                </button>
              ) : (
                <button 
                  onClick={abortScan}
                  className="flex-1 bg-slate-700 hover:bg-slate-600 text-white py-2 px-4 rounded flex items-center justify-center gap-2 font-medium transition-colors"
                >
                  <Square size={16} fill="currentColor" /> Abort Scan
                </button>
              )}
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col shrink-0">
            <div 
               className="flex justify-between items-center cursor-pointer hover:bg-slate-800 p-1 -m-1 rounded transition-colors"
               onClick={() => setShowLogs(!showLogs)}
            >
              <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                <Activity size={16}/> Scanner Telemetry
              </h2>
              <div className="flex items-center gap-2 text-xs font-mono">
                <span className={isRateLimited ? "text-yellow-400 font-bold" : "text-blue-400 truncate max-w-[150px]"}>
                  {currentTask}
                </span>
                <span className="text-slate-500">[{progress}%]</span>
                {showLogs ? <ChevronDown size={14} className="text-slate-500"/> : <ChevronRight size={14} className="text-slate-500"/>}
              </div>
            </div>

            {showLogs && (
              <div className="mt-3 h-64 bg-slate-950 border border-slate-800 rounded p-3 overflow-y-auto font-mono text-xs flex flex-col gap-1">
                {logs.map((log, i) => (
                  <div key={i} className={`${log.type === 'warning' ? 'text-red-400' : 'text-slate-400'} flex gap-2`}>
                    <span className="text-slate-600 opacity-50 shrink-0">[{log.time}]</span>
                    <span className="break-all">{log.msg}</span>
                  </div>
                ))}
                <div ref={logsContainerRef} />
              </div>
            )}
          </div>

        </div>

        <div className="w-full md:w-2/3 p-4 md:p-6 bg-slate-950 overflow-y-visible md:overflow-y-auto flex-1">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 border-b border-slate-800 pb-4">
            <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
              <Database size={20} className="text-slate-400"/> Analysis Results
            </h2>
            
            <div className="flex flex-wrap items-center gap-4 font-mono text-sm">
              
              <div className="bg-slate-900 border border-slate-800 px-3 py-2 rounded flex items-center w-full sm:w-56 text-xs">
                <div className="flex flex-col gap-1.5 w-full">
                  <div className="flex justify-between text-[10px] text-slate-300 font-semibold leading-none items-center">
                    <span>WarEraStats.io Cache</span>
                    <span className="text-slate-500 font-mono text-[9px]">{gatewayNext > 0 ? `Next: ${gatewayNext}s` : 'Max'}</span>
                  </div>
                  <div className="w-full bg-slate-950 rounded-full h-1.5 border border-slate-800 overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-300 ${gatewayPercent < 20 ? 'bg-red-500' : gatewayPercent < 50 ? 'bg-yellow-500' : 'bg-blue-500'}`} 
                      style={{ width: `${gatewayPercent}%` }}
                    ></div>
                  </div>
                  
                  <div className={`flex justify-between text-[10px] font-semibold leading-none mt-1 items-center ${isOfficialEnabled ? 'text-slate-300' : 'text-slate-600'}`}>
                    <span>WarEra Live API</span>
                    {isOfficialEnabled && <span className="text-slate-500 font-mono text-[9px]">{officialNext > 0 ? `Next: ${officialNext}s` : 'Max'}</span>}
                  </div>
                  <div className="w-full bg-slate-950 rounded-full h-1.5 border border-slate-800 overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-300 ${!isOfficialEnabled ? 'bg-transparent' : officialPercent < 20 ? 'bg-red-500' : officialPercent < 50 ? 'bg-yellow-500' : 'bg-emerald-500'}`} 
                      style={{ width: `${!isOfficialEnabled ? 0 : officialPercent}%` }}
                    ></div>
                  </div>
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800 px-3 py-1 rounded flex items-center">
                <span className="text-slate-500 mr-2">Flags: </span>
                <span className="text-red-400 font-bold text-lg">
                  {Object.values(findings).flat().length}
                </span>
              </div>
            </div>
          </div>

          {Object.keys(findings).length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-600 py-10">
              <Search size={48} className="mb-4 opacity-20" />
              <p>Awaiting scan findings...</p>
              <p className="text-sm mt-2 max-w-md text-center opacity-50 px-4">
                The engine dynamically load-balances across the community Gateway cache and the Official API to rapidly map multi-account networks concurrently.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {Object.keys(findings).sort().map(country => (
                <TreeNode 
                  key={country} 
                  label={`${country}: Sus Results`} 
                  icon={Database} 
                  isRoot={true} 
                  defaultOpen={true}
                  badge={`${findings[country].length} Suspects`}
                >
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
