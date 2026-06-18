/**
 * api/cache.js  —  Palantirish Redis Cache Proxy
 *
 * All WarEra API calls from the frontend are routed through here.
 * Reads from Upstash Redis first (6-hour TTL). On a miss, fetches
 * from the WarEra gateway/official API, caches the result, returns it.
 *
 * Cache key:  palantirish:v1:<endpoint>:<sha256(payload)[:24]>
 *
 * NEVER cached (real-time / auth-sensitive):
 *   transaction.getPaginatedTransactions
 *   search.searchAnything
 */

const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours
const WEALTH_BASELINE_KEY = 'wera:wealth_by_level';
const WEALTH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

const NO_CACHE = new Set([
  'transaction.getPaginatedTransactions',
  'search.searchAnything',
]);

// Endpoints requiring the caller's API key — the warerastats gateway only
// forwards X-API-Key (not the Bearer token these need), so they must go straight
// to the official API.
const isOfficialOnly = (ep) => ep.startsWith('transaction.') || ep.startsWith('worker.');

// ── Upstash REST helpers ──────────────────────────────────────────
const redisGet = async (key) => {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.result ?? null;
};

const redisSet = async (key, value, ttl) => {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`;
  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([value, 'EX', ttl]),
  });
};

// ── Cache key ─────────────────────────────────────────────────────
async function cacheKey(endpoint, payload) {
  const canonical = JSON.stringify({ endpoint, payload });
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `palantirish:v1:${endpoint}:${hex.slice(0, 24)}`;
}

// ── WarEra fetch (gateway first, official fallback) ───────────────
async function fetchWarEra(endpoint, payload, apiKey, forceOfficial = false) {
  const doFetch = async (baseUrl, isGateway) => {
    const url = `${baseUrl}${endpoint}`;
    const headers = { 'Content-Type': 'application/json' };
    // Authenticated endpoints reject X-API-Key alone; also send the key as a
    // Bearer token. Public endpoints ignore it.
    if (apiKey) { headers['X-API-Key'] = apiKey; headers['Authorization'] = `Bearer ${apiKey}`; }

    const res = isGateway
      ? await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })
      : await fetch(`${url}?batch=1&input=${encodeURIComponent(JSON.stringify({ '0': payload }))}`, { headers });

    if (res.status === 429) throw new Error('RATE_LIMIT');
    const text = await res.text();
    if (text.includes('Rate limit exceeded')) throw new Error('RATE_LIMIT');
    if (!res.ok) throw new Error(`HTTP_${res.status}`);

    const data = JSON.parse(text);
    const obj = Array.isArray(data) ? data[0] : data;
    if (obj?.error) throw new Error(obj.error.message || 'API_ERROR');
    return obj?.result?.data?.json ?? obj?.result?.data ?? obj;
  };

  // Skip the gateway entirely for auth-required endpoints — it would just 401.
  if (forceOfficial || isOfficialOnly(endpoint)) {
    return await doFetch('https://api2.warera.io/trpc/', false);
  }

  try {
    return await doFetch('https://gateway.warerastats.io/trpc/', true);
  } catch (e) {
    if (e.message === 'RATE_LIMIT') throw e;
    return await doFetch('https://api2.warera.io/trpc/', false);
  }
}

// ── Handler ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'Redis env vars not configured' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Wealth baseline read/write actions (not API proxy calls)
  if (body.action === 'get_wealth_baseline') {
    try {
      const raw = await redisGet(WEALTH_BASELINE_KEY);
      if (!raw) return res.status(200).json({ data: {} });
      let parsed = JSON.parse(raw);
      // Upstash stores the raw POST body; unwrap [value,'EX',ttl] format
      if (Array.isArray(parsed) && typeof parsed[0] === 'string') parsed = JSON.parse(parsed[0]);
      return res.status(200).json({ data: typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} });
    } catch (e) { return res.status(200).json({ data: {} }); }
  }
  if (body.action === 'set_wealth_baseline') {
    if (!body.data || typeof body.data !== 'object') return res.status(400).json({ error: 'Missing data' });
    try {
      await redisSet(WEALTH_BASELINE_KEY, JSON.stringify(body.data), WEALTH_TTL_SECONDS);
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  const { endpoint, payload = {}, apiKey = '', forceOfficial = false } = body;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });

  // Real-time endpoints — skip cache entirely
  if (NO_CACHE.has(endpoint)) {
    try {
      const data = await fetchWarEra(endpoint, payload, apiKey, forceOfficial);
      return res.status(200).json({ data, cached: false });
    } catch (e) {
      return e.message === 'RATE_LIMIT'
        ? res.status(429).json({ error: 'Rate limit' })
        : res.status(502).json({ error: e.message });
    }
  }

  // Cache-first
  const key = await cacheKey(endpoint, payload);
  try {
    const cached = await redisGet(key);
    if (cached !== null) {
      let parsed;
      try { parsed = JSON.parse(cached); } catch { parsed = cached; }
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json({ data: parsed, cached: true });
    }
  } catch (e) {
    console.warn('[Palantirish] Redis GET error:', e.message);
  }

  // Cache miss — fetch live
  let data;
  try {
    data = await fetchWarEra(endpoint, payload, apiKey, forceOfficial);
  } catch (e) {
    return e.message === 'RATE_LIMIT'
      ? res.status(429).json({ error: 'Rate limit' })
      : res.status(502).json({ error: e.message });
  }

  // Store async (don't block the response)
  redisSet(key, JSON.stringify(data), CACHE_TTL_SECONDS).catch(e =>
    console.warn('[Palantirish] Redis SET error:', e.message)
  );

  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json({ data, cached: false });
}
