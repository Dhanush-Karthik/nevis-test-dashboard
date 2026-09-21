import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuCornerDownLeft, LuLoader, LuSearch, LuX } from 'react-icons/lu';
import { api } from './api.js';
import { StatusDot } from './ui.jsx';

const PAGES = [
  { title: 'Explorer', sub: 'Files, scenarios and the flow builder', nav: { section: 'explorer' } },
  { title: 'Run tests', sub: 'Start a run, tail pod logs', nav: { section: 'tests' } },
  { title: 'History', sub: 'Every run since the dashboard started', nav: { section: 'history' } },
  { title: 'Git', sub: 'Branches, staging, commit, push', nav: { section: 'git' } },
  { title: 'Deployments', sub: 'Cluster resources', nav: { section: 'deployments' } },
  { title: 'Settings · Default configs', sub: 'config/defaults', nav: { section: 'settings', tab: 'defaults' } },
  { title: 'Settings · .env', sub: 'Environment variables', nav: { section: 'settings', tab: 'env' } },
];

// Display order + a short tag per group; the colour of the tag comes from the `g-<id>` class.
const ORDER = ['pages', 'files', 'scenarios', 'labels', 'workflows', 'endpoints', 'runs', 'traces', 'spans', 'defaults', 'env', 'git', 'cluster'];
const TAG = { pages: 'Page', files: 'File', scenarios: 'Scenario', labels: 'Label', workflows: 'Workflow', endpoints: 'Endpoint', runs: 'Run', traces: 'Trace', spans: 'Span', defaults: 'Default', env: 'Env var', git: 'Git', cluster: 'Cluster' };
const LABEL = { pages: 'Pages', files: 'Files', scenarios: 'Scenarios', labels: 'Labels', workflows: 'Workflows', endpoints: 'Endpoints', runs: 'History', traces: 'Traces', spans: 'Spans', defaults: 'Default configs', env: '.env variables', git: 'Git', cluster: 'Cluster (Deployments)' };

// Resources the Deployments view loaded last (kept on window so the palette can search them without a cluster call).
function clusterItems(q) {
  const c = window.__nevisCluster;
  if (!c) return [];
  const has = (v) => String(v ?? '').toLowerCase().includes(q);
  const items = [];
  for (const d of c.deployments || []) if (has(d.name) || (d.images || []).some(has)) items.push({ title: d.name, sub: `deployment · ${c.namespace} · ${d.replicas?.ready}/${d.replicas?.desired} ready`, kind: 'Deployment' });
  for (const p of c.pods || []) if (has(p.name)) items.push({ title: p.name, sub: `pod · ${c.namespace} · ${p.status}`, kind: 'Pod', status: p.status === 'Running' ? 'passed' : 'failed' });
  for (const s of c.services || []) if (has(s.name)) items.push({ title: s.name, sub: `service · ${c.namespace} · ${s.type}`, kind: 'Service' });
  for (const s of c.secrets || []) if (has(s.name) || (s.keys || []).some(has)) items.push({ title: s.name, sub: `secret · ${c.namespace} · keys only, values are never read`, kind: 'Secret' });
  return items.map((i) => ({ ...i, group: 'cluster', nav: { section: 'deployments' } }));
}

function Highlight({ text, q }) {
  const i = q ? String(text).toLowerCase().indexOf(q) : -1;
  if (i < 0) return text;
  return <>{String(text).slice(0, i)}<mark>{String(text).slice(i, i + q.length)}</mark>{String(text).slice(i + q.length)}</>;
}

