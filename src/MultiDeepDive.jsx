/**
 * MultiDeepDive — compare up to 10 accounts' activity against each other.
 *
 * Pure presentation + maths. The caller fetches the timestamps (gatherTx) and hands them
 * over as `accounts: [{ id, name, banned, inactive, times: [{ t, type }] }]`.
 *
 * Two DIFFERENT hypotheses are measured, because they need opposite evidence and people
 * routinely conflate them:
 *
 *   "these accounts are COORDINATED"  → they act at the same times (shadow, rhythm, days)
 *   "these accounts are ONE OPERATOR" → they must NOT act at the same times. One human
 *                                       cannot drive two accounts simultaneously, so the
 *                                       sessions interleave: low overlap, short handoffs.
 *
 * A farm run by one person scores LOW on simultaneity and HIGH on handoff. Two friends
 * playing together score high on both. Reporting only a correlation would call those two
 * situations the same thing, so the matrix lets you switch metric and see which pattern
 * actually holds.
 */
import React, { useMemo, useRef, useEffect, useState } from 'react';

const C = {
  bg: '#070b18', panel: '#0c1226', elev: '#121b35', elev2: '#1b2748',
  line: '#1f2b4e', line2: '#2e3f6a', tx: '#eaf0ff', tx2: '#9fb0d4', tx3: '#5d6e96',
  link: '#4fc3e8', crit: '#ff5d6c', high: '#ffab3d', med: '#ffd84d', purple: '#a98bff', ok: '#3fd0a3',
};
const MONO = "IBM Plex Mono, monospace";
// Distinct per-account colours; 10 max so the palette never wraps.
const SERIES = ['#4fc3e8', '#ff5d6c', '#3fd0a3', '#ffab3d', '#a98bff', '#ffd84d', '#ff7ab8', '#7ee787', '#f78166', '#79c0ff'];
// Stable colour per transaction type, so an account's activity mix is recognisable by
// silhouette across every view rather than needing the legend re-read each time.
const TYPE_COLOR = {
  itemMarket: '#4fc3e8', wage: '#3fd0a3', donation: '#ff5d6c', articleTip: '#a98bff',
  openCase: '#ffab3d', craftItem: '#ffd84d', dismantleItem: '#ff7ab8', trading: '#79c0ff',
};
const typeColor = (t) => TYPE_COLOR[t] || '#5d6e96';

// Quadrant thresholds — the same ones the pair verdict uses, so the scatter and the text
// can never disagree.
const HANDOFF_HI = 0.5, OVERLAP_LO = 0.05;
// A fitted axis can span a fraction of a percent, where "0%,0%,0%,1%,1%" is useless.
const v1Dec = (range) => range < 0.05;

const SHADOW_MS = 10 * 60000;   // "acting together" window
const HANDOFF_MS = 15 * 60000;  // "one put the other down and picked this up" window
const DAY_MS = 86400000;

// ── metrics ───────────────────────────────────────────────────────────────────────────
const pearson = (x, y) => {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return (dx && dy) ? num / Math.sqrt(dx * dy) : 0;
};

// Fraction of A's actions that have a B action within ±W. Asymmetric by nature, so the
// matrix shows the max of both directions — a small account fully shadowing a large one is
// the interesting case, and averaging would hide it.
const shadowRate = (A, B, W) => {
  if (!A.length || !B.length) return 0;
  let near = 0, j = 0;
  for (const t of A) {
    while (j < B.length && B[j] < t - W) j++;
    if (j < B.length && B[j] <= t + W) near++;
  }
  return near / A.length;
};

// Handoff: merge both streams, look at consecutive actions that CROSS accounts, and ask how
// often the switch happens fast. High = the operator is putting one account down and picking
// the other straight up. This is the single-operator tell.
const handoffStats = (A, B, W) => {
  const merged = [];
  for (const t of A) merged.push({ t, s: 0 });
  for (const t of B) merged.push({ t, s: 1 });
  merged.sort((a, b) => a.t - b.t);
  let crossings = 0, fast = 0, gaps = [];
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].s === merged[i - 1].s) continue;
    crossings++;
    const g = merged[i].t - merged[i - 1].t;
    gaps.push(g);
    if (g <= W) fast++;
  }
  gaps.sort((a, b) => a - b);
  return { crossings, fastRate: crossings ? fast / crossings : 0, medianGapMs: gaps.length ? gaps[gaps.length >> 1] : null };
};

// Simultaneity: share of one-minute bins in which BOTH accounts acted. For a single operator
// this should be near zero even when handoff is high — that contrast is the whole point.
const overlapRate = (A, B) => {
  if (!A.length || !B.length) return 0;
  const binsA = new Set(A.map(t => Math.floor(t / 60000)));
  let both = 0;
  const seen = new Set();
  for (const t of B) { const b = Math.floor(t / 60000); if (binsA.has(b) && !seen.has(b)) { both++; seen.add(b); } }
  return both / Math.min(binsA.size, new Set(B.map(t => Math.floor(t / 60000))).size);
};

// Jaccard over active calendar days — shared days ON and, just as tellingly, shared days OFF.
const dayOverlap = (A, B) => {
  const da = new Set(A.map(t => Math.floor(t / DAY_MS))), db = new Set(B.map(t => Math.floor(t / DAY_MS)));
  if (!da.size || !db.size) return 0;
  let inter = 0;
  for (const d of da) if (db.has(d)) inter++;
  return inter / (da.size + db.size - inter);
};

const hourHist = (times) => { const h = new Array(24).fill(0); for (const t of times) h[new Date(t).getUTCHours()]++; return h; };

const METRICS = {
  shadow:  { label: 'Shadow',   hint: `Share of one account's actions with an action by the other within ${SHADOW_MS / 60000} min. High = they act together — coordination, not necessarily one person.`, fmt: v => (v * 100).toFixed(0) + '%', good: v => v },
  handoff: { label: 'Handoff',  hint: `Of all switches between the two accounts, the share happening within ${HANDOFF_MS / 60000} min. High = one operator putting one down and picking the other up.`, fmt: v => (v * 100).toFixed(0) + '%', good: v => v },
  overlap: { label: 'Same-minute', hint: 'Share of active minutes where BOTH acted. THIS is the metric that separates one operator from two players: on simulated data, one person alternating between two accounts and two friends playing together both score ~100% shadow, ~95% handoff and ~0.99 rhythm — indistinguishable. Same-minute reads 0% for the single operator and 100% for the friends. Near-zero here, with a high handoff, means one pair of hands.', fmt: v => (v * 100).toFixed(0) + '%', good: v => v },
  rhythm:  { label: 'Rhythm r', hint: 'Pearson correlation of the 24h activity profiles. Weak on its own — a shared timezone does this — but it corroborates.', fmt: v => v.toFixed(2), good: v => Math.max(0, v) },
  days:    { label: 'Day overlap', hint: 'Jaccard overlap of active calendar days. Catches accounts that go quiet together, which a shared timezone does not explain.', fmt: v => (v * 100).toFixed(0) + '%', good: v => v },
};

