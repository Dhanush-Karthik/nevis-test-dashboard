import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LuCircleAlert, LuHistory, LuPanelLeftClose, LuPanelLeftOpen, LuSearch, LuSquareArrowOutUpRight, LuTrash2, LuX } from 'react-icons/lu';
import { api } from './api.js';
import { RunPopout } from './PopoutApp.jsx';
import { openPopout } from './popout.js';
import { EmptyState, IconButton, Sash, Segmented, StatusDot, useLocalState, usePanelSize, useToast } from './ui.jsx';

const finished = (r) => !['starting', 'running'].includes(r.status);
const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDay = (ms) => {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const fmtSpan = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const kindLabel = (r) => (r.kind === 'scenario-test' ? 'Scenario test' : 'Test run');
const titleOf = (r) => r.title || (r.config.labels || []).join(', ') || 'Run';

function RunItem({ run, active, now, onOpen, onRemove }) {
  const c = run.counts || {};
  const dur = fmtSpan((run.endedAt || now) - run.createdAt);
  return (
    <div className={`hist-item ${active ? 'active' : ''}`} onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <StatusDot status={run.status} />
      <div className="hist-item-body">
        <div className="hist-item-title">
          <span className="ellipsis">{titleOf(run)}</span>
          <span className="hist-kind">{kindLabel(run)}</span>
        </div>
        <div className="hist-item-meta">
          {fmtClock(run.createdAt)} · {dur} · <span className="mono">{run.config.namespace}</span>
        </div>
        {c.total > 0 && (
          <div className="hist-item-counts">
            {c.passed > 0 && <span className="ok">{c.passed} passed</span>}
            {c.failed > 0 && <span className="bad">{c.failed} failed</span>}
            {c.running > 0 && <span>{c.running} running</span>}
          </div>
        )}
      </div>
      {finished(run) && (
        <span className="hist-item-x" onClick={(e) => e.stopPropagation()}>
          <IconButton size="xs" icon={<LuX size={13} />} title="Remove from history" onClick={onRemove} />
        </span>
      )}
    </div>
  );
}

// Every run this dashboard has started since the server (re)started, kept in memory so a page
// refresh (or another browser tab) can get straight back to the logs, scenario flow and traces.
export default function HistoryView({ active = true }) {
  const toast = useToast();
  const [runs, setRuns] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useLocalState('history.filter', 'all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useLocalState('history.selected', null);
  const [now, setNow] = useState(Date.now());
  const [confirmClear, setConfirmClear] = useState(false);
  const [sideOpen, setSideOpen] = useLocalState('history.sideOpen', true);
  const [sideW, setSideW, resetSideW] = usePanelSize('history.side', 340, 260, () => Math.min(600, window.innerWidth * 0.45));
  const [viewHint, setViewHint] = useState('flow');
  const [focusHint, setFocusHint] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.runs();
      setRuns(r.runs);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoaded(true);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  // global search: jump to a run (and its traces)
  useEffect(() => {
    const onNav = (e) => {
      const n = e.detail || {};
      if (n.section !== 'history') return;
      if (n.run) { setSelected(n.run); setViewHint(n.view || 'flow'); setFocusHint(n.traceId ? { traceId: n.traceId, spanId: n.spanId || null, nonce: Date.now() } : null); setFilter('all'); setQ(''); load(); }
    };
    window.addEventListener('nevis-nav', onNav);
    return () => window.removeEventListener('nevis-nav', onNav);
  }, [setSelected, setFilter, load]);

  // keep counts and durations live while something is running
  const anyRunning = runs.some((r) => !finished(r));
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(load, anyRunning ? 2500 : 15000);
    return () => clearInterval(t);
  }, [active, anyRunning, load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return runs.filter((r) => {
      if (filter === 'failed' && !(r.status === 'failed' || r.status === 'error' || r.counts?.failed > 0)) return false;
      if (filter === 'passed' && !(r.status === 'passed' && !(r.counts?.failed > 0))) return false;
      if (!needle) return true;
      return [titleOf(r), r.config.namespace, ...(r.scenarios || [])].some((s) => String(s).toLowerCase().includes(needle));
    });
  }, [runs, filter, q]);

  // land on the most recent run when nothing valid is selected
  const current = runs.find((r) => r.id === selected) || null;
  useEffect(() => {
    if (loaded && !current && runs.length) setSelected(runs[0].id);
  }, [loaded, current, runs, setSelected]);

  const remove = async (id) => {
    try {
      await api.removeRun(id);
      if (selected === id) setSelected(null);
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const clear = async () => {
    try {
      const r = await api.clearRuns();
      toast(`Removed ${r.removed} finished run${r.removed === 1 ? '' : 's'}`);
      setConfirmClear(false);
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const popOut = () => {
    if (current && !openPopout(`run-${current.id}-all`, { kind: 'run', run: current.id, view: 'logs' })) toast('The browser blocked the new window. Allow pop-ups for this site and try again.', 'error');
  };

  // group by day
  const groups = [];
  for (const r of shown) {
    const day = fmtDay(r.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.runs.push(r);
    else groups.push({ day, runs: [r] });
  }
  const finishedCount = runs.filter(finished).length;

  return (
    <div className="view">
      {sideOpen ? (
      <aside className="panel side hist-side" style={{ width: sideW }}>
        <div className="panel-head slim">
          <span className="panel-title"><LuHistory size={15} /> History <em className="count">{runs.length}</em></span>
          <span className="spacer" />
          {confirmClear ? (
            <>
              <button type="button" className="btn sm danger" onClick={clear}>Remove {finishedCount}</button>
              <IconButton size="sm" icon={<LuX size={14} />} title="Cancel" onClick={() => setConfirmClear(false)} />
            </>
          ) : (
            <IconButton size="sm" icon={<LuTrash2 size={14} />} title="Remove all finished runs" disabled={!finishedCount} onClick={() => setConfirmClear(true)} />
          )}
          <IconButton size="sm" icon={<LuPanelLeftClose size={15} />} title="Hide the run list" onClick={() => setSideOpen(false)} />
        </div>
        <div className="hist-controls">
          <div className="search-box">
            <LuSearch size={14} className="search-box-icon" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Label, scenario, namespace…" spellCheck={false} />
            {q && <IconButton size="xs" icon={<LuX size={13} />} title="Clear" onClick={() => setQ('')} />}
          </div>
          <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'failed', label: 'Failed' }, { value: 'passed', label: 'Passed' }]} />
        </div>
        <div className="panel-scroll tight">
          {error && <div className="notice warn small"><LuCircleAlert size={14} /><div>{error}</div></div>}
          {groups.map((g) => (
            <div key={g.day} className="hist-group">
              <div className="hist-day">{g.day}</div>
              {g.runs.map((r) => (
                <RunItem key={r.id} run={r} now={now} active={r.id === selected} onOpen={() => setSelected(r.id)} onRemove={() => remove(r.id)} />
              ))}
            </div>
          ))}
          {loaded && !shown.length && <div className="list-hint pad">{runs.length ? 'No runs match.' : 'No runs yet. Start one from Run tests, or press Test scenario in the Explorer.'}</div>}
        </div>
        <div className="ft-foot">Kept in memory until the dashboard restarts</div>
        <Sash edge="end" size={sideW} onSize={setSideW} onReset={resetSideW} />
      </aside>
      ) : (
        <div className="rail left">
          <IconButton size="md" icon={<LuPanelLeftOpen size={16} />} title="Show the run list" onClick={() => setSideOpen(true)} />
          <span className="rail-label">History</span>
        </div>
      )}

      <div className="hist-main">
        {current ? (
          <>
            <div className="hist-head">
              <div className="hist-head-text">
                <div className="hist-head-title">{titleOf(current)}</div>
                <div className="hist-head-sub">
                  {kindLabel(current)} · {fmtDay(current.createdAt)} {fmtClock(current.createdAt)} · {fmtSpan((current.endedAt || now) - current.createdAt)} · <span className="mono">{current.config.namespace}</span>
                  {current.config.labels?.length > 0 && current.kind !== 'scenario-test' && <> · labels <span className="mono">{current.config.labels.join(' ')}</span></>}
                  {current.config.exclusionLabels?.length > 0 && <> · excluding <span className="mono">{current.config.exclusionLabels.join(' ')}</span></>}
                </div>
              </div>
              <button type="button" className="btn sm" onClick={popOut} title="Open this run in its own window"><LuSquareArrowOutUpRight size={13} /> Pop out</button>
            </div>
            <RunPopout key={`${current.id}-${viewHint}-${focusHint?.nonce || 0}`} runId={current.id} initialView={viewHint} initialFocus={focusHint} embedded />
          </>
        ) : (
          <EmptyState icon={<LuHistory size={26} />} title="Pick a run">Logs, scenario flow and traces of every run since the dashboard started are kept here.</EmptyState>
        )}
      </div>
    </div>
  );
}
