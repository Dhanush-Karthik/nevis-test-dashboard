import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  LuArrowLeftRight,
  LuArrowRight,
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
import { describeCall, describeExternal, fmtBytes, httpFacts, statusTone, STATUS_TEXT } from './callDetails.js';
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
// What a trace is called in lists: the workflow / endpoint interaction it belongs to (the root request alone is the same for every
// workflow of a scenario); traces found only in component logs are named after their root request.
export const traceTitle = (t) => (t?.origin === 'logs' ? traceLabel(t) : t?.stepName || traceLabel(t));
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

  // The suite reports its trace ids as tests finish, so when the run ends always look once more:
  // the last poll may have happened before the final ids were logged.
  const wasRunning = useRef(false);
  useEffect(() => {
    wasRunning.current = false;
  }, [runId]);
  useEffect(() => {
    if (running) wasRunning.current = true;
    else if (wasRunning.current && runId) {
      wasRunning.current = false;
      attempts.current = 0;
      load();
    }
  }, [running, runId, load]);

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
function buildGraph(spans, opts = {}) {
  const colGap = opts.colGap ?? COL_GAP;
  const rowGap = opts.rowGap ?? ROW_GAP;
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const nodes = new Map();
  const edges = new Map();
  const node = (key, label) => {
    if (!nodes.has(key)) nodes.set(key, { key, label, spans: 0, durUs: 0, errors: 0, first: Infinity, last: 0 });
    return nodes.get(key);
  };
  const edge = (from, to, label, call) => {
    const k = `${from}>${to}`;
    if (!edges.has(k)) edges.set(k, { from, to, count: 0, label, calls: [] });
    const e = edges.get(k);
    e.count += 1;
    if (call) e.calls.push(call);
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
      if (parent.service !== s.service) edge(parent.service, s.service, undefined, describeCall(s, parent));
    } else {
      node(UPSTREAM, 'Caller (spans not exported)');
      edge(UPSTREAM, s.service, undefined, describeCall(s, null));
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
    const x = PAD + ci * (NODE_W + colGap);
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
      cursor = y + NODE_H + rowGap;
    });
  });
  const list = [...edges.values()].map((e) => {
    const calls = e.calls.sort((a, b) => a.startUs - b.startUs);
    return { ...e, calls, failed: calls.filter((c) => c.failed).length, totalUs: calls.reduce((n, c) => n + c.durUs, 0), label: e.mixed ? 'several requests' : e.label, back: back.has(e) };
  });
  const width = PAD * 2 + cols.length * (NODE_W + colGap) - colGap;
  const height = Math.max(...[...pos.values()].map((p) => p.y)) + NODE_H + PAD + (list.some((e) => e.back) ? 70 : 0);
  return { nodes: [...nodes.values()], edges: list, pos, width, height };
}

function edgeGeometry(e, pos, t = 0.68) {
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
  const u = 1 - t;
  const bx = (a, b, c, d) => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  return { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, mx: bx(x1, x1 + dx, x2 - dx, x2), my: bx(y1, y1, y2, y2) };
}

const SUM_W = 150;
const CALL_W = 262;
const MAX_CARD_CALLS = 4;

const callLine = (c) => `${c.method || ''} ${c.path}`.trim();

// Edge label as a small HTML card (foreignObject) so it can carry real styling.
// `summary`: one pill (count · time · failures). `calls`: the first few calls listed, the rest folded.
function EdgeCard({ edge, x, y, mode, selected, onSelect }) {
  const n = edge.count;
  const listed = mode === 'calls' ? edge.calls.slice(0, MAX_CARD_CALLS) : [];
  const more = mode === 'calls' ? Math.max(0, edge.calls.length - listed.length) : 0;
  const w = mode === 'calls' ? CALL_W : SUM_W;
  const h = mode === 'calls' ? 26 + listed.length * 20 + (more ? 18 : 0) + 6 : 30;
  return (
    <foreignObject x={x - w / 2} y={y - h / 2} width={w} height={h} className="edge-card-wrap">
      <div className={`edge-card ${mode} ${edge.failed ? 'bad' : ''} ${selected ? 'sel' : ''}`} onClick={() => onSelect(edge)} role="button" title="Show every call on this connection">
        <div className="edge-card-head">
          <b>{n}</b> call{n === 1 ? '' : 's'}
          <span className="dim"> · {fmtDur(edge.totalUs)}</span>
          {edge.failed > 0 && <span className="edge-card-fail">{edge.failed} failed</span>}
        </div>
        {listed.map((c, i) => (
          <div key={i} className={`edge-call ${c.failed ? 'bad' : ''}`}>
            {c.method && <span className="m">{c.method}</span>}
            <span className="p" title={callLine(c)}>{c.path}</span>
            {c.status !== null && <span className={`st st-${statusTone(c.status)}`}>{c.status}</span>}
            <span className="d">{fmtDur(c.durUs)}</span>
          </div>
        ))}
        {more > 0 && <div className="edge-more">+{more} more</div>}
      </div>
    </foreignObject>
  );
}

