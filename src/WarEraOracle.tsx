import React, { useState, useEffect, useRef } from 'react';
import { 
  ShieldAlert, Play, Square, Activity, ChevronRight, 
  ChevronDown, AlertTriangle, Users, Database, UserX, 
  ExternalLink, RefreshCw, Settings, Search
} from 'lucide-react';

const FALLBACK_GATEWAY_KEY = 'wae_ad92a24300ca86df1b76b730dec15b0337570a5d0b7119f3f96ee09f4f63e187';

const WarEraAPI = {
  fetch: async (endpoint, payload, activeKey, baseUrl) => {
    const isGateway = baseUrl.includes('gateway');
    const url = `${baseUrl}${endpoint}`;
    
    const headers = { 
        'Content-Type': 'application/json',
        'X-API-Key': activeKey
    };
    
    let res;
    try {
        if (isGateway) {
            res = await fetch(url, { 
                method: 'POST', 
                headers, 
                body: JSON.stringify(payload) 
            });
        } else {
            const input = encodeURIComponent(JSON.stringify({ "0": payload }));
            res = await fetch(`${url}?batch=1&input=${input}`, { headers });
        }
    } catch (e) {
        throw new Error(`Network Error: ${e.message}`);
    }
    
    const text = await res.text();
    let errorMessage = `HTTP ${res.status}`;
    
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
        
        if (res.status === 429) throw new Error("RATE LIMIT TRIGGERED");
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

const analyzePlayer = (player, settings) => {
  if (!player || !player.companies) return null;
  
  let rawWorkers = player.companies.flatMap(c => c.workers || []);
  
  const uniqueWorkersMap = new Map();
  rawWorkers.forEach(w => {
    const uid = w._id || w.id || w.user || Math.random().toString(36).slice(2);
    w.uid = uid;
    uniqueWorkersMap.set(uid, w);
  });
  
  let allWorkers = Array.from(uniqueWorkersMap.values());
  if (allWorkers.length < 2) return null;

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
  if (allWorkers.length < 2) return null;

  const suspicions = [];

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
                 const sub = n1.substring(i, i + len);
                 if (/^\d+$/.test(sub)) continue; 
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
          workers: unflagged
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

  if (suspicions.length > 0) {
    return {
      player,
      suspicions,
      detections: suspicions.reduce((acc, s) => acc + s.workers.length, 0)
    };
  }

  return null;
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
          isOpen ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />
        ) : (
          <span className="w-[14px]"></span>
        )}
        {Icon && <Icon size={14} className={isRoot ? "text-blue-400" : "text-slate-400"} />}
        
        {linkId ? (
          <a href={`https://app.warera.io/user/${linkId}`} target="_blank" rel="noopener noreferrer" className="flex-1 hover:text-blue-400 hover:underline flex items-center gap-1" onClick={e => e.stopPropagation()}>
            {label}
            <ExternalLink size={10} />
          </a>
        ) : (
          <span className="flex-1">{label}</span>
        )}
        
        {badge && (
          <span className={`text-xs px-2 py-0.5 rounded-full font-mono border ${badgeClass || 'bg-red-900/50 text-red-400 border-red-800'}`}>
            {badge}
          </span>
        )}
        {extraData && <span className="text-xs text-slate-500 font-mono">{extraData}</span>}
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
  });
  
  const [apiKey, setApiKey] = useState('');
  const [targetUserId, setTargetUserId] = useState('');
  
  const [availableRegions, setAvailableRegions] = useState([]);
  const [targetRegionId, setTargetRegionId] = useState('');
  
  const gatewayTokens = useRef([]);
  const officialTokens = useRef([]);
  const [gatewayCount, setGatewayCount] = useState(0);
  const [officialCount, setOfficialCount] = useState(0);
  
  const [isRateLimited, setIsRateLimited] = useState(false);
  const [limitTimer, setLimitTimer] = useState(0);
  const [showLogs, setShowLogs] = useState(false);
  const gatewayFails = useRef(0);
  const isGatewayDead = useRef(false);
  
  const logsEndRef = useRef(null);
  const hasAutoFetched = useRef(false);

  const addLog = (msg, type = 'info') => {
    setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), msg, type }]);
  };

  useEffect(() => {
    const ticker = setInterval(() => {
      const now = Date.now();
      let didChange = false;
      
      const prevG = gatewayTokens.current.length;
      gatewayTokens.current = gatewayTokens.current.filter(t => now - t < 60000);
      if (gatewayTokens.current.length !== prevG) didChange = true;
      
      const prevO = officialTokens.current.length;
      officialTokens.current = officialTokens.current.filter(t => now - t < 60000);
      if (officialTokens.current.length !== prevO) didChange = true;
      
      if (didChange) {
          setGatewayCount(gatewayTokens.current.length);
          setOfficialCount(officialTokens.current.length);
      }
    }, 250); 
    
    return () => clearInterval(ticker);
  }, []);

  useEffect(() => {
    if (!hasAutoFetched.current) {
        hasAutoFetched.current = true;
        fetchRegions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getToken = async (forceOfficial = false) => {
      while (isScanningRef.current) {
          const now = Date.now();
          gatewayTokens.current = gatewayTokens.current.filter(t => now - t < 60000);
          officialTokens.current = officialTokens.current.filter(t => now - t < 60000);
          
          setGatewayCount(gatewayTokens.current.length);
          setOfficialCount(officialTokens.current.length);

          const isOfficialEnabled = apiKey && apiKey.trim() !== '';

          let gCapacity = (600 - gatewayTokens.current.length) / 600;
          let oCapacity = isOfficialEnabled ? ((190 - officialTokens.current.length) / 190) : 0;

          if (forceOfficial) gCapacity = -1; 
          if (isGatewayDead.current) gCapacity = -1;

          if (gCapacity > 0 || oCapacity > 0) {
              if (oCapacity > gCapacity) {
                  officialTokens.current.push(now);
                  setOfficialCount(officialTokens.current.length);
                  return 'official';
              } else {
                  gatewayTokens.current.push(now);
                  setGatewayCount(gatewayTokens.current.length);
                  return 'gateway';
              }
          }

          const gNext = gatewayTokens.current[0] || Infinity;
          const oNext = isOfficialEnabled ? (officialTokens.current[0] || Infinity) : Infinity;
          
          let nextExpire = forceOfficial ? oNext : Math.min(gNext, oNext);
          if (nextExpire === Infinity) nextExpire = now; 

          const waitMs = Math.max(10, 60000 - (now - nextExpire) + 10);
          
          setIsRateLimited(true);
          setLimitTimer(Math.ceil(waitMs / 1000));
          setCurrentTask(`PAUSED: API COOLDOWN`);
          
          await new Promise(r => setTimeout(r, Math.min(waitMs, 1000)));
          setIsRateLimited(false); 
          setCurrentTask(prev => prev.includes('PAUSED') ? 'Executing Concurrency Pool...' : prev);
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
      const isOfficialEnabled = apiKey && apiKey.trim() !== '';
      const activeKey = route === 'official' ? apiKey.trim() : (isOfficialEnabled ? apiKey.trim() : FALLBACK_GATEWAY_KEY);
      
      try {
          return await WarEraAPI.fetch(endpoint, payload, activeKey, baseUrl);
      } catch (e) {
          const msg = e.message.toLowerCase();
          const isSchemaErr = msg.includes('no procedure') || msg.includes('too_big') || msg.includes('unrecognized key') || msg.includes('invalid_type');
          
          if (route === 'gateway' && !isSchemaErr) {
              gatewayFails.current += 1;
              if (gatewayFails.current >= 4 && !isGatewayDead.current) {
                  isGatewayDead.current = true;
                  addLog(`[CRITICAL] Gateway failed 4 times. Circuit Breaker snapped. Falling back to Official API entirely.`, 'warning');
              } else if (!isGatewayDead.current) {
                  addLog(`[DEBUG] Gateway miss on (${endpoint}): ${e.message.split('\n')[0]}. Fallback to Official...`, 'warning');
              }
              if (!isOfficialEnabled) throw new Error("Gateway failed and no Live API Key provided for fallback.");
              
              return await smartFetch(endpoint, payload, true); 
          }
          throw e;
      }
  };

  const fetchRegions = async () => {
    addLog('Pinging APIs to retrieve live regions...', 'info');
    const endpoints = ['country.getAllCountries', 'country.getCountries', 'country.getAll'];
    let success = false;
    
    for (const ep of endpoints) {
        if (success) break;
        try {
            const data = await smartFetch(ep, {});
            let regions = Array.isArray(data) ? data : (data?.countries || Object.values(data || {}));
            regions = regions.flat().filter(r => r.name);
            
            if (regions.length > 0) {
                regions.sort((a, b) => a.name.localeCompare(b.name));
                setAvailableRegions(regions);
                setTargetRegionId(regions[0]._id || regions[0].id);
                success = true;
                addLog(`✅ Server Ping Success. Retrieved ${regions.length} regions.`, 'info');
                
                addLog(`Initiating background population sync via Gateway cache...`, 'info');
                (async () => {
                   for (let i = 0; i < regions.length; i++) {
                       if (isGatewayDead.current) break; 
                       try {
                           const res = await WarEraAPI.fetch('user.getUsersByCountry', { countryId: regions[i]._id || regions[i].id, limit: 100 }, apiKey && apiKey.trim() !== '' ? apiKey.trim() : FALLBACK_GATEWAY_KEY, 'https://gateway.warerastats.io/trpc/');
                           let pageData = Array.isArray(res) ? res : (res?.data || res?.items || Object.values(res || {}));
                           pageData = pageData.flat(2).filter(c => typeof c === 'object' && c !== null);
                           
                           setAvailableRegions(prev => {
                               const updated = [...prev];
                               updated[i].population = pageData.length === 100 ? '100+' : pageData.length;
                               return updated;
                           });
                           await new Promise(r => setTimeout(r, 10)); 
                       } catch(e) {}
                   }
                })();
            }
        } catch (e) {}
    }
  };

  const processPlayer = async (playerObj) => {
      try {
          const uId = playerObj._id || playerObj.id;
          let foundName = playerObj.username || playerObj.name || 'Unknown';
          
          try {
              const uData = await smartFetch('user.getUserLite', { userId: uId });
              if (uData) {
                  foundName = uData.username || uData.name || foundName;
                  if (uData.isBanned || uData.banned) {
                      addLog(`[OK] Player ${foundName} cleared (Account is banned).`, 'info');
                      return;
                  }
              }
          } catch (e) {}
          
          let companyData = [];
          let companySuccess = false;
          let parsedCompanies = [];
          const companyEndpoints = ['company.getCompanies', 'company.getUserCompanies', 'company.getCompaniesByUserId'];
          
          for (const ep of companyEndpoints) {
              if (companySuccess) break;
              try {
                  companyData = await smartFetch(ep, { userId: uId });
                  companySuccess = true;
                  let flatData = Array.isArray(companyData) ? companyData : (companyData?.companies || Object.values(companyData || {}));
                  flatData = flatData.flat(3).filter(c => c !== null);
                  
                  if (flatData.length > 0 && typeof flatData[0] === 'string') {
                      parsedCompanies = flatData.map(str => {
                          const id = str.includes('|') ? str.split('|').pop() : str;
                          return { _id: id, id: id };
                      });
                  } else {
                      parsedCompanies = flatData.filter(c => typeof c === 'object');
                  }
              } catch(e) {}
          }

          const uniqueCompanies = [];
          const seenCids = new Set();
          for (const c of parsedCompanies) {
              const cid = c._id || c.id;
              if (!seenCids.has(cid)) {
                  seenCids.add(cid);
                  uniqueCompanies.push(c);
              }
          }
          parsedCompanies = uniqueCompanies;

          // Restored Threshold
          if (parsedCompanies.length < 1) {
              addLog(`[OK] Player ${foundName} cleared (0 companies).`, 'info');
              return;
          }

          let successfulWorkerEndpoint = null;
          let successfulWorkerSchema = null;
          
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
                                   if (uData) w.resolvedUser = uData;
                               } catch (e) {}
                           }
                       }));
                       company.workers = flatWorkers;
                   } catch(err) {}
               }));
          }

          const livePlayer = { id: uId, name: foundName, country: playerObj.scanContext || 'Unknown Target', companies: parsedCompanies };
          const result = analyzePlayer(livePlayer, settings);
          
          if (result) {
              addLog(`[WARNING] Suspicious patterns detected for player: ${foundName}`, 'warning');
              setFindings(prev => {
                const newState = { ...prev };
                if (!newState[livePlayer.country]) newState[livePlayer.country] = [];
                newState[livePlayer.country].push(result);
                newState[livePlayer.country].sort((a, b) => b.detections - a.detections);
                return newState;
              });
          } else {
              addLog(`[OK] Player ${foundName} cleared.`, 'info');
          }
      } catch (fatalError) {
          addLog(`[CRITICAL] Engine crash on player ${playerObj?.username || playerObj?.id || 'Unknown'}: ${fatalError.message}`, 'warning');
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
    setShowLogs(true);
    setIsRateLimited(false);

    addLog(`Initializing High-Concurrency Oracle Engine...`, 'info');
    
    let targetList = [];
    
    if (targetUserId) {
        let actualTargetId = targetUserId.trim();
        
        if (actualTargetId && !/^[0-9a-fA-F]{24}$/.test(actualTargetId)) {
            addLog(`Attempting to resolve username "${actualTargetId}" via global search...`, 'info');
            try {
                const searchData = await smartFetch('search.searchAnything', { searchText: actualTargetId });
                
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
                    actualTargetId = possibleIds[0];
                    addLog(`[LIVE] Resolved "${targetUserId}" to ID: ${actualTargetId}`, 'info');
                } else {
                     addLog(`Could not locate a user named "${targetUserId}" in the search results.`, 'warning');
                     addLog(`[CRITICAL] Failed to resolve "${targetUserId}" to a valid 24-character Database ID. Scan aborted.`, 'warning');
                     setIsScanning(false);
                     isScanningRef.current = false;
                     setCurrentTask('Idle');
                     return;
                }
            } catch (e) {
                addLog(`Global search failed: ${e.message}`, 'warning');
            }
        }

        targetList = [{ _id: actualTargetId, scanContext: 'Targeted User' }];
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
            } catch (e) {}
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
            targetList = allCitizens;
        }
    }

    if (targetList.length === 0) {
        addLog(`[CRITICAL] No targets acquired.`, 'warning');
        setIsScanning(false);
        isScanningRef.current = false;
        setCurrentTask('Idle');
        return;
    }

    setShowLogs(false); 
    
    const scannedRef = { current: 0 };
    const totalPlayers = targetList.length;

    const CONCURRENCY_LIMIT = 5;
    let activePromises = [];

    setCurrentTask(`Executing Concurrency Pool (x${CONCURRENCY_LIMIT})...`);

    try {
        for (const player of targetList) {
            if (!isScanningRef.current) break;
            
            const p = processPlayer(player).finally(() => {
                activePromises = activePromises.filter(prom => prom !== p);
                scannedRef.current++;
                setProgress(Math.floor((scannedRef.current / totalPlayers) * 100));
            });
            
            activePromises.push(p);
            
            if (activePromises.length >= CONCURRENCY_LIMIT) {
                await Promise.race(activePromises);
            }
        }
        
        await Promise.all(activePromises);
    } finally {
        setIsRateLimited(false);
        if (isScanningRef.current) {
          setCurrentTask('Scan Complete');
          setProgress(100);
          addLog('Scan sequence terminated.', 'info');
          setShowLogs(true);
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
    setShowLogs(true);
  };

  const gatewayPercent = Math.max(0, ((600 - gatewayCount) / 600) * 100);
  const officialPercent = Math.max(0, ((190 - officialCount) / 190) * 100);
  const isOfficialEnabled = apiKey && apiKey.trim() !== '';

  const now = Date.now();
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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-300 font-sans flex flex-col">
      
      {/* GLOBAL PROGRESS BAR */}
      <div className="w-full bg-slate-900 h-5 overflow-hidden relative border-b border-slate-800">
        <div 
          className={`h-5 transition-all duration-300 ${isRateLimited ? 'bg-yellow-500/80' : 'bg-blue-600'}`} 
          style={{ width: `${progress}%` }}
        ></div>
        {isRateLimited && (
          <div className="absolute inset-0 flex items-center justify-center">
             <span className="text-[12px] font-bold text-slate-950 tracking-widest drop-shadow-sm">
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
          className="text-xs text-blue-400 hover:text-blue-300 hover:underline font-mono px-3 py-1 bg-blue-900/20 border border-blue-900/50 rounded-full transition-colors"
        >
          Supported by warerastats.io
        </a>
      </header>

      <main className="flex-1 flex overflow-hidden">
        
        {/* LEFT PANEL */}
        <div className="w-1/3 bg-slate-900/50 border-r border-slate-800 flex flex-col p-4 gap-4 overflow-y-auto">
          
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 shrink-0">
            <h2 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2">
              <Settings size={16}/> Target & Parameters
            </h2>
            
            <div className="space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Your WarEra API Key (Scan Speed Boost)</label>
                <input 
                  type="text" 
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Optional API Key"
                  className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-sm text-slate-200 outline-none focus:border-blue-500 font-mono"
                  disabled={isScanning}
                />
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Specific User (Optional)</label>
                <input 
                  type="text" 
                  value={targetUserId}
                  onChange={(e) => setTargetUserId(e.target.value)}
                  placeholder="(Leave empty if scanning a country.)"
                  className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-sm text-slate-200 outline-none focus:border-blue-500 font-mono"
                  disabled={isScanning}
                />
              </div>

              <div>
                <div className="flex justify-between items-end mb-1">
                  <label className="text-xs text-slate-400 block">Target Region</label>
                  <button 
                    onClick={fetchRegions} 
                    disabled={isScanning}
                    className="text-[10px] bg-slate-800 hover:bg-slate-700 px-2 py-0.5 rounded text-slate-300 flex items-center gap-1 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={10} /> Fetch Regions
                  </button>
                </div>
                <select 
                  value={targetRegionId}
                  onChange={(e) => setTargetRegionId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-sm text-slate-200 outline-none focus:border-blue-500 disabled:opacity-50"
                  disabled={isScanning || !!targetUserId || availableRegions.length === 0}
                >
                  {availableRegions.length === 0 && <option value="">Pending Network Ping...</option>}
                  {availableRegions.map(r => (
                    <option key={r._id || r.id} value={r._id || r.id}>
                      {r.name} {r.population ? `(👥 ${r.population})` : ''}
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

          {/* TELEMETRY */}
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
                <div ref={logsEndRef} />
              </div>
            )}
          </div>

        </div>

        {/* RIGHT PANEL */}
        <div className="w-2/3 p-6 bg-slate-950 overflow-y-auto">
          <div className="flex items-center justify-between mb-6 border-b border-slate-800 pb-4">
            <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
              <Database size={20} className="text-slate-400"/> Analysis Results
            </h2>
            
            <div className="flex gap-4 font-mono text-sm">
              
              {/* DYNAMIC LOAD BALANCER UI (Draining Bars) */}
              <div className="bg-slate-900 border border-slate-800 px-3 py-2 rounded flex items-center w-56 text-xs">
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
            <div className="h-full flex flex-col items-center justify-center text-slate-600">
              <Search size={48} className="mb-4 opacity-20" />
              <p>Awaiting scan findings...</p>
              <p className="text-sm mt-2 max-w-md text-center opacity-50">
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
                  {findings[country].map((result, idx) => (
                    <TreeNode 
                      key={idx} 
                      label={result.player.name} 
                      icon={UserX}
                      defaultOpen={false} 
                      badge={`${result.detections} Detections`}
                      badgeClass={getBadgeClass(result.detections)}
                      extraData={`ID: ${result.player.id}`}
                      linkId={result.player.id}
                    >
                      <div className="ml-6 my-2 space-y-2 border-l border-slate-800 pl-4 py-2">
                        <div className="text-xs uppercase font-bold text-slate-500 mb-2">Detected Anomalies</div>
                        {result.suspicions.map((suspicion, sIdx) => (
                          <div key={sIdx} className="bg-slate-900 border border-slate-800 rounded p-2 text-sm">
                            <div className="flex items-center gap-2 font-semibold text-slate-200 mb-1">
                              <AlertTriangle size={14} className={suspicion.severity === 'high' ? 'text-red-500' : 'text-yellow-500'} />
                              {suspicion.type.replace('_', ' ').toUpperCase()}
                            </div>
                            <p className="text-slate-400 text-xs mb-2">{suspicion.desc}</p>
                            
                            <div className="grid grid-cols-2 gap-2 mt-2">
                              {suspicion.workers.map((w, wIdx) => (
                                <a key={wIdx} href={`https://app.warera.io/user/${w.uid}`} target="_blank" rel="noopener noreferrer" className="bg-slate-950 p-2 rounded border border-slate-800 flex flex-col gap-1 hover:border-blue-500 transition-colors group block">
                                  <div className="flex justify-between items-center">
                                    <span className="font-mono text-xs text-blue-300 flex items-center gap-1">
                                      {w.normalizedName}
                                      {w.isActive === false && <span title="Inactive Player" className="bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded text-[9px] ml-1 border border-red-700/50 font-bold tracking-wider">[INACTIVE]</span>}
                                    </span>
                                    <span className="text-[10px] bg-slate-800 px-1 rounded text-slate-400 group-hover:bg-blue-900 group-hover:text-blue-200 transition-colors">
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
                          </div>
                        ))}
                      </div>
                    </TreeNode>
                  ))}
                </TreeNode>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