export default function MultiDeepDive({ data, onClose }) {
  const [mode, setMode] = useState('matrix');
  const [metric, setMetric] = useState('handoff');
  const [types, setTypes] = useState(null);        // null = all
  const [pair, setPair] = useState(null);
  const [share, setShare] = useState(true);        // activity mix: 100%-stacked vs absolute
  const [xKey, setXKey] = useState('handoff');     // pair-scatter axes
  const [yKey, setYKey] = useState('overlap');
  const [order, setOrder] = useState([]);          // row order, for lining rows up by eye
  const accounts = data?.accounts || [];
  useEffect(() => { setOrder(accounts.map((_, i) => i)); }, [accounts.length]);
  const moveRow = (from, to) => setOrder(prev => {
    if (to < 0 || to >= prev.length) return prev;
    const n = [...prev]; const [x] = n.splice(from, 1); n.splice(to, 0, x); return n;
  });

  const allTypes = useMemo(() => {
    const s = new Set();
    accounts.forEach(a => a.times.forEach(x => s.add(x.type)));
    return [...s].sort();
  }, [accounts]);

  // Timestamps per account after the type filter, sorted — every metric consumes these.
  // `ci` pins each account to a colour by its ORIGINAL position, so reordering rows in the
  // timeline doesn't reshuffle the palette and invalidate every other view you've just read.
  const series = useMemo(() => {
    const base = accounts.map((a, i) => {
      const evts = a.times.filter(x => !types || types.has(x.type));
      return { ...a, ci: i, evts, ts: evts.map(x => x.t).sort((p, q) => p - q) };
    });
    return order.length === base.length ? order.map(i => base[i]) : base;
  }, [accounts, types, order]);

  const cells = useMemo(() => {
    const n = series.length, out = {};
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const A = series[i].ts, B = series[j].ts;
      if (!A.length || !B.length) { out[`${i}_${j}`] = { shadow: 0, handoff: 0, overlap: 0, rhythm: 0, days: 0, crossings: 0 }; continue; }
      const h = handoffStats(A, B, HANDOFF_MS);
      out[`${i}_${j}`] = {
        // Shadow is asymmetric; show the stronger direction so a small account that
        // shadows a large one isn't averaged away into nothing.
        shadow: Math.max(shadowRate(A, B, SHADOW_MS), shadowRate(B, A, SHADOW_MS)),
        handoff: h.fastRate, crossings: h.crossings, medianGapMs: h.medianGapMs,
        overlap: overlapRate(A, B),
        rhythm: pearson(hourHist(A), hourHist(B)),
        days: dayOverlap(A, B),
      };
    }
    return out;
  }, [series]);

  const span = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    series.forEach(s => s.ts.forEach(t => { if (t < lo) lo = t; if (t > hi) hi = t; }));
    return Number.isFinite(lo) ? { lo, hi } : null;
  }, [series]);

  if (!data) return null;

  const shell = (body) => (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(3,6,15,0.86)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 22 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.line2}`, borderRadius: 12, width: '100%', maxWidth: 1180, maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.7)' }}>
        {body}
      </div>
    </div>
  );

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: `1px solid ${C.line}`, flexShrink: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: C.tx }}>Deep Dive — {accounts.length} accounts</span>
      {span && <span style={{ fontSize: 10.5, color: C.tx3, fontFamily: MONO }}>{new Date(span.lo).toISOString().slice(0, 10)} → {new Date(span.hi).toISOString().slice(0, 10)}</span>}
      {/* Per-account coverage up front: an account contributing nothing to every chart
          should be obvious here rather than inferred from an empty row further down. */}
      <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginLeft: 4 }}>
        {accounts.map((a, i) => {
          const n = a.times.length;
          return <span key={a.id} title={n ? `${a.name}: ${n.toLocaleString('en-US')} actions${a.times.length ? ` (${new Date(a.times[0].t).toISOString().slice(0, 10)} → ${new Date(a.times[a.times.length - 1].t).toISOString().slice(0, 10)})` : ''}` : `${a.name}: no activity in this window`}
            style={{ fontSize: 9, fontFamily: MONO, padding: '1px 5px', borderRadius: 3, border: `1px solid ${n ? C.line2 : 'rgba(255,93,108,0.45)'}`, color: n ? SERIES[(s?.ci ?? i) % SERIES.length] : C.crit, opacity: n ? 1 : 0.75, whiteSpace: 'nowrap' }}>
            {a.banned && '-'}{a.name} {n ? n.toLocaleString('en-US') : '0'}</span>;
        })}
      </span>
      <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: C.tx3, cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>&#215;</button>
    </div>
  );

  if (data.loading) return shell(<>{header}<div style={{ padding: 44, textAlign: 'center', color: C.tx2, fontSize: 12.5 }}>Pulling activity for {accounts.length} account(s)…<div style={{ fontSize: 11, color: C.tx3, marginTop: 7 }}>{data.progress || ''}</div></div></>);
  if (data.error) return shell(<>{header}<div style={{ padding: 34, color: C.crit, fontSize: 12.5 }}>{data.error}</div></>);

  const tab = (k, label) => (
    <button key={k} onClick={() => setMode(k)} style={{ padding: '4px 11px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: mode === k ? 'rgba(79,195,232,0.14)' : C.elev, border: `1px solid ${mode === k ? C.line2 : C.line}`, color: mode === k ? C.link : C.tx3 }}>{label}</button>
  );

  return shell(<>
    {header}
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderBottom: `1px solid ${C.line}`, flexWrap: 'wrap', flexShrink: 0 }}>
      {tab('matrix', 'Pair matrix')}{tab('scatter', 'Pair scatter')}{tab('finger', 'Fingerprint')}{tab('mix', 'Activity mix')}{tab('raster', 'Timeline')}{tab('hours', 'Hour profile')}{tab('days', 'Day calendar')}
      <span style={{ width: 1, height: 18, background: C.line, margin: '0 4px' }} />
      <span style={{ fontSize: 9.5, color: C.tx3 }}>TYPES</span>
      <button onClick={() => setTypes(null)} style={{ padding: '3px 8px', borderRadius: 99, fontSize: 9.5, fontWeight: 600, cursor: 'pointer', background: !types ? 'rgba(63,208,163,0.14)' : C.elev, border: `1px solid ${!types ? 'rgba(63,208,163,0.45)' : C.line}`, color: !types ? C.ok : C.tx3 }}>All</button>
      {allTypes.map(t => {
        const on = types?.has(t);
        return <button key={t} onClick={() => setTypes(prev => { const n = new Set(prev || allTypes); n.has(t) ? n.delete(t) : n.add(t); return n.size === 0 || n.size === allTypes.length ? null : n; })}
          style={{ padding: '3px 8px', borderRadius: 99, fontSize: 9.5, fontWeight: 600, cursor: 'pointer', background: on ? 'rgba(79,195,232,0.14)' : C.elev, border: `1px solid ${on ? C.line2 : C.line}`, color: on ? C.link : C.tx3 }}>{t}</button>;
      })}
    </div>

    {data.note && <div style={{ margin: '10px 16px 0', background: 'rgba(255,171,61,0.10)', border: '1px solid rgba(255,171,61,0.42)', borderRadius: 7, padding: '7px 11px', fontSize: 10.5, color: C.high, lineHeight: 1.5, flexShrink: 0 }}>{data.note}</div>}
    <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
      {mode === 'matrix' && <Matrix series={series} cells={cells} metric={metric} setMetric={setMetric} onPick={setPair} pair={pair} />}
      {mode === 'scatter' && <PairScatter series={series} cells={cells} onPick={setPair} pair={pair} xKey={xKey} yKey={yKey} setXKey={setXKey} setYKey={setYKey} />}
      {mode === 'finger' && <Fingerprint series={series} span={span} />}
      {mode === 'mix' && <Mix series={series} share={share} setShare={setShare} />}
      {mode === 'raster' && <Raster series={series} span={span} moveRow={moveRow} />}
      {mode === 'hours' && <HourHeat series={series} />}
      {mode === 'days' && <DayHeat series={series} span={span} />}
    </div>
  </>);
}

// ── pair matrix ───────────────────────────────────────────────────────────────────────
function Matrix({ series, cells, metric, setMetric, onPick, pair }) {
  const n = series.length;
  const M = METRICS[metric];
  const vals = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) vals.push(M.good(cells[`${i}_${j}`]?.[metric] ?? 0));
  const max = Math.max(0.0001, ...vals);
  const shade = (v) => {
    const x = Math.max(0, Math.min(1, M.good(v) / max));
    return `rgba(255,93,108,${(0.06 + x * 0.82).toFixed(3)})`;
  };
  const p = pair ? cells[`${pair[0]}_${pair[1]}`] : null;
  return (
    <div>
      <div style={{ display: 'flex', gap: 5, marginBottom: 10, flexWrap: 'wrap' }}>
        {Object.entries(METRICS).map(([k, m]) => (
          <button key={k} onClick={() => setMetric(k)} title={m.hint} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 10.5, fontWeight: 600, cursor: 'pointer', background: metric === k ? 'rgba(169,139,255,0.16)' : C.elev, border: `1px solid ${metric === k ? 'rgba(169,139,255,0.5)' : C.line}`, color: metric === k ? C.purple : C.tx3 }}>{m.label}</button>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: C.tx2, marginBottom: 11, lineHeight: 1.5, background: C.elev, border: `1px solid ${C.line}`, borderRadius: 7, padding: '8px 11px' }}>
        {M.hint}
        {metric !== 'overlap' && <div style={{ marginTop: 6, color: C.tx3 }}>A high score here says the pair is <i>related</i>, not <i>how</i>. Switch to <b style={{ color: C.purple }}>Same-minute</b> to tell one operator apart from two people playing together — the other metrics cannot.</div>}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontFamily: MONO, fontSize: 10.5 }}>
          <thead><tr><th /> {series.map((s, j) => <th key={j} style={{ padding: '3px 5px', color: SERIES[(s?.ci ?? j) % SERIES.length], fontWeight: 700, writingMode: 'vertical-rl', transform: 'rotate(180deg)', maxHeight: 96, whiteSpace: 'nowrap' }}>{s.name}</th>)}</tr></thead>
          <tbody>
            {series.map((s, i) => (
              <tr key={i}>
                <td style={{ padding: '3px 8px 3px 0', color: SERIES[(s?.ci ?? i) % SERIES.length], fontWeight: 700, whiteSpace: 'nowrap', textAlign: 'right' }}>{s.name}</td>
                {series.map((_, j) => {
                  if (i === j) return <td key={j} style={{ background: C.elev, border: `1px solid ${C.line}`, width: 46, height: 30 }} />;
                  const c = cells[`${i}_${j}`] || {};
                  const v = c[metric] ?? 0;
                  const sel = pair && pair[0] === i && pair[1] === j;
                  return <td key={j} onClick={() => onPick([i, j])} title={`${s.name} ↔ ${series[j].name}`}
                    style={{ background: shade(v), border: `1px solid ${sel ? C.link : C.line}`, width: 46, height: 30, textAlign: 'center', color: C.tx, cursor: 'pointer' }}>{M.fmt(v)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {p && (
        <div style={{ marginTop: 13, background: C.elev, border: `1px solid ${C.line2}`, borderRadius: 8, padding: '11px 13px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.tx, marginBottom: 7 }}>{series[pair[0]].name} ↔ {series[pair[1]].name}</div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontFamily: MONO, fontSize: 11 }}>
            {Object.entries(METRICS).map(([k, m]) => <span key={k} style={{ color: C.tx2 }}>{m.label}: <b style={{ color: C.tx }}>{m.fmt(p[k] ?? 0)}</b></span>)}
            <span style={{ color: C.tx2 }}>switches: <b style={{ color: C.tx }}>{p.crossings ?? 0}</b></span>
            {p.medianGapMs != null && <span style={{ color: C.tx2 }}>median switch gap: <b style={{ color: C.tx }}>{(p.medianGapMs / 60000).toFixed(1)}m</b></span>}
          </div>
          <div style={{ fontSize: 10.5, color: C.tx3, marginTop: 8, lineHeight: 1.55 }}>{verdict(p)}</div>
        </div>
      )}
    </div>
  );
}

// Plain-language reading of one pair. Deliberately hedged: these are leads, and a shared
// timezone or a genuinely social pair of players can reproduce several of these numbers.
function verdict(p) {
  const bits = [];
  if (p.handoff >= 0.5 && p.overlap <= 0.05 && p.crossings >= 20)
    bits.push('Strong single-operator pattern: they switch fast and almost never act in the same minute — consistent with one person alternating between both.');
  else if (p.overlap >= 0.2 && p.shadow >= 0.5)
    bits.push('They frequently act simultaneously, which points to two people coordinating rather than one operator alternating.');
  if (p.days >= 0.7) bits.push('They are active and idle on the same calendar days.');
  if (p.rhythm >= 0.8) bits.push('Near-identical hour-of-day profile (a shared timezone alone can do this).');
  if (p.crossings < 20) bits.push('Few switches between them — too little data to lean on the handoff figure.');
  return bits.length ? bits.join(' ') : 'No strong pattern in this pair on the current filter.';
}

// ── raster timeline ───────────────────────────────────────────────────────────────────
function Raster({ series, span, moveRow }) {
  const ref = useRef(null);
  const [zoom, setZoom] = useState(null);   // [lo,hi] or null = full span
  const view = zoom || (span ? [span.lo, span.hi] : null);
  useEffect(() => {
    const cv = ref.current; if (!cv || !view) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, rowH = 26, h = series.length * rowH + 22;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + 'px';
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const [lo, hi] = view, sp = Math.max(1, hi - lo);
    series.forEach((s, i) => {
      const y = i * rowH + 11;
      g.fillStyle = '#121b35'; g.fillRect(0, y - 8, w, 17);
      g.strokeStyle = SERIES[(s?.ci ?? i) % SERIES.length]; g.globalAlpha = 0.9; g.lineWidth = 1;
      g.beginPath();
      for (const t of s.ts) {
        if (t < lo || t > hi) continue;
        const x = Math.round(((t - lo) / sp) * (w - 2)) + 1;
        g.moveTo(x, y - 7); g.lineTo(x, y + 8);
      }
      g.stroke(); g.globalAlpha = 1;
    });
    // time axis
    g.fillStyle = '#5d6e96'; g.font = '9px IBM Plex Mono, monospace';
    for (let k = 0; k <= 4; k++) {
      const t = lo + (sp * k) / 4, x = (k / 4) * (w - 2);
      g.fillText(new Date(t).toISOString().slice(5, 16).replace('T', ' '), Math.min(w - 74, Math.max(0, x - 34)), h - 6);
    }
  }, [series, view]);
  if (!view) return <Empty />;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10.5, color: C.tx2 }}>Each tick is one action. Look for rows that interleave without ever overlapping — that is one pair of hands moving between accounts. Use ▲▼ to sit two accounts next to each other; the ordering carries across the other views, and colours stay fixed to each account.</span>
        {zoom && <button onClick={() => setZoom(null)} style={{ marginLeft: 'auto', padding: '3px 9px', borderRadius: 6, fontSize: 10, cursor: 'pointer', background: C.elev, border: `1px solid ${C.line}`, color: C.link }}>Reset zoom</button>}
      </div>
      <div style={{ display: 'flex', gap: 9 }}>
        <div style={{ flexShrink: 0, paddingTop: 3 }}>
          {series.map((s, i) => (
            <div key={i} style={{ height: 26, display: 'flex', alignItems: 'center', gap: 3, fontFamily: MONO, fontSize: 10, color: SERIES[(s?.ci ?? i) % SERIES.length], whiteSpace: 'nowrap', width: 150 }}>
              <button onClick={() => moveRow(i, i - 1)} disabled={i === 0} title="Move up"
                style={{ ...ARROW, opacity: i === 0 ? 0.25 : 1, cursor: i === 0 ? 'default' : 'pointer' }}>▲</button>
              <button onClick={() => moveRow(i, i + 1)} disabled={i === series.length - 1} title="Move down"
                style={{ ...ARROW, opacity: i === series.length - 1 ? 0.25 : 1, cursor: i === series.length - 1 ? 'default' : 'pointer' }}>▼</button>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.banned && <b style={{ color: C.crit }}>-</b>}{s.name}</span>
            </div>
          ))}
        </div>
        <canvas ref={ref} style={{ flex: 1, minWidth: 0, cursor: 'crosshair' }}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const f = (e.clientX - r.left) / r.width, [lo, hi] = view, sp = hi - lo;
            const c = lo + f * sp, nw = sp / 4;   // click to zoom 4x around the cursor
            setZoom([c - nw / 2, c + nw / 2]);
          }} />
      </div>
      <div style={{ fontSize: 10, color: C.tx3, marginTop: 7 }}>Click the chart to zoom 4× around that point.</div>
    </div>
  );
}

// ── hour-of-day heatmap ───────────────────────────────────────────────────────────────
function HourHeat({ series }) {
  const [drill, setDrill] = useState(null);   // hour 0-23, or null
  const rows = series.map(s => { const h = hourHist(s.ts); const mx = Math.max(1, ...h); return { s, h, mx }; });
  if (!rows.length) return <Empty />;

  if (drill != null) {
    // Minute-of-hour profile. A human's minutes are scattered; a scheduled job piles up on
    // the same few minutes every time, which is invisible at hour resolution because the
    // hourly total looks identical either way.
    const mins = series.map(s => {
      const m = new Array(60).fill(0);
      s.ts.forEach(t => { const d = new Date(t); if (d.getUTCHours() === drill) m[d.getUTCMinutes()]++; });
      return { s, m, mx: Math.max(1, ...m), total: m.reduce((a, b) => a + b, 0) };
    });
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10, flexWrap: 'wrap' }}>
          <button onClick={() => setDrill(null)} style={{ ...SEL, cursor: 'pointer', color: C.link }}>← All hours</button>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.tx, fontFamily: MONO }}>{String(drill).padStart(2, '0')}:00–{String(drill).padStart(2, '0')}:59 UTC</span>
          <span style={{ fontSize: 10.5, color: C.tx2, flex: 1, minWidth: 240 }}>Minute by minute. Scattered = a person. Spikes on the same minutes every time = something scheduled — and the hourly total looks the same either way, which is why this only shows up here.</span>
        </div>
        {mins.map(({ s, m, mx, total }, i) => (
          <div key={s.id} style={{ marginBottom: 9 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontFamily: MONO, marginBottom: 3 }}>
              <span style={{ color: SERIES[(s?.ci ?? i) % SERIES.length] }}>{s.name}</span>
              <span style={{ color: C.tx3 }}>{total} action(s) in this hour</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 34, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 5, padding: '3px 4px' }}>
              {m.map((v, mi) => <div key={mi} title={`${String(drill).padStart(2, '0')}:${String(mi).padStart(2, '0')} · ${v}`}
                style={{ flex: 1, height: `${(v / mx) * 100}%`, minHeight: v ? 1 : 0, background: SERIES[(s?.ci ?? i) % SERIES.length], opacity: 0.85, borderRadius: '1px 1px 0 0' }} />)}
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8.5, color: C.tx3, fontFamily: MONO }}><span>:00</span><span>:15</span><span>:30</span><span>:45</span><span>:59</span></div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 10.5, color: C.tx2, marginBottom: 10 }}>Each row is normalised to its own busiest hour, so a small account and a large one can be compared by SHAPE rather than volume. Identical shapes mean a shared daily routine — suggestive, though a shared timezone alone can produce it. <b style={{ color: C.link }}>Click any hour to open it minute by minute.</b></div>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `minmax(96px,auto) repeat(24, 26px)`, gap: 2, alignItems: 'center' }}>
          <div />{Array.from({ length: 24 }, (_, i) => <div key={i} onClick={() => setDrill(i)} title={`Open ${String(i).padStart(2, '0')}:00 minute by minute`} style={{ fontSize: 8.5, color: C.tx3, textAlign: 'center', fontFamily: MONO, cursor: 'pointer' }}>{String(i).padStart(2, '0')}</div>)}
          {rows.map(({ s, h, mx }, i) => (
            <React.Fragment key={i}>
              <div style={{ fontFamily: MONO, fontSize: 10, color: SERIES[(s?.ci ?? i) % SERIES.length], whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 6 }}>{s.name}</div>
              {h.map((v, j) => (
                <div key={j} onClick={() => setDrill(j)} title={`${s.name} — ${String(j).padStart(2, '0')}:00 UTC · ${v} action(s) — click for minute detail`}
                  style={{ height: 22, borderRadius: 3, cursor: 'pointer', background: v === 0 ? C.elev : `rgba(79,195,232,${(0.12 + 0.85 * (v / mx)).toFixed(3)})`, border: `1px solid ${C.line}` }} />
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── day calendar heatmap ──────────────────────────────────────────────────────────────
function DayHeat({ series, span }) {
  if (!span) return <Empty />;
  const d0 = Math.floor(span.lo / DAY_MS), d1 = Math.floor(span.hi / DAY_MS);
  const days = Math.min(120, d1 - d0 + 1);
  const rows = series.map(s => {
    const m = new Map();
    s.ts.forEach(t => { const d = Math.floor(t / DAY_MS) - d0; if (d >= 0 && d < days) m.set(d, (m.get(d) || 0) + 1); });
    return { s, m, mx: Math.max(1, ...m.values()) };
  });
  return (
    <div>
      <div style={{ fontSize: 10.5, color: C.tx2, marginBottom: 10 }}>One column per day. Columns that are dark across every row are shared days OFF — much harder to explain away than shared hours, since a timezone does not make people take the same days off. Shared start and stop dates matter too.</div>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `minmax(96px,auto) repeat(${days}, 11px)`, gap: 1.5, alignItems: 'center' }}>
          {rows.map(({ s, m, mx }, i) => (
            <React.Fragment key={i}>
              <div style={{ fontFamily: MONO, fontSize: 10, color: SERIES[(s?.ci ?? i) % SERIES.length], whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 6 }}>{s.name}</div>
              {Array.from({ length: days }, (_, d) => {
                const v = m.get(d) || 0;
                return <div key={d} title={`${s.name} — ${new Date((d0 + d) * DAY_MS).toISOString().slice(0, 10)} · ${v} action(s)`}
                  style={{ height: 20, borderRadius: 2, background: v === 0 ? '#0a1024' : `rgba(63,208,163,${(0.15 + 0.8 * (v / mx)).toFixed(3)})`, border: `1px solid ${v === 0 ? C.line : 'transparent'}` }} />;
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── pair scatter ──────────────────────────────────────────────────────────────────────
// Handoff (x) against same-minute overlap (y), one point per pair. This is the whole
// argument in one picture: relatedness pushes a pair to the RIGHT, and the vertical
// position then splits it — down-right is one pair of hands alternating, up-right is two
// people playing alongside each other. Metrics read as a table cannot show that clustering.
function PairScatter({ series, cells, onPick, pair, xKey, yKey, setXKey, setYKey }) {
  const W = 620, H = 400, PAD = 52, TOP = 16, RIGHT = 16;
  const MX = METRICS[xKey], MY = METRICS[yKey];
  const pts = [];
  for (let i = 0; i < series.length; i++) for (let j = i + 1; j < series.length; j++) {
    const c = cells[`${i}_${j}`];
    if (!c) continue;
    pts.push({ i, j, x: c[xKey] || 0, y: c[yKey] || 0, crossings: c.crossings || 0 });
  }
  if (!pts.length) return <Empty />;

  // Real pairs bunch up — handoff is rarely below ~50% for accounts in the same cluster, and
  // same-minute overlap is almost always in the low tens. On fixed 0–100% axes that puts
  // every dot in one corner with 70% of the chart empty, which is exactly what made this
  // unreadable. So fit the axes to the data (padded, and always keeping the threshold line
  // and zero in view) and let the spread fill the plot.
  const fit = (vals, floor) => {
    let lo = Math.min(...vals, floor), hi = Math.max(...vals, floor);
    const sp = hi - lo || 0.1;
    return [Math.max(0, lo - sp * 0.15), Math.min(1, hi + sp * 0.15)];
  };
  const [x0, x1] = fit(pts.map(p => p.x), xKey === 'handoff' ? HANDOFF_HI : 0);
  const [y0, y1] = fit(pts.map(p => p.y), 0);
  const isDefaultAxes = xKey === 'handoff' && yKey === 'overlap';
  const px = (v) => PAD + ((v - x0) / (x1 - x0 || 1)) * (W - PAD - RIGHT);
  const py = (v) => H - PAD - ((v - y0) / (y1 - y0 || 1)) * (H - PAD - TOP);
  const ticks = (a, b) => Array.from({ length: 5 }, (_, k) => a + ((b - a) * k) / 4);
  // Colour is now a continuous ramp rather than a hard quadrant flip. Real overlap values
  // sit on a gradient, so a pair at 6% was being painted the same as one at 90% purely
  // because it cleared a 5% line — which read as "two people" when it plainly is not.
  const ramp = (y) => {
    const t = Math.max(0, Math.min(1, y / 0.35));   // 0 = pure alternation, 0.35+ = clearly simultaneous
    const r = Math.round(255), g = Math.round(93 + t * 78), b = Math.round(108 - t * 47);
    return `rgb(${r},${g},${b})`;
  };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 9.5, color: C.tx3 }}>X</span>
        <select value={xKey} onChange={e => setXKey(e.target.value)} style={SEL}>{Object.entries(METRICS).map(([k, m]) => <option key={k} value={k} style={{ background: C.elev }}>{m.label}</option>)}</select>
        <span style={{ fontSize: 9.5, color: C.tx3, marginLeft: 6 }}>Y</span>
        <select value={yKey} onChange={e => setYKey(e.target.value)} style={SEL}>{Object.entries(METRICS).map(([k, m]) => <option key={k} value={k} style={{ background: C.elev }}>{m.label}</option>)}</select>
        {!isDefaultAxes && <button onClick={() => { setXKey('handoff'); setYKey('overlap'); }} style={{ ...SEL, color: C.link, cursor: 'pointer' }}>Reset to handoff × same-minute</button>}
      </div>
      <div style={{ fontSize: 10.5, color: C.tx2, marginBottom: 10, lineHeight: 1.5 }}>
        {isDefaultAxes
          ? <>One dot per pair. Further <b>right</b> = they hand off to each other faster (relatedness). <b>Lower</b> = they almost never act in the same minute, which is one operator alternating; <b>higher</b> = they act together, which is two people. Colour follows height, so <b style={{ color: C.crit }}>red</b> is single-operator-shaped and <b style={{ color: C.high }}>amber</b> is company.</>
          : <>One dot per pair — <b>{MX.label}</b> against <b>{MY.label}</b>. Colour still follows same-minute overlap, so red dots are alternating pairs whatever the axes show. Pairs that sit apart from the crowd on any two metrics are worth opening.</>}
        {' '}Faded dots have under 20 switches — too thin to judge. Axes are fitted to your data, so read the numbers, not the position.
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8 }}>
        {yKey === 'overlap' && y0 <= OVERLAP_LO && OVERLAP_LO <= y1 && <>
          <line x1={PAD} y1={py(OVERLAP_LO)} x2={W - RIGHT} y2={py(OVERLAP_LO)} stroke={C.crit} strokeDasharray="3 3" strokeOpacity="0.55" />
          <text x={W - RIGHT - 4} y={py(OVERLAP_LO) - 5} fill={C.crit} fontSize="8.5" textAnchor="end" fontFamily={MONO} opacity="0.85">below = never simultaneous</text>
        </>}
        {xKey === 'handoff' && x0 <= HANDOFF_HI && HANDOFF_HI <= x1 && <>
          <line x1={px(HANDOFF_HI)} y1={TOP} x2={px(HANDOFF_HI)} y2={H - PAD} stroke={C.line2} strokeDasharray="3 3" />
          <text x={px(HANDOFF_HI) + 4} y={TOP + 10} fill={C.tx3} fontSize="8.5" fontFamily={MONO}>related →</text>
        </>}
        <line x1={PAD} y1={H - PAD} x2={W - RIGHT} y2={H - PAD} stroke={C.line2} />
        <line x1={PAD} y1={TOP} x2={PAD} y2={H - PAD} stroke={C.line2} />
        {ticks(x0, x1).map((v, k) => <text key={k} x={px(v)} y={H - PAD + 15} fill={C.tx3} fontSize="8.5" textAnchor="middle" fontFamily={MONO}>{(v * 100).toFixed(0)}%</text>)}
        {ticks(y0, y1).map((v, k) => <text key={k} x={PAD - 7} y={py(v) + 3} fill={C.tx3} fontSize="8.5" textAnchor="end" fontFamily={MONO}>{(v * 100).toFixed(v1Dec(y1 - y0) ? 1 : 0)}%</text>)}
        <text x={(W + PAD) / 2} y={H - 8} fill={C.tx2} fontSize="10" textAnchor="middle">{MX.label}</text>
        <text x={13} y={H / 2} fill={C.tx2} fontSize="10" textAnchor="middle" transform={`rotate(-90 13 ${H / 2})`}>{MY.label}</text>
        {pts.map((p, k) => {
          const thin = p.crossings < 20;
          const sel = pair && ((pair[0] === p.i && pair[1] === p.j) || (pair[0] === p.j && pair[1] === p.i));
          // Colour always tracks same-minute overlap, not the y axis — so an alternating
          // pair stays red no matter which metrics you put on the axes.
          const c = cells[`${p.i}_${p.j}`];
          return (
            <g key={k} onClick={() => onPick([p.i, p.j])} style={{ cursor: 'pointer' }}>
              <title>{`${series[p.i].name} ↔ ${series[p.j].name}\n${MX.label} ${MX.fmt(p.x)} · ${MY.label} ${MY.fmt(p.y)} · ${p.crossings} switches`}</title>
              <circle cx={px(p.x)} cy={py(p.y)} r={sel ? 8.5 : 6} fill={thin ? C.line2 : ramp(c?.overlap ?? 0)} fillOpacity={thin ? 0.5 : 0.9} stroke={sel ? C.tx : 'rgba(7,11,24,0.8)'} strokeWidth={sel ? 1.8 : 1} />
            </g>
          );
        })}
      </svg>
      {pair && cells[`${pair[0]}_${pair[1]}`] && (
        <div style={{ marginTop: 11, background: C.elev, border: `1px solid ${C.line2}`, borderRadius: 8, padding: '10px 13px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.tx, marginBottom: 5 }}>{series[pair[0]].name} ↔ {series[pair[1]].name}</div>
          <div style={{ fontSize: 10.5, color: C.tx3, lineHeight: 1.55 }}>{verdict(cells[`${pair[0]}_${pair[1]}`])}</div>
          <DivergingHours a={series[pair[0]]} b={series[pair[1]]} />
          <LagProfile a={series[pair[0]]} b={series[pair[1]]} />
        </div>
      )}
    </div>
  );
}

// ── diverging hour bars ───────────────────────────────────────────────────────────────
// Back-to-back hour profiles for one pair. Each side is normalised to its own peak, so the
// question it answers is "do these two occupy the SAME hours" rather than "who is busier" —
// a mirrored shape means a shared daily routine, a complementary one means they take turns.
function DivergingHours({ a, b }) {
  const ha = hourHist(a.ts), hb = hourHist(b.ts);
  const ma = Math.max(1, ...ha), mb = Math.max(1, ...hb);
  return (
    <div style={{ marginTop: 11 }}>
      <div style={{ fontSize: 9.5, color: C.tx3, marginBottom: 5, display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ color: SERIES[0] }}>◀ {a.name}</span><span>hour (UTC)</span><span style={{ color: SERIES[1] }}>{b.name} ▶</span>
      </div>
      {ha.map((_, h) => (
        <div key={h} style={{ display: 'flex', alignItems: 'center', height: 9, gap: 3 }}>
          <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
            <div title={`${a.name} — ${h}:00 · ${ha[h]}`} style={{ width: `${(ha[h] / ma) * 100}%`, height: 7, background: SERIES[0], opacity: ha[h] ? 0.85 : 0, borderRadius: '2px 0 0 2px' }} />
          </div>
          <span style={{ width: 16, textAlign: 'center', fontSize: 7.5, color: C.tx3, fontFamily: MONO, flexShrink: 0 }}>{String(h).padStart(2, '0')}</span>
          <div style={{ flex: 1 }}>
            <div title={`${b.name} — ${h}:00 · ${hb[h]}`} style={{ width: `${(hb[h] / mb) * 100}%`, height: 7, background: SERIES[1], opacity: hb[h] ? 0.85 : 0, borderRadius: '0 2px 2px 0' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── activity mix (stacked bars) ───────────────────────────────────────────────────────
// What each account actually DOES, as a share of its own activity. Accounts built from one
// template have near-identical mixes — a rack of pure-wage bars is a work farm, and that
// pattern is invisible in any of the timing views.
function Mix({ series, share, setShare }) {
  const rows = series.map(s => {
    const by = new Map();
    s.evts.forEach(x => by.set(x.type, (by.get(x.type) || 0) + 1));
    return { s, by, total: s.evts.length };
  });
  const maxTotal = Math.max(1, ...rows.map(r => r.total));
  const allTypes = [...new Set(rows.flatMap(r => [...r.by.keys()]))].sort();
  if (!rows.some(r => r.total)) return <Empty />;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10.5, color: C.tx2, flex: 1, minWidth: 260, lineHeight: 1.5 }}>
          What each account spends its actions on. Bars with the same silhouette were built to the same template — a rack of near-identical mixes is a farm, which none of the timing views can show you.
        </span>
        <button onClick={() => setShare(!share)} style={{ padding: '3px 9px', borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: 'pointer', background: C.elev, border: `1px solid ${C.line}`, color: C.link }}>{share ? 'Show absolute' : 'Show share'}</button>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 11 }}>
        {allTypes.map(t => <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9.5, color: C.tx2, fontFamily: MONO }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: typeColor(t) }} />{t}</span>)}
      </div>
      {rows.map(({ s, by, total }, i) => (
        <div key={i} style={{ marginBottom: 9 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontFamily: MONO, marginBottom: 3 }}>
            <span style={{ color: SERIES[(s?.ci ?? i) % SERIES.length] }}>{s.banned && <b style={{ color: C.crit }}>- </b>}{s.name}</span>
            <span style={{ color: C.tx3 }}>{total.toLocaleString('en-US')} actions</span>
          </div>
          <div style={{ display: 'flex', height: 17, borderRadius: 4, overflow: 'hidden', background: C.elev, border: `1px solid ${C.line}`, width: share ? '100%' : `${Math.max(3, (total / maxTotal) * 100)}%` }}>
            {allTypes.map(t => {
              const v = by.get(t) || 0;
              if (!v) return null;
              return <div key={t} title={`${s.name} — ${t}: ${v} (${((v / total) * 100).toFixed(1)}%)`}
                style={{ width: `${(v / total) * 100}%`, background: typeColor(t) }} />;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── activity fingerprint ──────────────────────────────────────────────────────────────
// Every action as a dot: calendar date across, hour-of-day up. The densest single view of
// "when does this account live". Sleep shows up as a horizontal empty band, a shift as a
// solid one, and a bot as a band that never breaks. Overlaying accounts by colour makes a
// shared routine — same waking hour, same gaps, same day the pattern started — visible in
// one glance, which neither the 1D timeline nor the 24h histogram can do (one loses the
// clock, the other loses the calendar).
function Fingerprint({ series, span }) {
  const ref = useRef(null);
  const [only, setOnly] = useState(null);
  const [zoom, setZoom] = useState(null);
  const view = zoom || (span ? [span.lo, span.hi] : null);
  useEffect(() => {
    const cv = ref.current; if (!cv || !view) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = 380, L = 34, B = 26;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + 'px';
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const [lo, hi] = view, sp = Math.max(1, hi - lo);
    // Day separators, as long as they aren't so dense they turn into a solid block.
    const dayCount = sp / DAY_MS;
    if (dayCount <= 90) {
      g.strokeStyle = '#131c33'; g.lineWidth = 1;
      for (let d = Math.ceil(lo / DAY_MS); d <= Math.floor(hi / DAY_MS); d++) {
        const x = L + ((d * DAY_MS - lo) / sp) * (w - L - 4);
        g.beginPath(); g.moveTo(x, B); g.lineTo(x, h - 14); g.stroke();
      }
    }
    g.strokeStyle = '#1f2b4e'; g.lineWidth = 1;
    for (let hh = 0; hh <= 24; hh += 6) {
      const y = B + (1 - hh / 24) * (h - B - 12);
      g.beginPath(); g.moveTo(L, y); g.lineTo(w, y); g.stroke();
      g.fillStyle = '#5d6e96'; g.font = '9px IBM Plex Mono, monospace';
      g.fillText(String(hh).padStart(2, '0'), 4, y + 3);
    }
    series.forEach((s, i) => {
      if (only != null && only !== i) return;
      g.fillStyle = SERIES[(s?.ci ?? i) % SERIES.length]; g.globalAlpha = only != null ? 0.8 : 0.55;
      for (const t of s.ts) {
        if (t < lo || t > hi) continue;
        // Exact timestamp on x — this used to floor to whole days, which stacked every
        // action of a day onto one vertical line and threw away the within-day position.
        const x = L + ((t - lo) / sp) * (w - L - 4);
        const d = new Date(t);
        const hr = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
        const y = B + (1 - hr / 24) * (h - B - 12);
        g.fillRect(x, y - 1, 2, 2);
      }
      g.globalAlpha = 1;
    });
    g.fillStyle = '#5d6e96'; g.font = '9px IBM Plex Mono, monospace';
    for (let k = 0; k <= 3; k++) {
      const t = lo + (sp * k) / 3;
      const lbl = dayCount <= 4 ? new Date(t).toISOString().slice(5, 16).replace('T', ' ') : new Date(t).toISOString().slice(5, 10);
      g.fillText(lbl, Math.min(w - 70, L + (k / 3) * (w - L - 60)), h - 8);
    }
  }, [series, view, only]);
  if (!span) return <Empty />;
  const dayCount = (view[1] - view[0]) / DAY_MS;
  return (
    <div>
      <div style={{ fontSize: 10.5, color: C.tx2, marginBottom: 9, lineHeight: 1.5 }}>
        One dot per action — time across, hour of day up. Dots sit at their exact timestamp, so zooming in resolves individual actions rather than a daily column. Empty horizontal bands are sleep; accounts sharing a routine share the same band edges and the same gaps, and a band that never breaks is not a person. Click a name to isolate, click the chart to zoom 4×.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, fontSize: 10, color: C.tx3, fontFamily: MONO }}>
        <span>span {dayCount >= 2 ? `${dayCount.toFixed(1)} days` : `${(dayCount * 24).toFixed(1)} h`}</span>
        {zoom && <button onClick={() => setZoom(null)} style={{ ...SEL, cursor: 'pointer', color: C.link }}>Reset zoom</button>}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <button onClick={() => setOnly(null)} style={{ ...SEL, cursor: 'pointer', color: only == null ? C.link : C.tx3 }}>All</button>
        {series.map((s, i) => (
          <button key={s.id} onClick={() => setOnly(only === i ? null : i)}
            style={{ ...SEL, cursor: 'pointer', color: SERIES[(s?.ci ?? i) % SERIES.length], borderColor: only === i ? SERIES[(s?.ci ?? i) % SERIES.length] : C.line }}>{s.name}</button>
        ))}
      </div>
      <canvas ref={ref} style={{ width: '100%', background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, cursor: 'crosshair' }}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const L = 34, f = Math.max(0, (e.clientX - r.left - L) / (r.width - L));
          const [lo, hi] = view, sp = hi - lo, c = lo + f * sp, nw = sp / 4;
          setZoom([c - nw / 2, c + nw / 2]);
        }} />
    </div>
  );
}

// ── lag profile ───────────────────────────────────────────────────────────────────────
// Cross-correlation: for every action by A, how long until the nearest action by B? A
// human pair produces a broad, shapeless hump. A scripted follower produces a SPIKE at a
// consistent offset — "B always acts ~90s after A" — which no summary statistic exposes,
// because the totals are identical whether the lag is consistent or random.
function LagProfile({ a, b }) {
  const BIN = 30000, HALF = 40;   // 30s bins, +/- 20 min
  const bins = new Array(HALF * 2 + 1).fill(0);
  let j = 0;
  for (const t of a.ts) {
    while (j < b.ts.length && b.ts[j] < t - HALF * BIN) j++;
    for (let k = j; k < b.ts.length; k++) {
      const d = b.ts[k] - t;
      if (d > HALF * BIN) break;
      bins[Math.round(d / BIN) + HALF]++;
    }
  }
  const max = Math.max(1, ...bins);
  const total = bins.reduce((s, v) => s + v, 0);
  if (!total) return null;
  // Is the mass concentrated away from zero? That is the scripted-follower shape.
  let peak = 0; bins.forEach((v, i) => { if (v > bins[peak]) peak = i; });
  const peakOffS = ((peak - HALF) * BIN) / 1000;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 10, color: C.tx3, marginBottom: 5 }}>
        Lag profile — how long after {a.name} acts does {b.name} act. A broad hump is two people in the same hours; a narrow spike off zero means one is following the other on a timer.
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 64, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 6, padding: '4px 5px' }}>
        {bins.map((v, i) => (
          <div key={i} title={`${(((i - HALF) * BIN) / 60000).toFixed(1)} min · ${v}`}
            style={{ flex: 1, height: `${(v / max) * 100}%`, minHeight: v ? 1 : 0, background: i === HALF ? C.tx3 : (i === peak ? C.crit : C.link), opacity: i === HALF ? 0.5 : 0.85, borderRadius: '1px 1px 0 0' }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8.5, color: C.tx3, fontFamily: MONO, marginTop: 3 }}>
        <span>−20 min</span><span>0 (simultaneous)</span><span>+20 min</span>
      </div>
      <div style={{ fontSize: 10, color: peak !== HALF ? C.high : C.tx3, marginTop: 5 }}>
        Peak at {peakOffS === 0 ? 'zero — they act in the same moment' : `${peakOffS > 0 ? '+' : ''}${(peakOffS / 60).toFixed(1)} min`}
        {peak !== HALF && Math.abs(peakOffS) >= 30 && ' — a consistent offset like this is what a scripted follower looks like.'}
      </div>
    </div>
  );
}

const SEL = { background: C.elev, border: `1px solid ${C.line}`, color: C.tx2, fontSize: 10, fontWeight: 600, borderRadius: 6, padding: '3px 7px', outline: 'none', fontFamily: 'inherit' };

const Empty = () => <div style={{ padding: 30, textAlign: 'center', color: C.tx3, fontSize: 12 }}>No activity for the selected transaction types.</div>;

const ARROW = { background: 'transparent', border: 'none', color: 'inherit', fontSize: 7, lineHeight: 1, padding: 0, width: 9, flexShrink: 0 };