function CallRow({ call, t0, total, open, onToggle, onShowSpan }) {
  const off = call.startUs - t0;
  const left = Math.min(98, (off / total) * 100);
  const width = Math.max(1.5, Math.min(100 - left, (call.durUs / total) * 100));
  const kv = [
    ['Request', call.url || callLine(call)],
    ['Sent by', call.parent ? call.parent.name : 'not exported (caller)'],
    ['Handled by', call.span.name],
    call.peer ? ['Host', call.peer] : null,
    call.statement ? ['Statement', call.statement] : null,
    call.message ? ['Error', call.message] : null,
    ['Span', call.span.spanId],
  ].filter(Boolean);
  return (
    <div className={`call-row ${open ? 'open' : ''} ${call.failed ? 'bad' : ''}`}>
      <button type="button" className="call-row-main" onClick={onToggle} aria-expanded={open}>
        <LuChevronRight size={13} className="call-chev" />
        <span className="call-off">+{fmtDur(off)}</span>
        {call.method ? <span className="call-method">{call.method}</span> : call.tag ? <span className="call-method tag">{call.tag}</span> : <span className="call-method none">·</span>}
        <span className="call-path" title={callLine(call)}>{call.path}</span>
        {call.status !== null ? <span className={`call-status st-${statusTone(call.status)}`}>{call.status}</span> : call.failed ? <span className="call-status st-bad">error</span> : <span className="call-status none" />}
        <span className="call-dur">
          <span className="call-bar"><i style={{ left: `${left}%`, width: `${width}%` }} /></span>
          <em>{fmtDur(call.durUs)}</em>
        </span>
      </button>
      {open && (
        <div className="call-detail">
          <dl>
            {kv.map(([k, v]) => (
              <React.Fragment key={k}>
                <dt>{k}</dt>
                <dd className={k === 'Error' ? 'text-danger' : ''}>{v}</dd>
              </React.Fragment>
            ))}
          </dl>
          <button type="button" className="btn sm" onClick={() => onShowSpan(call.span.spanId)}><LuChartGantt size={13} /> Show in timeline</button>
        </div>
      )}
    </div>
  );
}

function CallsPanel({ edge, nodes, trace, onClose, onShowSpan }) {
  const [openIdx, setOpenIdx] = useState(null);
  useEffect(() => setOpenIdx(null), [edge.from, edge.to]);
  const label = (k) => (k === UPSTREAM ? 'Caller' : k);
  const dot = (k) => (k === UPSTREAM ? '#5b5b63' : colorFor(k));
  const t0 = trace.summary.startUs;
  const total = Math.max(1, trace.summary.durUs);
  return (
    <div className="calls-panel">
      <div className="calls-head">
        <span className="calls-route">
          <i style={{ background: dot(edge.from) }} />{label(edge.from)}
          <LuArrowRight size={13} className="muted" />
          <i style={{ background: dot(edge.to) }} />{label(edge.to)}
        </span>
        <span className="calls-stats">
          {edge.count} call{edge.count === 1 ? '' : 's'} · {fmtDur(edge.totalUs)} total
          {edge.failed > 0 && <em className="text-danger"> · {edge.failed} failed</em>}
        </span>
        <span className="spacer" />
        <IconButton size="sm" icon={<LuX size={15} />} title="Close" onClick={onClose} />
      </div>
      <div className="calls-list">
        {edge.calls.map((c, i) => (
          <CallRow key={c.span.spanId} call={c} t0={t0} total={total} open={openIdx === i} onToggle={() => setOpenIdx(openIdx === i ? null : i)} onShowSpan={onShowSpan} />
        ))}
      </div>
    </div>
  );
}

