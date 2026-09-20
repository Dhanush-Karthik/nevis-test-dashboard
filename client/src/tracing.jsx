import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  LuChevronRight,
  LuCircleAlert,
  LuCopy,
  LuExternalLink,
  LuLoader,
  LuNetwork,
  LuPanelLeftClose,
  LuPanelLeftOpen,
  LuRefreshCw,
  LuSearch,
  LuWaypoints,
  LuX,
  LuChartGantt,
  LuMaximize2,
} from 'react-icons/lu';
import { api } from './api.js';
import { Badge, EmptyState, IconButton, Sash, Segmented, StatusDot, usePanelSize, useLocalState, useToast } from './ui.jsx';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export const fmtDur = (us) => {
  if (us == null) return '–';
  if (us < 1000) return `${Math.round(us)}µs`;
  if (us < 1e6) return `${(us / 1000).toFixed(us < 1e4 ? 2 : 1)}ms`;
  return `${(us / 1e6).toFixed(2)}s`;
};
export const traceLabel = (t) => t?.summary?.rootName || (t?.found === false ? 'Waiting for spans…' : 'Trace');
const shortId = (id) => (id && id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id || '');

// No blue on purpose (dashboard theme): muted, distinguishable hues.
const PALETTE = ['#5fbf82', '#e0af68', '#c78be8', '#ef8f6b', '#7ccfc0', '#d98fb4', '#b5c86a', '#e6c84f', '#9aa0aa'];
const colorFor = (name) => {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

/* ------------------------------------------------------------------ */
/* Trace links in logs                                                  */
/* ------------------------------------------------------------------ */

// value: { known:Set<lowercase ids>, byStep:{stepId: traceId}, open(traceId, spanId) } or null
export const TraceLinkContext = createContext(null);
export const useTraceLinks = () => useContext(TraceLinkContext);

const ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32}\b|\b[0-9a-f]{16}\b/gi;
const norm = (id) => id.replace(/-/g, '').toLowerCase();

// Splits a log line into plain text and clickable trace / span ids.
export function linkifyLine(line, links) {
  if (!links || line.length < 16) return line;
  const found = [];
  ID_RE.lastIndex = 0;
  let m;
  while ((m = ID_RE.exec(line))) found.push({ text: m[0], at: m.index, id: norm(m[0]) });
  if (!found.length) return line;

  // full W3C header (e.g. printed request headers): link its trace id and its span id
  const tp = line.match(/\b00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}\b/i);
  const traceHint = /trace/i.test(line);
  const spanHint = /span/i.test(line);
  const isTrace = (f) => links.known.has(f.id) || (f.id.length === 32 && (traceHint || (tp && f.id === tp[1].toLowerCase())));
  const traceIds = found.filter(isTrace);
  const ctxTrace = traceIds[0]?.id || (tp ? tp[1].toLowerCase() : undefined);
  const parts = [];
  let pos = 0;
  for (const f of found) {
    let kind = null;
    if (isTrace(f)) kind = 'trace';
    else if (f.id.length === 16 && (spanHint || (tp && f.id === tp[2].toLowerCase())) && ctxTrace) kind = 'span';
    if (!kind) continue;
    if (f.at > pos) parts.push(line.slice(pos, f.at));
    const traceId = kind === 'trace' ? f.id : ctxTrace;
    const spanId = kind === 'span' ? f.id : null;
    parts.push(
      <a
        key={f.at}
        href="#trace"
        className={`id-link ${kind}`}
        title={kind === 'trace' ? 'Open this trace' : 'Open this span in its trace'}
        onClick={(e) => {
          e.preventDefault();
          links.open(traceId, spanId);
        }}
      >
        {f.text}
      </a>
    );
    pos = f.at + f.text.length;
  }
  if (!parts.length) return line;
  if (pos < line.length) parts.push(line.slice(pos));
  return parts;
}

/* ------------------------------------------------------------------ */
/* Data hook: trace ids a run has sent + what Tempo knows about them    */
/* ------------------------------------------------------------------ */

