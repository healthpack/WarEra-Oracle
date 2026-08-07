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
  const accounts = data?.accounts || [];

  const allTypes = useMemo(() => {
    const s = new Set();
    accounts.forEach(a => a.times.forEach(x => s.add(x.type)));
    return [...s].sort();
  }, [accounts]);

  // Timestamps per account after the type filter, sorted — every metric consumes these.
  const series = useMemo(() => accounts.map(a => ({
    ...a,
    ts: a.times.filter(x => !types || types.has(x.type)).map(x => x.t).sort((p, q) => p - q),
  })), [accounts, types]);

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
      {tab('matrix', 'Pair matrix')}{tab('raster', 'Timeline')}{tab('hours', 'Hour profile')}{tab('days', 'Day calendar')}
      <span style={{ width: 1, height: 18, background: C.line, margin: '0 4px' }} />
      <span style={{ fontSize: 9.5, color: C.tx3 }}>TYPES</span>
      <button onClick={() => setTypes(null)} style={{ padding: '3px 8px', borderRadius: 99, fontSize: 9.5, fontWeight: 600, cursor: 'pointer', background: !types ? 'rgba(63,208,163,0.14)' : C.elev, border: `1px solid ${!types ? 'rgba(63,208,163,0.45)' : C.line}`, color: !types ? C.ok : C.tx3 }}>All</button>
      {allTypes.map(t => {
        const on = types?.has(t);
        return <button key={t} onClick={() => setTypes(prev => { const n = new Set(prev || allTypes); n.has(t) ? n.delete(t) : n.add(t); return n.size === 0 || n.size === allTypes.length ? null : n; })}
          style={{ padding: '3px 8px', borderRadius: 99, fontSize: 9.5, fontWeight: 600, cursor: 'pointer', background: on ? 'rgba(79,195,232,0.14)' : C.elev, border: `1px solid ${on ? C.line2 : C.line}`, color: on ? C.link : C.tx3 }}>{t}</button>;
      })}
    </div>

    <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
      {mode === 'matrix' && <Matrix series={series} cells={cells} metric={metric} setMetric={setMetric} onPick={setPair} pair={pair} />}
      {mode === 'raster' && <Raster series={series} span={span} />}
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
          <thead><tr><th /> {series.map((s, j) => <th key={j} style={{ padding: '3px 5px', color: SERIES[j % SERIES.length], fontWeight: 700, writingMode: 'vertical-rl', transform: 'rotate(180deg)', maxHeight: 96, whiteSpace: 'nowrap' }}>{s.name}</th>)}</tr></thead>
          <tbody>
            {series.map((s, i) => (
              <tr key={i}>
                <td style={{ padding: '3px 8px 3px 0', color: SERIES[i % SERIES.length], fontWeight: 700, whiteSpace: 'nowrap', textAlign: 'right' }}>{s.name}</td>
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
function Raster({ series, span }) {
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
      g.strokeStyle = SERIES[i % SERIES.length]; g.globalAlpha = 0.9; g.lineWidth = 1;
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
        <span style={{ fontSize: 10.5, color: C.tx2 }}>Each tick is one action. Look for rows that interleave without ever overlapping — that is one pair of hands moving between accounts.</span>
        {zoom && <button onClick={() => setZoom(null)} style={{ marginLeft: 'auto', padding: '3px 9px', borderRadius: 6, fontSize: 10, cursor: 'pointer', background: C.elev, border: `1px solid ${C.line}`, color: C.link }}>Reset zoom</button>}
      </div>
      <div style={{ display: 'flex', gap: 9 }}>
        <div style={{ flexShrink: 0, paddingTop: 3 }}>
          {series.map((s, i) => (
            <div key={i} style={{ height: 26, display: 'flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 10, color: SERIES[i % SERIES.length], whiteSpace: 'nowrap', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.banned && <span style={{ color: C.crit, fontWeight: 700 }}>-</span>}{s.name}
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
  const rows = series.map(s => { const h = hourHist(s.ts); const mx = Math.max(1, ...h); return { s, h, mx }; });
  if (!rows.length) return <Empty />;
  return (
    <div>
      <div style={{ fontSize: 10.5, color: C.tx2, marginBottom: 10 }}>Each row is normalised to its own busiest hour, so a small account and a large one can be compared by SHAPE rather than volume. Identical shapes mean a shared daily routine — suggestive, though a shared timezone alone can produce it.</div>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `minmax(96px,auto) repeat(24, 26px)`, gap: 2, alignItems: 'center' }}>
          <div />{Array.from({ length: 24 }, (_, i) => <div key={i} style={{ fontSize: 8.5, color: C.tx3, textAlign: 'center', fontFamily: MONO }}>{String(i).padStart(2, '0')}</div>)}
          {rows.map(({ s, h, mx }, i) => (
            <React.Fragment key={i}>
              <div style={{ fontFamily: MONO, fontSize: 10, color: SERIES[i % SERIES.length], whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 6 }}>{s.name}</div>
              {h.map((v, j) => (
                <div key={j} title={`${s.name} — ${String(j).padStart(2, '0')}:00 UTC · ${v} action(s)`}
                  style={{ height: 22, borderRadius: 3, background: v === 0 ? C.elev : `rgba(79,195,232,${(0.12 + 0.85 * (v / mx)).toFixed(3)})`, border: `1px solid ${C.line}` }} />
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
              <div style={{ fontFamily: MONO, fontSize: 10, color: SERIES[i % SERIES.length], whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 6 }}>{s.name}</div>
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

const Empty = () => <div style={{ padding: 30, textAlign: 'center', color: C.tx3, fontSize: 12 }}>No activity for the selected transaction types.</div>;