function ServiceGraph({ trace, onPickService, activeService, onShowSpan }) {
  const panRef = useDragScroll();
  const [mode, setMode] = useLocalState('trace.graph.mode', 'summary');
  const view = mode === 'calls' ? 'calls' : 'summary';
  const g = useMemo(() => buildGraph(trace.spans, view === 'calls' ? { colGap: CALL_W + 70, rowGap: 96 } : { colGap: SUM_W + 60, rowGap: 56 }), [trace, view]);
  const keyOf = (e) => `${e.from}>${e.to}`;
  // start on the connection with failures, if there is one
  const [selKey, setSelKey] = useState(null);
  useEffect(() => {
    const bad = g.edges.find((e) => e.failed);
    setSelKey(bad ? keyOf(bad) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace]);
  const selected = g.edges.find((e) => keyOf(e) === selKey) || null;
  const synthetic = (k) => k === UPSTREAM;
  const pick = (e) => setSelKey((k) => (k === keyOf(e) ? null : keyOf(e)));
  return (
    <div className="graph-wrap">
      <div className="graph-note">
        <span>Click a connection to list every call on it. Click a component to see its spans.</span>
        <span className="spacer" />
        <Segmented
          size="sm"
          block={false}
          value={view}
          onChange={setMode}
          options={[{ value: 'summary', label: 'Summary' }, { value: 'calls', label: 'Calls on graph' }]}
        />
      </div>
      <div className="graph-scroll" ref={panRef}>
        <div className="graph-canvas" style={{ width: g.width, height: g.height }}>
          <svg width={g.width} height={g.height} className="graph-svg">
            <defs>
              <marker id="tg-arrow" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
                <path d="M0,0 L10,5 L0,10 Z" className="board-arrowhead" />
              </marker>
            </defs>
            {g.edges.map((e) => {
              const geo = edgeGeometry(e, g.pos, 0.5);
              return (
                <g key={keyOf(e)} className={`graph-edge ${keyOf(e) === selKey ? 'sel' : ''} ${e.failed ? 'bad' : ''}`}>
                  <path d={geo.d} className="edge-hit" onClick={() => pick(e)} />
                  <path d={geo.d} className={`board-edge ${e.back ? 'back' : ''}`} style={{ strokeWidth: 1.5 + Math.min(2.5, Math.log2(e.count)) }} markerEnd="url(#tg-arrow)" />
                  <EdgeCard edge={e} x={geo.mx} y={geo.my} mode={view} selected={keyOf(e) === selKey} onSelect={pick} />
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
      {selected && <CallsPanel edge={selected} nodes={g.nodes} trace={trace} onClose={() => setSelKey(null)} onShowSpan={onShowSpan} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Grab-and-drag panning for scrollable diagrams (the hand tool): drag anywhere on the canvas to move it. */
function useDragScroll() {
  const [el, setEl] = useState(null);
  useEffect(() => {
    if (!el) return undefined;
    let down = null;
    let moved = false;
    const onDown = (e) => {
      if (e.button !== 0 || e.target.closest('button, a, input, select, textarea, .no-pan')) return;
      down = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
      moved = false;
    };
    const onMove = (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      el.classList.add('panning');
      el.scrollLeft = down.l - dx;
      el.scrollTop = down.t - dy;
      e.preventDefault();
    };
    const onUp = () => { down = null; el.classList.remove('panning'); };
    const onClick = (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }; // a drag is not a click
    el.addEventListener('mousedown', onDown);
    el.addEventListener('click', onClick, true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      el.removeEventListener('mousedown', onDown);
      el.removeEventListener('click', onClick, true);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [el]);
  return setEl;
}

/* Sequence diagram                                                     */
/* ------------------------------------------------------------------ */

const SEQ = { gutter: 92, col: 240, row: 52, top: 20, head: 74, box: { w: 184, h: 60 } };
const SEQ_TONE = { ok: '#5fbf82', warn: '#e0af68', bad: '#ef6b6b', none: '#9a9aa4' };
const tone = (c) => (c.failed ? 'bad' : c.status !== null && c.status >= 300 ? 'warn' : c.status !== null ? 'ok' : 'none');
const clip = (t, px, per = 6.2) => {
  const n = Math.max(4, Math.floor(px / per));
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const isExt = (k) => String(k).startsWith('ext:');

// Every hop becomes a request + response pair in time order: calls between components, calls out to things that export
// no spans (databases, brokers, other services: "external"), and optionally a component's own internal steps.
function buildSequence(spans, opts) {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const kids = new Map();
  for (const s of spans) if (s.parentId && byId.has(s.parentId)) (kids.get(s.parentId) || kids.set(s.parentId, []).get(s.parentId)).push(s);
  const all = [];
  const internal = [];
  for (const s of spans) {
    const parent = s.parentId ? byId.get(s.parentId) : null;
    const children = kids.get(s.spanId) || [];
    const selfUs = Math.max(0, s.durUs - children.reduce((n, k) => n + k.durUs, 0));
    if (!parent || parent.service !== s.service) {
      all.push({ from: parent ? parent.service : UPSTREAM, to: s.service, call: describeCall(s, parent), facts: httpFacts(s, parent), span: s, parent, selfUs, start: s.startUs, end: s.startUs + s.durUs, external: false });
    } else if (s.kind === 'client' && children.length === 0) {
      const ex = describeExternal(s);
      all.push({ from: s.service, to: ex.participant, extLabel: ex.label, extKind: ex.kind, call: ex.call, facts: httpFacts(s, null), span: s, parent, selfUs: s.durUs, start: s.startUs, end: s.startUs + s.durUs, external: true });
    } else if (!(s.kind === 'client' && children.some((k) => k.service !== s.service))) {
      internal.push({ service: s.service, span: s, start: s.startUs, end: s.startUs + s.durUs });
    }
  }
  const calls = all.filter((c) => (c.external ? opts.external : true)).sort((a, b) => a.start - b.start);
  // internal steps: skip the trivial ones, keep the slow and the failed, cap the noise
  const steps = opts.internal ? internal.filter((i) => i.span.error || i.span.durUs >= 500).sort((a, b) => a.start - b.start).slice(0, 60) : [];
  const parts = [];
  for (const c of calls) for (const k of [c.from, c.to]) if (!parts.includes(k)) parts.push(k);
  for (const st of steps) if (!parts.includes(st.service)) parts.push(st.service);
  const events = [];
  calls.forEach((c, i) => {
    c.n = i + 1;
    events.push({ t: c.start, kind: 'req', c, order: 0 });
    events.push({ t: Math.max(c.end, c.start), kind: 'res', c, order: 1 });
  });
  steps.forEach((st, i) => events.push({ t: st.start, kind: 'self', st, order: 0.5, n: i }));
  events.sort((a, b) => a.t - b.t || a.order - b.order || (a.c ? a.c.n : a.n) - (b.c ? b.c.n : b.n));
  events.forEach((e, r) => { e.row = r; });
  const level = new Map();
  for (const p of parts) {
    const open = [];
    for (const c of calls.filter((x) => x.to === p)) {
      const reqRow = events.find((e) => e.c === c && e.kind === 'req').row;
      const resRow = events.find((e) => e.c === c && e.kind === 'res').row;
      for (let i = open.length - 1; i >= 0; i -= 1) if (open[i].resRow < reqRow) open.splice(i, 1);
      level.set(c, open.length);
      c.reqRow = reqRow;
      c.resRow = resRow;
      open.push(c);
    }
  }
  return { parts, calls, steps, events, level, counts: { internal: internal.filter((i) => i.span.error || i.span.durUs >= 500).length, external: all.filter((c) => c.external).length } };
}

const attrLine = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));

function SeqDetail({ c, label, onShowSpan, traceId }) {
  const [allAttrs, setAllAttrs] = useState(false);
  useEffect(() => setAllAttrs(false), [c.n]);
  const { call, facts, span, parent } = c;
  const exception = (span.events || []).find((e) => e.name === 'exception');
  const rows = [];
  const row = (k, v, cls) => v !== null && v !== undefined && v !== '' && rows.push([k, v, cls]);
  row('Request', `${call.method || ''} ${call.url || call.path}`.trim());
  row('Query', facts.query);
  row('Host', facts.hostPort || call.peer);
  row('Request body', [facts.reqType, facts.reqSize != null ? fmtBytes(facts.reqSize) : null].filter(Boolean).join(' · '));
  row('Client', facts.userAgent);
  row('Response', call.status !== null ? `${call.status} ${STATUS_TEXT[call.status] || ''}`.trim() : call.failed ? 'error' : null, call.failed ? 'text-danger' : '');
  row('Response body', [facts.resType, facts.resSize != null ? fmtBytes(facts.resSize) : null].filter(Boolean).join(' · '));
  row('Error', call.message, 'text-danger');
  row('Exception', exception ? `${exception.attrs['exception.type'] || ''} ${exception.attrs['exception.message'] || ''}`.trim() : null, 'text-danger');
  const timing = [
    ['Started', `+${fmtDur(span.startUs - c.t0)}`],
    ['Duration', fmtDur(call.durUs)],
    c.external ? null : ['In this component', `${fmtDur(c.selfUs)} own work · ${fmtDur(Math.max(0, call.durUs - c.selfUs))} waiting on what it called`],
    facts.inFlightUs != null ? ['In flight to receiver', fmtDur(facts.inFlightUs)] : null,
    facts.backUs != null ? ['Back to sender', fmtDur(facts.backUs)] : null,
  ].filter(Boolean);
  const ids = [
    ['Trace', traceId], ['Handled by span', `${span.spanId} · ${span.name}`], parent ? ['Sent by span', `${parent.spanId} · ${parent.name}`] : null,
    span.resource?.host ? ['Host', span.resource.host] : null, span.resource?.version ? ['Version', span.resource.version] : null, span.resource?.instance ? ['Instance', span.resource.instance] : null,
  ].filter(Boolean);
  const attrs = [...Object.entries(span.attrs || {}).map(([k, v]) => [k, v, 'handler']), ...Object.entries((parent && parent.attrs) || {}).map(([k, v]) => [k, v, 'sender'])];
  const shownAttrs = allAttrs ? attrs : attrs.slice(0, 10);
  return (
    <div className="seq-detail">
      <div className="seq-detail-top">
        <span className={`seq-badge tone-${tone(call)}`}>{c.n}</span>
        <div className="seq-detail-title">
          <b>{label(c.from)}</b> <LuArrowRight size={12} className="muted" /> <b>{c.external ? c.extLabel : label(c.to)}</b>
          <span className="mono">{call.method} {call.path}</span>
          {call.status !== null && <span className={`call-status st-${statusTone(call.status)}`}>{call.status}</span>}
          <span className="muted">{fmtDur(call.durUs)}</span>
        </div>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={() => onShowSpan(span.spanId)}><LuChartGantt size={13} /> Show in timeline</button>
      </div>
      <div className="seq-detail-body">
        <section>
          <h4>Message</h4>
          <dl>{rows.map(([k, v, cls]) => <React.Fragment key={k}><dt>{k}</dt><dd className={cls}>{v}</dd></React.Fragment>)}</dl>
          {exception?.attrs['exception.stacktrace'] && <pre className="seq-stack">{String(exception.attrs['exception.stacktrace']).slice(0, 700)}</pre>}
        </section>
        <section>
          <h4>Timing</h4>
          <dl>{timing.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
          <h4>Identity</h4>
          <dl>{ids.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
        </section>
        <section>
          <h4>Attributes <em>{attrs.length}</em></h4>
          <dl>{shownAttrs.map(([k, v, from], i) => <React.Fragment key={`${k}${i}`}><dt title={`from the ${from} span`}>{k}</dt><dd>{clip(attrLine(v), 340, 6.4)}</dd></React.Fragment>)}</dl>
          {attrs.length > 10 && <button type="button" className="link-btn" onClick={() => setAllAttrs((x) => !x)}>{allAttrs ? 'Show fewer' : `Show all ${attrs.length}`}</button>}
        </section>
      </div>
    </div>
  );
}

function SequenceDiagram({ trace, onShowSpan }) {
  const [internalOn, setInternalOn] = useLocalState('trace.seq.internal', false);
  const [externalOn, setExternalOn] = useLocalState('trace.seq.external', true);
  const panRef = useDragScroll();
  const seq = useMemo(() => buildSequence(trace.spans, { internal: internalOn, external: externalOn }), [trace, internalOn, externalOn]);
  const [sel, setSel] = useState(null);
  useEffect(() => setSel(null), [trace]);
  const t0 = trace.summary.startUs;
  const { parts, calls, steps, events, level, counts } = seq;
  const stats = useMemo(() => {
    const m = new Map();
    for (const s of trace.spans) {
      const e = m.get(s.service) || { spans: 0, errors: 0, host: null, version: null };
      e.spans += 1;
      if (s.error) e.errors += 1;
      e.host = e.host || s.resource?.host || null;
      e.version = e.version || s.resource?.version || null;
      m.set(s.service, e);
    }
    return m;
  }, [trace]);
  if (!calls.length && !steps.length) return <EmptyState icon={<LuNetwork size={24} />} title="No calls between components">This trace has spans from a single component only.</EmptyState>;
  calls.forEach((c) => { c.t0 = t0; });

  const cx = (k) => SEQ.gutter + parts.indexOf(k) * SEQ.col + SEQ.col / 2;
  const ry = (r) => SEQ.top + r * SEQ.row + SEQ.row / 2;
  const width = SEQ.gutter + parts.length * SEQ.col;
  const height = SEQ.top * 2 + events.length * SEQ.row;
  const label = (k) => (k === UPSTREAM ? 'Caller' : isExt(k) ? calls.find((c) => c.to === k)?.extLabel || k.slice(4) : k);
  const color = (k) => (k === UPSTREAM ? '#5b5b63' : isExt(k) ? '#7a7a84' : colorFor(k));
  const failed = calls.filter((c) => c.call.failed).length;
  const slowest = calls.reduce((m, c) => (!m || c.call.durUs > m.call.durUs ? c : m), null);
  const selected = calls.find((c) => c.n === sel) || null;

  return (
    <div className="seq-wrap">
      <div className="graph-note seq-note-bar">
        <span className="seq-sum"><b>{calls.length}</b> request{calls.length === 1 ? '' : 's'}</span>
        <span className="seq-sum"><b>{parts.length}</b> participants</span>
        <span className="seq-sum"><b>{fmtDur(trace.summary.durUs)}</b> end to end</span>
        {failed > 0 && <span className="seq-sum bad"><b>{failed}</b> failed</span>}
        {slowest && <button type="button" className="seq-sum link" onClick={() => setSel(slowest.n)} title="Select the slowest call">slowest: <b>{clip(`${slowest.call.method || ''} ${slowest.call.path}`.trim(), 160)}</b> {fmtDur(slowest.call.durUs)}</button>}
        <span className="spacer" />
        <button type="button" className={`gs-chip ${externalOn ? 'on' : ''}`} onClick={() => setExternalOn(!externalOn)} disabled={!counts.external} title="Calls to things that exported no spans: databases, brokers, other services">External calls <em>{counts.external}</em></button>
        <button type="button" className={`gs-chip ${internalOn ? 'on' : ''}`} onClick={() => setInternalOn(!internalOn)} disabled={!counts.internal} title="A component's own slow or failed steps (over 0.5 ms)">Internal steps <em>{counts.internal}</em></button>
        <span className="seq-legend"><i style={{ background: SEQ_TONE.ok }} />ok <i style={{ background: SEQ_TONE.warn }} />redirect <i style={{ background: SEQ_TONE.bad }} />failed <i style={{ background: SEQ_TONE.none }} />no status</span>
      </div>
      <div className="seq-scroll" ref={panRef} title="Drag to pan">
        <div className="seq-inner" style={{ width, minWidth: '100%' }}>
          <div className="seq-head" style={{ width, height: SEQ.head }}>
            {parts.map((k) => {
              const st = stats.get(k);
              return (
                <div key={k} className={`seq-part ${k === UPSTREAM ? 'client' : ''} ${isExt(k) ? 'ext' : ''} ${st?.errors ? 'err' : ''}`} style={{ left: cx(k) - SEQ.box.w / 2, width: SEQ.box.w, height: SEQ.box.h, '--svc': color(k) }} title={k === UPSTREAM ? 'The caller: its spans were never exported to Tempo (the pytest client or a gateway in front of the first component)' : isExt(k) ? 'Called by a component but exports no spans (database, broker or another service)' : k}>
                  <span className="seq-part-bar" />
                  <span className="seq-part-name">{label(k)}</span>
                  <span className="seq-part-sub">
                    {k === UPSTREAM ? 'not exported' : isExt(k) ? calls.find((c) => c.to === k)?.extKind : [st?.version && `v${st.version}`, st?.host].filter(Boolean).join(' · ') || 'component'}
                  </span>
                  {st && <span className="seq-part-sub">{st.spans} span{st.spans === 1 ? '' : 's'}{st.errors ? <em className="text-danger"> · {st.errors} error{st.errors === 1 ? '' : 's'}</em> : ''}</span>}
                </div>
              );
            })}
          </div>
          <svg width={width} height={height} className="seq-svg">
            <defs>
              {Object.entries(SEQ_TONE).map(([k, c]) => (
                <marker key={k} id={`seq-${k}`} markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
                  <path d="M0,0 L10,5 L0,10 Z" fill={c} />
                </marker>
              ))}
            </defs>
            {parts.map((k) => <line key={k} x1={cx(k)} x2={cx(k)} y1={0} y2={height} className="seq-life" stroke={color(k)} />)}
            {calls.map((c) => {
              const lv = level.get(c) || 0;
              const y1 = ry(c.reqRow) + 8;
              const y2 = ry(c.resRow) + 8;
              return <rect key={`a${c.n}`} x={cx(c.to) - 5 + lv * 6} y={y1 - 3} width={10} height={Math.max(8, y2 - y1 + 6)} rx={3} className={`seq-act ${tone(c.call) === 'bad' ? 'bad' : ''}`} style={{ '--svc': color(c.to) }} />;
            })}
            {events.filter((e) => e.kind !== 'self').map((e) => {
              const c = e.c;
              const tn = tone(c.call);
              const y = ry(e.row) + 8;
              const isReq = e.kind === 'req';
              const lvTo = level.get(c) || 0;
              const dirReq = cx(c.to) >= cx(c.from) ? 1 : -1;
              const edgeTo = cx(c.to) + lvTo * 6 + (dirReq > 0 ? -5 : 5);
              const srcX = cx(c.from) + dirReq * 5;
              const x1 = isReq ? srcX : edgeTo;
              const x2 = isReq ? edgeTo : srcX;
              const dir = x2 >= x1 ? 1 : -1;
              const len = Math.abs(x2 - x1);
              const f = c.facts;
              const l1 = isReq
                ? `${c.call.method ? `${c.call.method} ` : ''}${c.call.path}`
                : `${c.call.status !== null ? `${c.call.status} ${STATUS_TEXT[c.call.status] || ''}`.trim() : c.call.failed ? 'error' : 'done'} · ${fmtDur(c.call.durUs)}`;
              const l2 = (isReq
                ? [f.hostPort || c.call.peer, f.queryKeys.length ? `?${f.queryKeys.slice(0, 3).join('&')}${f.queryKeys.length > 3 ? '…' : ''}` : null, f.reqType && String(f.reqType).split(';')[0], f.reqSize != null ? fmtBytes(f.reqSize) : null, f.inFlightUs != null && f.inFlightUs > 0 ? `${fmtDur(f.inFlightUs)} in flight` : null]
                : [f.resType && String(f.resType).split(';')[0], f.resSize != null ? fmtBytes(f.resSize) : null, c.external ? null : `${fmtDur(c.selfUs)} own work`, f.backUs != null && f.backUs > 0 ? `${fmtDur(f.backUs)} back` : null]
              ).filter(Boolean).join(' · ');
              const mid = (x1 + x2) / 2;
              const active = sel === c.n;
              return (
                <g key={`${e.kind}${c.n}`} className={`seq-msg ${active ? 'sel' : ''}`} onClick={() => setSel(active ? null : c.n)}>
                  <rect x={Math.min(x1, x2)} y={y - 30} width={Math.max(len, 8)} height={40} className="seq-hit" />
                  <line x1={x1} y1={y} x2={x2 - dir} y2={y} className={`seq-line ${isReq ? 'req' : 'res'}`} stroke={SEQ_TONE[tn]} markerEnd={`url(#seq-${tn})`} />
                  <text x={mid} y={y - 18} textAnchor="middle" className={`seq-label ${isReq ? 'req' : 'res'}`} fill={isReq ? undefined : SEQ_TONE[tn]}>
                    <title>{`${l1}${l2 ? `\n${l2}` : ''}${c.call.url && isReq ? `\n${c.call.url}` : ''}${!isReq && c.call.message ? `\n${c.call.message}` : ''}`}</title>
                    {clip(l1, len - 34)}
                  </text>
                  {l2 && <text x={mid} y={y - 6} textAnchor="middle" className="seq-label sub">{clip(l2, len - 34, 5.6)}</text>}
                  <g transform={`translate(${x1 + dir * 12},${y})`} className="seq-num">
                    <circle r={7.5} fill="var(--surface)" stroke={SEQ_TONE[tn]} />
                    <text y={3.4} textAnchor="middle">{c.n}</text>
                  </g>
                  {!isReq && c.call.failed && (
                    <g className="seq-note" transform={`translate(${Math.max(SEQ.gutter, Math.min(width - 262, Math.min(x1, x2) + 14))},${y + 6})`}>
                      <rect width={250} height={20} rx={6} />
                      <text x={8} y={13.5}>{clip(`✕ ${c.call.message || (c.call.status !== null ? `HTTP ${c.call.status} ${STATUS_TEXT[c.call.status] || ''}` : 'error')}`, 236, 6)}</text>
                    </g>
                  )}
                </g>
              );
            })}
            {events.filter((e) => e.kind === 'self').map((e) => {
              const st = e.st;
              const x = cx(st.service) + 6;
              const y = ry(e.row);
              return (
                <g key={`self${e.n}`} className={`seq-self ${st.span.error ? 'bad' : ''}`}>
                  <path d={`M${x},${y - 6} h26 v14 h-26`} fill="none" markerEnd={`url(#seq-${st.span.error ? 'bad' : 'none'})`} />
                  <text x={x + 34} y={y + 3}>{clip(`${st.span.name} · ${fmtDur(st.span.durUs)}`, SEQ.col / 2 - 46, 5.8)}<title>{`${st.span.name}\n${fmtDur(st.span.durUs)}${st.span.statusMessage ? `\n${st.span.statusMessage}` : ''}`}</title></text>
                </g>
              );
            })}
            {events.map((e) => <text key={`t${e.kind}${e.c ? e.c.n : `s${e.n}`}`} x={SEQ.gutter - 12} y={ry(e.row) + 11} textAnchor="end" className={`seq-time ${e.kind}`}>+{fmtDur(e.t - t0)}</text>)}
          </svg>
        </div>
      </div>
      {selected && <SeqDetail c={selected} label={label} onShowSpan={onShowSpan} traceId={trace.traceId} />}
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

function TraceViewer({ traceId, focusSpanId, startedAt, endedAt, refreshKey, meta, viewKey = 'trace.view.v2' }) {
  const toast = useToast();
  const [trace, setTrace] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [view, setView] = useLocalState(viewKey, 'timeline');
  const [service, setService] = useState(null);
  const [focusOverride, setFocusOverride] = useState(null);
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

  useEffect(() => { setService(null); setFocusOverride(null); }, [traceId]);

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
        {(meta?.stepName || trace?.found) && (
          <div className="trace-head-title">
            <b>{meta?.stepName || trace.summary.rootName}</b>
            {meta?.stepType && <span className="badge">{meta.stepType === 'endpoint' ? 'endpoint' : 'workflow'}</span>}
            {meta?.scenarioName && <em>{meta.scenarioName}</em>}
            {trace?.found && meta?.stepName && <span className="mono dim">{trace.summary.rootName}</span>}
          </div>
        )}
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
            { value: 'sequence', label: 'Sequence', icon: <LuArrowLeftRight size={14} /> },
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
          view === 'sequence' ? (
            <SequenceDiagram trace={trace} onShowSpan={(id) => { setService(null); setFocusOverride({ id, nonce: Date.now() }); setView('timeline'); }} />
          ) : view === 'graph' ? (
            <ServiceGraph
              trace={trace}
              activeService={service}
              onPickService={(s) => { setService(s); setView('timeline'); }}
              onShowSpan={(id) => { setService(null); setFocusOverride({ id, nonce: Date.now() }); setView('timeline'); }}
            />
          ) : (
            <Timeline trace={trace} focusSpanId={focusOverride ? focusOverride.id : focusSpanId} service={service} onClearService={() => setService(null)} />
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
  const [otherOpen, setOtherOpen] = useState(new Set());
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
            {!tracingSupported && !traces.length && (
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
                    {[...st.items.filter((t) => t.relation !== 'other' || !st.items.some((x) => x.relation !== 'other')), ...(otherOpen.has(`${gi}-${si}`) ? st.items.filter((t) => t.relation === 'other' && st.items.some((x) => x.relation !== 'other')) : [])].map((t) => (
                      <button
                        type="button"
                        key={t.traceId}
                        className={`trace-item ${selected?.traceId === t.traceId ? 'active' : ''} ${t.relation === 'other' ? 'other' : ''}`}
                        onClick={() => setSelected({ traceId: t.traceId, spanId: null })}
                      >
                        <StatusDot status={t.found ? (t.summary?.errorCount || t.errors ? 'failed' : 'passed') : t.errors ? 'failed' : running ? 'running' : 'stopped'} />
                        <div className="trace-item-text">
                          <div className="trace-item-title">{traceTitle(t)}</div>
                          <div className="trace-item-meta mono trace-item-req" title={t.origin === 'logs' ? undefined : traceLabel(t)}>
                            {t.origin === 'logs' ? 'from component logs' : traceLabel(t)}
                          </div>
                          {t.summary?.roots > 1 && <div className="trace-item-meta"><em>+{t.summary.roots - 1} more request{t.summary.roots === 2 ? '' : 's'}</em></div>}
                          <div className="trace-item-meta">
                            {t.found ? `${t.summary.spanCount} spans · ${fmtDur(t.summary.durUs)}` : t.error ? 'lookup failed' : 'waiting for Tempo…'}
                            {startedAt && t.startedAt ? ` · +${((t.startedAt - startedAt) / 1000).toFixed(1)}s` : ''}
                            {' · '}<span className="mono">{shortId(t.traceId)}</span>
                          </div>
                          {t.origin === 'logs' && (
                            <div className="trace-item-meta" title={t.sample || ''}>
                              {t.errors ? `${t.errors} error line${t.errors === 1 ? '' : 's'}` : t.warns ? `${t.warns} warning${t.warns === 1 ? '' : 's'}` : 'seen in component logs'}
                              {t.source ? ` · ${String(t.source).replace(/^pod:[^/]*\//, '')}` : ''}
                            </div>
                          )}
                          {t.found && (
                            <div className="trace-item-svcs">
                              {t.summary.services.map((sv) => <span key={sv} className="svc-dot" title={sv} style={{ background: colorFor(sv) }} />)}
                            </div>
                          )}
                        </div>
                      </button>
                    ))}
                    {(() => {
                      const others = st.items.filter((t) => t.relation === 'other');
                      if (!others.length || !st.items.some((t) => t.relation !== 'other')) return null;
                      const k = `${gi}-${si}`;
                      return (
                        <button type="button" className="trace-others" onClick={() => setOtherOpen((cur) => { const n = new Set(cur); if (n.has(k)) n.delete(k); else n.add(k); return n; })} title="Requests seen in the component logs during this step that did not carry the suite's traceparent: the suite's /reset calls, background jobs or other people's traffic. They are separate traces by design.">
                          {otherOpen.has(k) ? 'Hide' : 'Show'} {others.length} other trace{others.length === 1 ? '' : 's'} from logs
                        </button>
                      );
                    })()}
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
            meta={sel}
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
          <span className="sheet-title-main">{tr ? traceTitle(tr) : 'Trace'}</span>
          {tr?.stepName && <span className="sheet-title-sub">{tr.scenarioName ? `${tr.scenarioName} › ` : ''}{traceLabel(tr)}</span>}
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
        meta={tr}
      />
    </aside>
  );
}