export function useRunTraces(runId, status) {
  const [state, setState] = useState({ traces: [], tracingSupported: true, loading: false, error: '', startedAt: null, endedAt: null });
  const attempts = useRef(0);
  const running = status === 'running' || status === 'starting';

  const load = useCallback(async () => {
    if (!runId) return;
    setState((s) => ({ ...s, loading: true }));
    try {
      const r = await fetch(`/api/runs/${runId}/traces`).then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok && !body.traces) throw new Error(body.error || res.statusText);
        return body;
      });
      setState({ traces: r.traces || [], tracingSupported: r.tracingSupported !== false, loading: false, error: r.error || '', startedAt: r.startedAt, endedAt: r.endedAt });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e.message }));
    }
  }, [runId]);

  useEffect(() => {
    attempts.current = 0;
    setState({ traces: [], tracingSupported: true, loading: false, error: '', startedAt: null, endedAt: null });
    if (runId) load();
  }, [runId, load]);

  // While running: refresh as new requests appear. After the run: keep retrying for a
  // while, because Tempo needs a few seconds to ingest what the components just exported.
  const pending = state.traces.some((t) => !t.found);
  useEffect(() => {
    if (!runId) return undefined;
    if (!running && !(pending && attempts.current < 14)) return undefined;
    const t = setTimeout(() => {
      attempts.current += 1;
      load();
    }, running ? 4000 : 5000);
    return () => clearTimeout(t);
  }, [runId, running, pending, state, load]);

  return { ...state, reload: load, running, runId };
}

/* ------------------------------------------------------------------ */
/* Service graph                                                        */
/* ------------------------------------------------------------------ */

const UPSTREAM = '__upstream__';
const NODE_W = 200;
const NODE_H = 68;
const COL_GAP = 130;
const ROW_GAP = 46;
const PAD = 56;

const pathOf = (url) => {
  try { return new URL(url).pathname; } catch (_) { return url; }
};

// Service graph derived only from real parent -> child span links in this trace:
// a component "calls" another when a span of one has a span of the other as its parent.
// Roots whose parent span was never received come from either the pytest client (matched by the
// span id the plugin generated) or an upstream hop that exports no spans (e.g. a gateway).
function buildGraph(spans) {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const nodes = new Map();
  const edges = new Map();
  const node = (key, label) => {
    if (!nodes.has(key)) nodes.set(key, { key, label, spans: 0, durUs: 0, errors: 0, first: Infinity, last: 0 });
    return nodes.get(key);
  };
  const edge = (from, to, label) => {
    const k = `${from}>${to}`;
    if (!edges.has(k)) edges.set(k, { from, to, count: 0, label });
    const e = edges.get(k);
    e.count += 1;
    if (label) {
      if (!e.label) e.label = label;
      else if (e.label !== label && !e.mixed) { e.mixed = true; }
    }
  };
  for (const s of spans) {
    const n = node(s.service, s.service);
    n.spans += 1;
    n.first = Math.min(n.first, s.startUs);
    n.last = Math.max(n.last, s.startUs + s.durUs);
    n.durUs = n.last - n.first; // wall-clock the component was involved (nested spans are not double-counted)
    if (s.error) n.errors += 1;
    const parent = s.parentId ? byId.get(s.parentId) : null;
    if (parent) {
      if (parent.service !== s.service) edge(parent.service, s.service);
    } else {
      node(UPSTREAM, 'Caller (spans not exported)');
      edge(UPSTREAM, s.service);
    }
  }

  // layering: DFS marks back edges, longest path over the remaining DAG
  const out = new Map();
  const hasIn = new Set();
  for (const e of edges.values()) {
    (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e);
    hasIn.add(e.to);
  }
  const keys = [...nodes.keys()];
  const roots = keys.filter((k) => !hasIn.has(k));
  const back = new Set();
  const color = new Map();
  const dfs = (k) => {
    color.set(k, 1);
    for (const e of out.get(k) || []) {
      const c = color.get(e.to);
      if (c === 1) back.add(e);
      else if (!c) dfs(e.to);
    }
    color.set(k, 2);
  };
  (roots.length ? roots : keys.slice(0, 1)).forEach((r) => !color.get(r) && dfs(r));
  keys.forEach((k) => !color.get(k) && dfs(k));
  const layer = new Map(keys.map((k) => [k, 0]));
  for (let pass = 0; pass < keys.length; pass += 1) {
    let changed = false;
    for (const e of edges.values()) {
      if (back.has(e)) continue;
      if (layer.get(e.to) < layer.get(e.from) + 1) { layer.set(e.to, layer.get(e.from) + 1); changed = true; }
    }
    if (!changed) break;
  }
  const cols = [];
  keys.forEach((k) => (cols[layer.get(k)] = cols[layer.get(k)] || []).push(k));
  const pos = new Map();
  cols.forEach((col, ci) => {
    const x = PAD + ci * (NODE_W + COL_GAP);
    const preds = (k) => [...edges.values()].filter((e) => e.to === k && !back.has(e) && pos.has(e.from)).map((e) => pos.get(e.from).y);
    const desired = col.map((k) => {
      const p = preds(k);
      return { k, y: p.length ? p.reduce((a, b) => a + b, 0) / p.length : 0 };
    });
    desired.sort((a, b) => a.y - b.y);
    let cursor = PAD;
    desired.forEach((d) => {
      const y = Math.max(cursor, d.y);
      pos.set(d.k, { x, y });
      cursor = y + NODE_H + ROW_GAP;
    });
  });
  const list = [...edges.values()].map((e) => ({ ...e, label: e.mixed ? 'several requests' : e.label, back: back.has(e) }));
  const width = PAD * 2 + cols.length * (NODE_W + COL_GAP) - COL_GAP;
  const height = Math.max(...[...pos.values()].map((p) => p.y)) + NODE_H + PAD + (list.some((e) => e.back) ? 70 : 0);
  return { nodes: [...nodes.values()], edges: list, pos, width, height };
}

