import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LuFlaskConical, LuFolderOpen, LuFolderTree, LuGitBranch, LuBoxes, LuTerminal, LuWaypoints, LuWorkflow, LuSettings, LuHistory, LuLoader } from 'react-icons/lu';
import OutputFiles from './OutputFiles.jsx';
import { api, wsUrl } from './api.js';
import TestsView from './TestsView.jsx';
import DeploymentsView from './DeploymentsView.jsx';
import CreateTestView from './CreateTestView.jsx';
import GitView from './GitView.jsx';
import SettingsView from './SettingsView.jsx';
import HistoryView from './HistoryView.jsx';
import LogPanel from './LogPanel.jsx';
import ScenarioFlow from './ScenarioFlow.jsx';
import OcSessionHost from './OcSession.jsx';
import { TracesPanel, TraceSheet, TraceLinkContext, useRunTraces } from './tracing.jsx';
import logoUrl from './assets/nevis-logo.png';
import { EmptyState, Segmented, StatusDot, ToastProvider, useToast } from './ui.jsx';

export const SECTIONS = {
  explorer: { label: 'Explorer', icon: LuFolderTree, render: () => <CreateTestView active mode="explore" /> },
  tests: { label: 'Run tests', icon: LuFlaskConical, render: () => <TestsView /> },
  history: { label: 'History', icon: LuHistory, render: () => <HistoryView active /> },
  git: { label: 'Git', icon: LuGitBranch, render: () => <GitView active /> },
  deployments: { label: 'Deployments', icon: LuBoxes, render: () => <DeploymentsView /> },
  settings: { label: 'Settings', icon: LuSettings, render: () => <SettingsView active /> },
};

// Live stream of one run: same messages the Run tests tab consumes.
function useRunStream(runId) {
  const [run, setRun] = useState(null);
  const [sources, setSources] = useState({});
  const [flow, setFlow] = useState([]);
  const [error, setError] = useState('');
  const wsRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api.run(runId).then(({ run: r }) => {
      if (cancelled) return;
      setRun({ id: r.id, status: r.status, exitCode: r.exitCode, config: r.config, createdAt: r.createdAt });
      setSources(r.sources || {});
      setFlow(r.flow || []);
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', runId }));
      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'backlog') {
          setSources(msg.sources || {});
          setFlow(msg.flow || []);
          setRun((cur) => (cur ? { ...cur, status: msg.status, exitCode: msg.exitCode } : cur));
        } else if (msg.type === 'log') {
          setSources((prev) => ({ ...prev, [msg.entry.source]: [...(prev[msg.entry.source] || []), msg.entry] }));
        } else if (msg.type === 'flow') setFlow(msg.tests || []);
        else if (msg.type === 'status') setRun((cur) => (cur ? { ...cur, status: msg.status, exitCode: msg.exitCode } : cur));
      };
    }).catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, [runId]);

  return { run, sources, flow, error };
}