export default function GlobalSearch({ onClose, onNavigate }) {
  const [input, setInput] = useState('');
  const [remote, setRemote] = useState([]);
  const [loading, setLoading] = useState(false);
  const [only, setOnly] = useState('all');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef(null);
  const q = input.trim().toLowerCase();

  useEffect(() => {
    if (q.length < 2) { setRemote([]); return undefined; }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json()).then((r) => { if (!cancelled) setRemote(r.groups || []); }).catch(() => !cancelled && setRemote([])).finally(() => !cancelled && setLoading(false));
    }, 160);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  const groups = useMemo(() => {
    const list = [];
    const pages = PAGES.filter((p) => !q || p.title.toLowerCase().includes(q) || p.sub.toLowerCase().includes(q)).map((p) => ({ ...p, group: 'pages' }));
    if (pages.length) list.push({ id: 'pages', total: pages.length, items: pages });
    for (const g of remote) list.push({ id: g.id, total: g.total, items: g.items });
    if (q.length >= 2) {
      const cl = clusterItems(q);
      if (cl.length) list.push({ id: 'cluster', total: cl.length, items: cl.slice(0, 8) });
    }
    return list.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  }, [remote, q]);

  const shown = only === 'all' ? groups : groups.filter((g) => g.id === only);
  const flat = shown.flatMap((g) => g.items);
  useEffect(() => setCursor(0), [q, only, remote]);
  useEffect(() => { listRef.current?.querySelector('[data-cur="true"]')?.scrollIntoView({ block: 'nearest' }); }, [cursor]);
  useEffect(() => { if (only !== 'all' && !groups.some((g) => g.id === only)) setOnly('all'); }, [groups, only]);

  const go = (item) => { if (!item) return; onClose(); onNavigate(item.nav); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(flat.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(flat[cursor]); }
  };

  let idx = -1;
  return createPortal(
    <div className="gs-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gs" role="dialog" aria-label="Search everything" onKeyDown={onKey}>
        <div className="gs-input">
          <LuSearch size={17} className="muted" />
          <input autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search files, scenarios, labels, workflows, runs, traces, env variables, pods…" spellCheck={false} />
          {loading && <LuLoader size={15} className="spin muted" />}
          {input && <button type="button" className="gs-clear" onClick={() => setInput('')} aria-label="Clear"><LuX size={14} /></button>}
          <kbd>Esc</kbd>
        </div>
        {groups.length > 1 && (
          <div className="gs-chips">
            <button type="button" className={`gs-chip ${only === 'all' ? 'on' : ''}`} onClick={() => setOnly('all')}>All <em>{groups.reduce((n, g) => n + g.total, 0)}</em></button>
            {groups.map((g) => (
              <button key={g.id} type="button" className={`gs-chip g-${g.id} ${only === g.id ? 'on' : ''}`} onClick={() => setOnly(only === g.id ? 'all' : g.id)}>{LABEL[g.id]} <em>{g.total}</em></button>
            ))}
          </div>
        )}
        <div className="gs-list" ref={listRef}>
          {shown.map((g) => (
            <div key={g.id} className="gs-group">
              <div className={`gs-group-title g-${g.id}`}>{LABEL[g.id]}<span>{g.total > g.items.length ? `${g.items.length} of ${g.total}` : g.total}</span></div>
              {g.items.map((item, i) => {
                idx += 1;
                const me = idx;
                return (
                  <div key={`${g.id}${i}`} className={`gs-row ${cursor === me ? 'cur' : ''}`} data-cur={cursor === me} onMouseMove={() => setCursor(me)} onClick={() => go(item)}>
                    <span className={`gs-tag g-${g.id}`}>{item.kind || TAG[g.id]}</span>
                    <div className="gs-row-text">
                      <div className="gs-row-title"><Highlight text={item.title} q={q} /></div>
                      {item.sub && <div className="gs-row-sub"><Highlight text={item.sub} q={q} /></div>}
                    </div>
                    {item.status && <StatusDot status={item.status} />}
                    {cursor === me && <LuCornerDownLeft size={13} className="muted" />}
                  </div>
                );
              })}
            </div>
          ))}
          {q.length >= 2 && !loading && flat.length === 0 && <div className="gs-empty">Nothing matches “{input.trim()}”.</div>}
          {q.length < 2 && <div className="gs-hint">Type 2 or more characters. Results are grouped by kind; the chips above narrow them. Cluster resources are searched from what the Deployments tab last loaded.</div>}
        </div>
        <div className="gs-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
      </div>
    </div>,
    document.body
  );
}