function edgeGeometry(e, pos) {
  const a = pos.get(e.from);
  const b = pos.get(e.to);
  if (e.back) {
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y + NODE_H;
    const x2 = b.x + NODE_W / 2;
    const y2 = b.y + NODE_H;
    const drop = 54 + Math.abs(a.y - b.y) * 0.1;
    return { d: `M${x1},${y1} C${x1},${y1 + drop} ${x2},${y2 + drop} ${x2},${y2}`, mx: (x1 + x2) / 2, my: Math.max(y1, y2) + drop * 0.75 + 16 };
  }
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const dx = Math.max(40, (x2 - x1) / 2);
  // label sits at t=0.68 so edges fanning out of one node don't stack their labels
  const t = 0.68;
  const u = 1 - t;
  const bx = (a, b, c, d) => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  return { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, mx: bx(x1, x1 + dx, x2 - dx, x2), my: bx(y1, y1, y2, y2) };
}

function EdgeLabel({ x, y, lines }) {
  const w = Math.max(...lines.map((l) => l.length)) * 6.1 + 16;
  const h = lines.length * 14 + 6;
  return (
    <g transform={`translate(${x},${y})`} className="graph-label">
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2 > 10 ? 8 : h / 2} />
      {lines.map((l, i) => (
        <text key={i} y={-h / 2 + 14 * (i + 1) - 1} textAnchor="middle" className={i ? 'dim' : ''}>{l}</text>
      ))}
    </g>
  );
}