export function RunPopout({ runId, initialView, initialFocus = null, source, only, embedded = false }) {
  const toast = useToast();
  const { run, sources, flow, error } = useRunStream(runId);
  const [view, setView] = useState(initialView || 'logs');
  const [tab, setTab] = useState(source || 'pytest');
  const [sheet, setSheet] = useState(null);
  const [focus, setFocus] = useState(initialFocus);
  const runTraces = useRunTraces(run?.id, run?.status);
  const links = useMemo(() => {
    const known = new Set();
    const byStep = {};
    for (const t of runTraces.traces) {
      known.add(t.traceId);
      if (t.stepId && !byStep[t.stepId]) byStep[t.stepId] = t.traceId;
    }
    return { known, byStep, open: (traceId, spanId) => setSheet({ traceId, spanId, nonce: Date.now() }) };
  }, [runTraces.traces]);

  useEffect(() => {
    if (embedded) return;
    document.title = `${only && source ? source : 'Run'} · ${runId.slice(0, 8)} — Nevis Test Dashboard`;
  }, [runId, only, source, embedded]);

  // Re-run a scenario out of THIS run (History's own way in - Run tests has its own copy of this
  // same idea). `replaces` is what makes the server persist the swap on `run.id` itself, so it
  // shows this way (and stays this way across a refresh) wherever this run is opened from.
  const rerunScenario = async (name) => {
    if (!run || ['starting', 'running'].includes(run.status)) return;
    try {
      const cfg = run.config;
      await api.startRun({
        env: cfg.env,
        namespace: cfg.namespace,
        labels: cfg.labels,
        exclusionLabels: cfg.exclusionLabels,
        pods: cfg.pods || [],
        keyword: name,
        replaces: { runId: run.id, scenarioName: name },
        ...(cfg.env === 'devtest' && cfg.ssh ? { ssh: cfg.ssh } : {}),
      });
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  if (error) return <EmptyState icon={<LuTerminal size={26} />} title="Could not open this run">{error}</EmptyState>;
  if (!run) return <EmptyState icon={<LuLoader size={24} className="spin" />} title="Connecting to the run…" />;

  const names = Object.keys(sources);
  const all = names.flatMap((n) => sources[n]).sort((a, b) => a.ts - b.ts).map((e) => ({ ...e, line: `[${e.source}] ${e.line}` }));

  return (
    <div className="view col">
      <div className="tabstrip">
        {!only && (
          <Segmented
            size="sm"
            block={false}
            value={view}
            onChange={setView}
            options={[
              { value: 'logs', label: 'Logs', icon: <LuTerminal size={14} /> },
              { value: 'flow', label: 'Scenario flow', icon: <LuWorkflow size={14} />, count: flow.length || undefined },
              { value: 'traces', label: 'Traces', icon: <LuWaypoints size={14} />, count: runTraces.traces.length || undefined },
              { value: 'output', label: 'Output', icon: <LuFolderOpen size={14} /> },
            ]}
          />
        )}
        {only && <span className="tabstrip-title">{source === 'all' ? 'All logs' : source}</span>}
        <span className="spacer" />
        <div className={`run-pill s-${run.status}`}>
          <StatusDot status={run.status} />
          <span>Run {run.id.slice(0, 8)} · {run.status}{run.exitCode !== null && run.exitCode !== undefined ? ` (exit ${run.exitCode})` : ''}</span>
        </div>
      </div>
      <TraceLinkContext.Provider value={links}>
        {view === 'traces' && !only ? (
          <TracesPanel runTraces={runTraces} focus={focus} />
        ) : view === 'output' && !only ? (
          <OutputFiles runId={run.id} since={run.createdAt} />
        ) : view === 'flow' && !only ? (
          <ScenarioFlow tests={flow} pytestEntries={sources.pytest || []} onRerun={only ? undefined : rerunScenario} />
        ) : names.length === 0 ? (
          <EmptyState icon={<LuTerminal size={26} />} title="Waiting for output…" />
        ) : (
          <>
            {!only && (
              <div className="subtabs">
                <button className={tab === 'all' ? 'subtab active' : 'subtab'} onClick={() => setTab('all')}>all <em>{all.length}</em></button>
                {names.map((n) => (
                  <button key={n} className={tab === n ? 'subtab active' : 'subtab'} onClick={() => setTab(n)}>{n} <em>{sources[n].length}</em></button>
                ))}
              </div>
            )}
            {tab === 'all' ? <LogPanel title="all" entries={all} /> : <LogPanel key={tab} title={tab} entries={sources[tab] || []} />}
          </>
        )}
      </TraceLinkContext.Provider>
      {sheet && (
        <TraceSheet
          runTraces={runTraces}
          target={sheet}
          onClose={() => setSheet(null)}
          onExpand={() => { setFocus({ ...sheet, nonce: Date.now() }); setView('traces'); setSheet(null); }}
        />
      )}
    </div>
  );
}

export default function PopoutApp() {
  const q = new URLSearchParams(window.location.search);
  const kind = q.get('kind') || 'section';
  const name = q.get('name') || 'explorer';
  const section = SECTIONS[name];

  useEffect(() => {
    if (kind === 'section' && section) document.title = `${section.label} — Nevis Test Dashboard`;
  }, [kind, section]);

  return (
    <ToastProvider>
      <div className="app popout">
        <div className="popout-bar">
          <img className="nevis-logo" src={logoUrl} width={22} height={22} alt="" draggable={false} />
          <span className="popout-title">{kind === 'run' ? 'Run output' : section ? section.label : 'Nevis Test Dashboard'}</span>
          <span className="spacer" />
          <span className="muted popout-hint">{kind === 'run' ? 'Live view of this run' : 'Separate window, independent of the main one'}</span>
          <OcSessionHost collapsed />
        </div>
        <main className="app-body">
          <div className="app-pane">
            {kind === 'run' ? (
              <RunPopout runId={q.get('run') || ''} initialView={q.get('view') || 'logs'} source={q.get('source') || ''} only={q.get('only') === '1'} />
            ) : section ? (
              section.render()
            ) : (
              <EmptyState title="Unknown view" />
            )}
          </div>
        </main>
      </div>
    </ToastProvider>
  );
}