function ServiceGraph({ trace, onPickService, activeService }) {
  const g = useMemo(() => buildGraph(trace.spans), [trace]);
  const synthetic = (k) => k === UPSTREAM;
  return (
    <div className="graph-scroll">
      <div className="graph-note">
        Built from parent → child span links between components in this trace. Only spans Tempo received are shown; click a component to see its spans.
      </div>
      <div className="graph-canvas" style={{ width: g.width, height: g.height }}>
        <svg width={g.width} height={g.height} className="graph-svg">
          <defs>
            <marker id="tg-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
              <path d="M0,0 L9,4.5 L0,9 Z" className="board-arrowhead" />
            </marker>
          </defs>
          {g.edges.map((e) => {
            const geo = edgeGeometry(e, g.pos);
            const calls = `${e.count} call${e.count === 1 ? '' : 's'}`;
            return (
              <g key={`${e.from}>${e.to}`}>
                <path d={geo.d} className={`board-edge ${e.back ? 'back' : ''}`} style={{ strokeWidth: 1.5 + Math.min(2.5, Math.log2(e.count)) }} markerEnd="url(#tg-arrow)" />
                <EdgeLabel x={geo.mx} y={geo.my} lines={e.label ? [e.label.length > 34 ? `${e.label.slice(0, 33)}…` : e.label, calls] : [calls]} />
              </g>
            );
          })}
        </svg>
        {g.nodes.map((n) => {
          const p = g.pos.get(n.key);
          const syn = synthetic(n.key);
          return (
            <button
              type="button"
              key={n.key}
              className={`gnode ${syn ? 'client' : ''} ${activeService === n.key ? 'active' : ''} ${n.errors ? 'err' : ''}`}
              style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H, '--svc': syn ? '#5b5b63' : colorFor(n.key) }}
              onClick={() => !syn && onPickService(n.key)}
              disabled={syn}
              title={
                n.key === UPSTREAM
                  ? 'The parent of these spans was never exported to Tempo: the pytest client (the suite creates trace ids but exports no spans) and/or a gateway in front of the first instrumented component'
                  : 'Show this component’s spans in the timeline'
              }
            >
              <span className="gnode-bar" />
              <span className="gnode-name">{n.label}</span>
              {!syn && (
                <span className="gnode-meta">
                  {n.spans} span{n.spans === 1 ? '' : 's'} · {fmtDur(n.durUs)}
                  {n.errors > 0 && <em className="text-danger"> · {n.errors} error{n.errors === 1 ? '' : 's'}</em>}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Timeline (waterfall)                                                 */
/* ------------------------------------------------------------------ */

function buildRows(spans, collapsed, service) {
  const ids = new Set(spans.map((s) => s.spanId));
  const kids = new Map();
  const roots = [];
  for (const s of spans) {
    if (s.parentId && ids.has(s.parentId)) (kids.get(s.parentId) || kids.set(s.parentId, []).get(s.parentId)).push(s);
    else roots.push(s);
  }
  const rows = [];
  const walk = (s, depth) => {
    const ch = kids.get(s.spanId) || [];
    rows.push({ span: s, depth, hasKids: ch.length > 0 });
    if (!collapsed.has(s.spanId)) ch.forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  return service ? rows.filter((r) => r.span.service === service) : rows;
}

function SpanDetails({ span, onClose }) {
  const attrs = Object.entries(span.attrs || {});
  return (
    <div className="span-details">
      <div className="card-head">
        <span className="card-title"><strong>{span.name}</strong></span>
        <Badge>{span.service}</Badge>
        {span.error && <Badge tone="danger">error</Badge>}
        <span className="spacer" />
        <IconButton size="sm" icon={<LuX size={15} />} title="Close span details" onClick={onClose} />
      </div>
      <div className="span-details-body">
        <table className="kv-table">
          <tbody>
            <tr><td className="kv-key">span id</td><td className="kv-val">{span.spanId}</td></tr>
            <tr><td className="kv-key">parent span id</td><td className="kv-val">{span.parentId || '—'}</td></tr>
            <tr><td className="kv-key">kind</td><td className="kv-val">{span.kind || '—'}</td></tr>
            <tr><td className="kv-key">duration</td><td className="kv-val">{fmtDur(span.durUs)}</td></tr>
            {span.resource?.host && <tr><td className="kv-key">host</td><td className="kv-val">{span.resource.host}</td></tr>}
            {span.statusMessage && <tr><td className="kv-key">status</td><td className="kv-val text-danger">{span.statusMessage}</td></tr>}
            {attrs.map(([k, v]) => (
              <tr key={k}><td className="kv-key">{k}</td><td className="kv-val">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td></tr>
            ))}
          </tbody>
        </table>
        {span.events?.length > 0 && (
          <div className="span-events">
            <div className="section-caption">Events</div>
            {span.events.map((e, i) => (
              <div key={i} className="span-event">
                <b>{e.name}</b>
                {Object.entries(e.attrs || {}).map(([k, v]) => (
                  <div key={k} className="mono small dim">{k}: {String(v).slice(0, 400)}</div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Timeline({ trace, focusSpanId, service, onClearService }) {
  const [collapsed, setCollapsed] = useState(new Set());
  const [selected, setSelected] = useState(null);
  const scrollRef = useRef(null);
  const t0 = trace.summary.startUs;
  const total = Math.max(1, trace.summary.durUs);
  const rows = useMemo(() => buildRows(trace.spans, collapsed, service), [trace, collapsed, service]);

  // deep link: select the span (or, for a client-side span id, the spans it parents)
  useEffect(() => {
    if (!focusSpanId) return;
    const hit = trace.spans.find((s) => s.spanId === focusSpanId) || trace.spans.find((s) => s.parentId === focusSpanId);
    if (hit) {
      setSelected(hit.spanId);
      setCollapsed(new Set());
      setTimeout(() => scrollRef.current?.querySelector(`[data-span="${hit.spanId}"]`)?.scrollIntoView({ block: 'center' }), 60);
    }
  }, [focusSpanId, trace]);

  const selectedSpan = trace.spans.find((s) => s.spanId === selected);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const toggle = (id) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="timeline">
      {service && (
        <div className="timeline-filter">
          Showing only <b>{service}</b> spans
          <button type="button" className="link-btn" onClick={onClearService}>Show all</button>
        </div>
      )}
      <div className="timeline-head">
        <div className="timeline-name">Span</div>
        <div className="timeline-axis">
          {ticks.map((t) => <span key={t} style={{ left: `${t * 100}%` }}>{fmtDur(total * t)}</span>)}
        </div>
      </div>
      <div className="timeline-body" ref={scrollRef}>
        {rows.map(({ span, depth, hasKids }) => {
          const left = ((span.startUs - t0) / total) * 100;
          const width = Math.max(0.25, (span.durUs / total) * 100);
          return (
            <div
              key={span.spanId}
              data-span={span.spanId}
              className={`trow ${selected === span.spanId ? 'sel' : ''} ${span.error ? 'err' : ''}`}
              onClick={() => setSelected(span.spanId)}
            >
              <div className="trow-name" style={{ paddingLeft: 8 + depth * 14 }}>
                {hasKids ? (
                  <button type="button" className={`trow-chev ${collapsed.has(span.spanId) ? '' : 'open'}`} onClick={(e) => { e.stopPropagation(); toggle(span.spanId); }} aria-label="Toggle children">
                    <LuChevronRight size={13} />
                  </button>
                ) : <span className="trow-chev-space" />}
                <span className="trow-dot" style={{ background: colorFor(span.service) }} />
                <span className="trow-svc">{span.service}</span>
                <span className="trow-label" title={span.name}>{span.name}</span>
              </div>
              <div className="trow-track">
                <div className="trow-bar" style={{ left: `${left}%`, width: `${width}%`, background: span.error ? 'var(--danger)' : colorFor(span.service) }} />
                <span className="trow-dur" style={{ left: `${left + width}%` }}>{fmtDur(span.durUs)}</span>
              </div>
            </div>
          );
        })}
        {!rows.length && <div className="list-hint pad">No spans.</div>}
      </div>
      {selectedSpan && <SpanDetails span={selectedSpan} onClose={() => setSelected(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Trace viewer (one trace)                                             */
/* ------------------------------------------------------------------ */

function TraceViewer({ traceId, focusSpanId, startedAt, endedAt, refreshKey, viewKey = 'trace.view.v2' }) {
  const toast = useToast();
  const [trace, setTrace] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [view, setView] = useLocalState(viewKey, 'timeline');
  const [service, setService] = useState(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.tracing
      .trace(traceId)
      .then((t) => !cancelled && setTrace(t))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [traceId, refreshKey]);

  useEffect(() => setService(null), [traceId]);

  const openGrafana = async () => {
    setOpening(true);
    const w = window.open('', '_blank');
    try {
      const { url } = await api.tracing.grafana({ traceId, from: startedAt, to: endedAt });
      if (w) w.location.href = url;
      else toast('Pop-up blocked — allow pop-ups to open Grafana', 'error');
      toast('Grafana opens on its own tunnel — sign in there if asked', 'info');
    } catch (e) {
      w?.close();
      toast(e.message, 'error');
    } finally {
      setOpening(false);
    }
  };

  const copy = () => navigator.clipboard?.writeText(traceId).then(() => toast('Trace id copied'));

  return (
    <div className="trace-viewer">
      <div className="trace-head">
        <div className="trace-head-id">
          <span className="section-caption">Trace</span>
          <span className="mono">{traceId}</span>
          <IconButton size="xs" icon={<LuCopy size={13} />} title="Copy trace id" onClick={copy} />
        </div>
        {trace?.found && (
          <div className="trace-chips">
            <Badge>{trace.summary.spanCount} spans</Badge>
            <Badge>{fmtDur(trace.summary.durUs)}</Badge>
            {trace.summary.services.map((s) => (
              <span key={s} className="svc-chip"><i style={{ background: colorFor(s) }} />{s}</span>
            ))}
            {trace.summary.errorCount > 0 && <Badge tone="danger">{trace.summary.errorCount} error{trace.summary.errorCount === 1 ? '' : 's'}</Badge>}
          </div>
        )}
        <span className="spacer" />
        <Segmented
          size="sm"
          block={false}
          value={view}
          onChange={setView}
          options={[
            { value: 'graph', label: 'Graph', icon: <LuNetwork size={14} /> },
            { value: 'timeline', label: 'Timeline', icon: <LuChartGantt size={14} /> },
          ]}
        />
        <button type="button" className="btn sm" onClick={openGrafana} disabled={opening} title="Open this trace in Grafana Explore">
          {opening ? <LuLoader size={13} className="spin" /> : <LuExternalLink size={13} />} Open in Grafana
        </button>
      </div>

      <div className="trace-body">
        {loading && !trace ? (
          <EmptyState icon={<LuLoader size={24} className="spin" />} title="Loading trace…" />
        ) : error ? (
          <EmptyState icon={<LuCircleAlert size={24} />} title="Could not load the trace">{error}</EmptyState>
        ) : trace && !trace.found ? (
          <EmptyState icon={<LuWaypoints size={24} />} title="Trace not in Tempo (yet)">
            Components export spans a few seconds after a request, so this is retried automatically. If it never appears, the components did not
            continue the trace context sent with the request (or it was sampled out).
          </EmptyState>
        ) : trace ? (
          view === 'graph' ? (
            <ServiceGraph
              trace={trace}
              activeService={service}
              onPickService={(s) => { setService(s); setView('timeline'); }}
            />
          ) : (
            <Timeline trace={trace} focusSpanId={focusSpanId} service={service} onClearService={() => setService(null)} />
          )
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Traces panel (list + viewer)                                         */
/* ------------------------------------------------------------------ */

export function TracesPanel({ runTraces, focus }) {
  const { traces, tracingSupported, loading, error, reload, startedAt, endedAt, running } = runTraces;
  const [selected, setSelected] = useState(null); // { traceId, spanId }
  const [listOpen, setListOpen] = useLocalState('trace.listOpen', true);
  const [listW, setListW, resetListW] = usePanelSize('trace.list', 300, 220, 560);
  const [manual, setManual] = useState('');
  const [extra, setExtra] = useState([]); // ids opened by hand / from logs that the run didn't report
  const [windowTraces, setWindowTraces] = useState(null);
  const [windowBusy, setWindowBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // deep links from logs / step details
  useEffect(() => {
    if (!focus?.traceId) return;
    setSelected({ traceId: focus.traceId, spanId: focus.spanId || null });
    if (!traces.some((t) => t.traceId === focus.traceId) && !extra.includes(focus.traceId)) setExtra((e) => [...e, focus.traceId]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // default to the first trace once known
  useEffect(() => {
    if (!selected && traces.length) setSelected({ traceId: traces[0].traceId, spanId: null });
  }, [traces, selected]);

  // scenario -> workflow/endpoint step -> traces (one per request chain); the step name is
  // shown once as a header, each trace is labelled by the request it belongs to.
  const groups = useMemo(() => {
    const m = new Map();
    for (const t of traces) {
      const sk = t.testId || '-';
      if (!m.has(sk)) m.set(sk, { title: t.scenarioName || 'Run', steps: new Map() });
      const g = m.get(sk);
      const stk = t.stepId || '-';
      if (!g.steps.has(stk)) g.steps.set(stk, { name: t.stepName || 'Other requests', type: t.stepType, items: [] });
      g.steps.get(stk).items.push(t);
    }
    return [...m.values()].map((g) => ({ title: g.title, steps: [...g.steps.values()] }));
  }, [traces]);

  const tracesById = useMemo(() => Object.fromEntries(traces.map((t) => [t.traceId, t])), [traces]);
  const sel = selected ? tracesById[selected.traceId] : null;

  const searchWindow = async () => {
    setWindowBusy(true);
    try {
      const rid = runTraces.runId;
      const r = await fetch(`/api/runs/${rid}/trace-window`).then((x) => x.json());
      setWindowTraces(r.traces || []);
    } finally {
      setWindowBusy(false);
    }
  };

  const openManual = () => {
    const id = manual.trim().replace(/-/g, '').toLowerCase();
    if (!/^[0-9a-f]{16,32}$/.test(id)) return;
    setExtra((e) => (e.includes(id) || tracesById[id] ? e : [...e, id]));
    setSelected({ traceId: id, spanId: null });
    setManual('');
  };

  return (
    <div className="traces-layout">
      {listOpen && (
        <div className="trace-list panel side" style={{ width: listW }}>
          <div className="panel-head slim">
            <span className="panel-title">Traces <em className="count">{traces.length}</em></span>
            <span className="spacer" />
            <IconButton size="sm" icon={<LuRefreshCw size={14} className={loading ? 'spin' : ''} />} title="Refresh" onClick={() => { reload(); setRefreshKey((k) => k + 1); }} />
            <IconButton size="sm" icon={<LuPanelLeftClose size={15} />} title="Hide trace list" onClick={() => setListOpen(false)} />
          </div>
          <div className="trace-lookup">
            <div className="search-box">
              <LuSearch size={14} className="search-box-icon" />
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && openManual()}
                placeholder="Open a trace by id"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="panel-scroll tight">
            {error && <div className="notice warn small"><LuCircleAlert size={14} /><div>{error}</div></div>}
            {!tracingSupported && (
              <div className="notice warn small">
                <LuCircleAlert size={14} />
                <div>This checkout does not send trace context (<span className="mono">lib/tracing.py</span> is missing). Traces need the changes from branch <span className="mono">SEK-200299-traceparent-headers</span>.</div>
              </div>
            )}
            {groups.map((g, gi) => (
              <div key={gi} className="trace-group">
                <div className="trace-group-title">{g.title}</div>
                {g.steps.map((st, si) => (
                  <div key={si} className="trace-step">
                    <div className="trace-step-name">{st.name}<span>{st.type === 'endpoint' ? 'endpoint' : st.type === 'workflow' ? 'workflow' : ''}</span></div>
                    {st.items.map((t) => (
                      <button
                        type="button"
                        key={t.traceId}
                        className={`trace-item ${selected?.traceId === t.traceId ? 'active' : ''}`}
                        onClick={() => setSelected({ traceId: t.traceId, spanId: null })}
                      >
                        <StatusDot status={t.found ? (t.summary?.errorCount ? 'failed' : 'passed') : running ? 'running' : 'stopped'} />
                        <div className="trace-item-text">
                          <div className="trace-item-name mono">
                            {traceLabel(t)}
                            {t.summary?.roots > 1 && <em> +{t.summary.roots - 1} more request{t.summary.roots === 2 ? '' : 's'}</em>}
                          </div>
                          <div className="trace-item-meta">
                            {t.found ? `${t.summary.spanCount} spans · ${fmtDur(t.summary.durUs)}` : t.error ? 'lookup failed' : 'waiting for Tempo…'}
                            {' · '}<span className="mono">{shortId(t.traceId)}</span>
                          </div>
                          {t.found && (
                            <div className="trace-item-svcs">
                              {t.summary.services.map((sv) => <span key={sv} className="svc-dot" title={sv} style={{ background: colorFor(sv) }} />)}
                            </div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ))}
            {extra.filter((id) => !tracesById[id]).length > 0 && (
              <div className="trace-group">
                <div className="trace-group-title">Opened by id</div>
                {extra.filter((id) => !tracesById[id]).map((id) => (
                  <button type="button" key={id} className={`trace-item ${selected?.traceId === id ? 'active' : ''}`} onClick={() => setSelected({ traceId: id, spanId: null })}>
                    <LuWaypoints size={14} className="muted" />
                    <div className="trace-item-text"><div className="trace-item-sub mono">{shortId(id)}</div></div>
                  </button>
                ))}
              </div>
            )}
            {!traces.length && !error && (
              <div className="list-hint">
                {runTraces.runId ? (running ? 'Trace ids are reported as each test finishes…' : 'This run reported no trace ids.') : 'Start a run to collect its traces.'}
              </div>
            )}
            {runTraces.runId && (
              <div className="trace-window">
                <button type="button" className="btn sm block" onClick={searchWindow} disabled={windowBusy}>
                  {windowBusy ? <LuLoader size={13} className="spin" /> : <LuSearch size={13} />} Cluster traces during this run
                </button>
                <div className="field-hint">Time-based list of everything the cluster traced meanwhile (shared environments include other people’s traffic).</div>
                {windowTraces && (
                  <div className="trace-group">
                    {windowTraces.map((w) => (
                      <button type="button" key={w.traceId} className={`trace-item ${selected?.traceId === w.traceId ? 'active' : ''}`} onClick={() => { setExtra((e) => (e.includes(w.traceId) ? e : [...e, w.traceId])); setSelected({ traceId: w.traceId, spanId: null }); }}>
                        <div className="trace-item-text">
                          <div className="trace-item-name">{w.rootName || '(root not received)'}</div>
                          <div className="trace-item-sub mono">{shortId(w.traceId)}</div>
                          <div className="trace-item-meta">{w.rootService || '—'}{w.durMs != null ? ` · ${w.durMs}ms` : ''}</div>
                        </div>
                      </button>
                    ))}
                    {!windowTraces.length && <div className="list-hint">Nothing traced in that window.</div>}
                  </div>
                )}
              </div>
            )}
          </div>
          <Sash edge="end" size={listW} onSize={setListW} onReset={resetListW} />
        </div>
      )}

      <div className="trace-main">
        {!listOpen && (
          <div className="trace-reopen">
            <IconButton size="sm" icon={<LuPanelLeftOpen size={15} />} title="Show trace list" onClick={() => setListOpen(true)} />
          </div>
        )}
        {selected ? (
          <TraceViewer
            key={selected.traceId}
            traceId={selected.traceId}
            focusSpanId={selected.spanId}
                        startedAt={startedAt}
            endedAt={endedAt}
            refreshKey={refreshKey + (sel?.found ? 1 : 0)}
          />
        ) : (
          <EmptyState icon={<LuNetwork size={26} />} title="No trace selected">
            Every request of a run joins a trace that spans the cluster components. Pick one on the left, or click a trace id in the logs.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Trace sheet: slides in over the current view (logs stay put)         */
/* ------------------------------------------------------------------ */

export function TraceSheet({ runTraces, target, onClose, onExpand }) {
  const [w, setW, resetW] = usePanelSize('trace.sheet', 680, 380, () => Math.max(420, window.innerWidth - 300));
  const tr = runTraces.traces.find((t) => t.traceId === target.traceId);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.querySelector('.popover, .overlay')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside className="trace-sheet" style={{ width: w }} aria-label="Trace">
      <Sash edge="start" size={w} onSize={setW} onReset={resetW} />
      <div className="sheet-head">
        <LuWaypoints size={15} className="muted" />
        <div className="sheet-title">
          <span className="sheet-title-main">{tr ? traceLabel(tr) : 'Trace'}</span>
          {tr?.stepName && <span className="sheet-title-sub">{tr.scenarioName ? `${tr.scenarioName} › ` : ''}{tr.stepName}</span>}
        </div>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={onExpand} title="Open in the Traces tab with the trace list and graph">
          <LuMaximize2 size={13} /> Open in Traces
        </button>
        <IconButton size="sm" icon={<LuX size={15} />} title="Close (Esc)" onClick={onClose} />
      </div>
      <TraceViewer
        key={`${target.traceId}-${target.nonce}`}
        traceId={target.traceId}
        focusSpanId={target.spanId}
                startedAt={runTraces.startedAt}
        endedAt={runTraces.endedAt}
        refreshKey={tr?.found ? 1 : 0}
        viewKey="trace.sheetView"
      />
    </aside>
  );
}
