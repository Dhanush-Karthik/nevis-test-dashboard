import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api, wsUrl } from './api.js';
import LogPanel from './LogPanel.jsx';
import ScenarioFlow from './ScenarioFlow.jsx';
import { LuCircleAlert, LuHistory, LuLoader, LuPanelLeftClose, LuPanelLeftOpen, LuPlay, LuRefreshCw, LuSearch, LuServer, LuSquare, LuSquareArrowOutUpRight, LuTags, LuTerminal, LuWorkflow } from 'react-icons/lu';
import AusweisAppControl from './AusweisAppControl.jsx';
import { TracesPanel, TraceSheet, TraceLinkContext, useRunTraces } from './tracing.jsx';
import { LuWaypoints } from 'react-icons/lu';
import { useOnOcLogin } from './OcSession.jsx';
import { openPopout, setActiveRun, shortcutLabel } from './popout.js';
import { Checkbox, Combobox, EmptyState, Field, IconButton, Sash, Section, MenuButton, Segmented, Select, usePanelSize, useLocalState, useToast, StatusDot } from './ui.jsx';

const DEBOUNCE_MS = 450;

function parseList(text) {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function podKey(namespace, name) {
  return `${namespace}::${name}`;
}

// Small debounce hook: returns a version of `value` that only updates once the
// caller has stopped changing it for `delay` ms.
function useDebounced(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export default function TestsView() {
  const toast = useToast();
  const [env, setEnv] = useState('dev');
  const [labelsText, setLabelsText] = useState('');
  const [exclusionText, setExclusionText] = useState('eid');
  const [namespace, setNamespace] = useState('');
  const [sshHost, setSshHost] = useState('');
  const [sshUser, setSshUser] = useState('');
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [sshPassphrase, setSshPassphrase] = useState('');

  const [labelCatalog, setLabelCatalog] = useState([]);
  const [resolution, setResolution] = useState({ namespaces: [], scenarios: [] });
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState('');

  const [nsFilter, setNsFilter] = useState('');
  const [podFilter, setPodFilter] = useState('');
  const [allNamespaces, setAllNamespaces] = useState([]);
  const [selectedNamespaces, setSelectedNamespaces] = useState(new Set());
  const [nsLoading, setNsLoading] = useState(false);
  const [nsError, setNsError] = useState('');

  const [pods, setPods] = useState([]);
  const [selectedPods, setSelectedPods] = useState(new Set());
  const [podsLoading, setPodsLoading] = useState(false);
  const [podsError, setPodsError] = useState('');

  const [runs, setRuns] = useState([]);
  const [currentRun, setCurrentRun] = useState(null); // {id, status, exitCode, config}
  const [sources, setSources] = useState({}); // sourceName -> entries[]
  const [flow, setFlow] = useState([]);
  const [activeTab, setActiveTab] = useState('pytest');
  const [mainView, setMainView] = useState('flow'); // 'flow' | 'logs' | 'traces'
  const [starting, setStarting] = useState(false);
  const [traceFocus, setTraceFocus] = useState(null);
  const [traceSheet, setTraceSheet] = useState(null); // trace peek that slides over the current view
  const [sideOpen, setSideOpen] = useLocalState('tests.sideOpen', true);
  const [sideW, setSideW, resetSideW] = usePanelSize('tests.side', 340, 260, () => Math.min(640, window.innerWidth - 420));
  const [startError, setStartError] = useState('');

  const wsRef = useRef(null);
  const runTraces = useRunTraces(currentRun?.id, currentRun?.status);
  const traceLinks = useMemo(() => {
    const known = new Set();
    const byStep = {};
    for (const t of runTraces.traces) {
      known.add(t.traceId);
      if (t.stepId && !byStep[t.stepId]) byStep[t.stepId] = t.traceId;
    }
    return { known, byStep, open: (traceId, spanId) => setTraceSheet({ traceId, spanId, nonce: Date.now() }) };
  }, [runTraces.traces]);
  const debouncedLabels = useDebounced(labelsText, DEBOUNCE_MS);
  const debouncedExclusion = useDebounced(exclusionText, DEBOUNCE_MS);

  useEffect(() => {
    api.defaults().then((d) => {
      setExclusionText((d.exclusionLabels || []).join(' '));
      setSshHost(d.ssh.host);
      setSshUser(d.ssh.user);
      setSshKeyPath(d.ssh.keyPath);
    });
    api.scenarios.labels().then((r) => setLabelCatalog(r.labels)).catch(() => {});
    refreshRuns();
  }, []);

  const refreshRuns = () => api.runs().then((r) => setRuns(r.runs));

  const sshCfg = () => ({ host: sshHost, user: sshUser, keyPath: sshKeyPath, passphrase: sshPassphrase || undefined });

  // Step 1 of the auto-chain: labels -> which namespaces actually support them.
  // Reads config/**/*.yaml server-side, so devs never need to go read the code.
  useEffect(() => {
    if (!debouncedLabels.trim()) {
      setResolution({ namespaces: [], scenarios: [] });
      setResolveError('');
      return;
    }
    let cancelled = false;
    setResolving(true);
    setResolveError('');
    api.scenarios
      .resolve({ labels: debouncedLabels, exclusionLabels: debouncedExclusion })
      .then((r) => {
        if (cancelled) return;
        setResolution(r);
        setNamespace((cur) => (r.namespaces.includes(cur) ? cur : r.namespaces[0] || ''));
      })
      .catch((err) => !cancelled && setResolveError(err.message))
      .finally(() => !cancelled && setResolving(false));
    return () => {
      cancelled = true;
    };
  }, [debouncedLabels, debouncedExclusion]);

  const fetchNamespaces = useCallback(
    async (autoSelect) => {
      setNsError('');
      setNsLoading(true);
      try {
        const cfg = { env, ...(env === 'devtest' ? { ssh: sshCfg() } : {}) };
        const { projects } = await api.projects(cfg);
        setAllNamespaces(projects);
        if (autoSelect && projects.includes(autoSelect)) {
          setSelectedNamespaces(new Set([autoSelect]));
        }
      } catch (err) {
        setNsError(err.message);
      } finally {
        setNsLoading(false);
      }
    },
    [env, sshHost, sshUser, sshKeyPath, sshPassphrase]
  );

  // Step 2 of the auto-chain: once a test namespace is picked, go find the
  // matching oc project(s) automatically instead of waiting for a manual click.
  useEffect(() => {
    if (!namespace) return;
    setNsFilter(namespace);
    fetchNamespaces(namespace);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, env]);

  const toggleNamespace = (ns) => {
    setSelectedNamespaces((prev) => {
      const next = new Set(prev);
      if (next.has(ns)) next.delete(ns);
      else next.add(ns);
      return next;
    });
  };

  const fetchPods = useCallback(async () => {
    if (selectedNamespaces.size === 0) {
      setPods([]);
      return;
    }
    setPodsError('');
    setPodsLoading(true);
    try {
      const cfg = { env, namespaces: [...selectedNamespaces], ...(env === 'devtest' ? { ssh: sshCfg() } : {}) };
      const { pods, errors } = await api.pods(cfg);
      setPods(pods);
      if (errors && errors.length) {
        setPodsError(errors.map((e) => `${e.namespace}: ${e.message}`).join('; '));
      }
    } catch (err) {
      setPodsError(err.message);
    } finally {
      setPodsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, sshHost, sshUser, sshKeyPath, sshPassphrase, selectedNamespaces]);

  // Step 3 of the auto-chain: pods load themselves the moment a namespace is
  // checked - no separate "fetch pods" click required.
  useEffect(() => {
    const t = setTimeout(() => fetchPods(), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNamespaces, env]);

  // after logging in again, reload what the expired login could not fetch
  useOnOcLogin(() => {
    fetchNamespaces();
    fetchPods();
  });

  const togglePod = (namespace, name) => {
    const key = podKey(namespace, name);
    setSelectedPods((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const connectWs = useCallback((runId, initialSources, initialFlow) => {
    wsRef.current?.close();
    setSources(initialSources || {});
    setFlow(initialFlow || []);
    const ws = new WebSocket(wsUrl());
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', runId }));
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'backlog') {
        setSources(msg.sources || {});
        setFlow(msg.flow || []);
        setCurrentRun((cur) => (cur ? { ...cur, status: msg.status, exitCode: msg.exitCode } : cur));
      } else if (msg.type === 'log') {
        setSources((prev) => {
          const arr = prev[msg.entry.source] ? [...prev[msg.entry.source], msg.entry] : [msg.entry];
          return { ...prev, [msg.entry.source]: arr };
        });
      } else if (msg.type === 'flow') {
        setFlow(msg.tests || []);
      } else if (msg.type === 'status') {
        setCurrentRun((cur) => (cur ? { ...cur, status: msg.status, exitCode: msg.exitCode } : cur));
        refreshRuns();
      }
    };
  }, []);

  const startRun = async () => {
    setStartError('');
    const labels = parseList(labelsText);
    if (!namespace.trim() || labels.length === 0) {
      setStartError('pick at least one label that resolves to a namespace');
      return;
    }
    setStarting(true);
    try {
      const podsPayload = [...selectedPods].map((key) => {
        const [ns, name] = key.split('::');
        return { namespace: ns, name };
      });
      const config = {
        env,
        namespace: namespace.trim(),
        labels,
        exclusionLabels: parseList(exclusionText),
        pods: podsPayload,
        ...(env === 'devtest' ? { ssh: sshCfg() } : {}),
      };
      const { run } = await api.startRun(config);
      setCurrentRun({ id: run.id, status: run.status, exitCode: run.exitCode, config: run.config });
      setActiveTab('pytest');
      setMainView('flow');
      connectWs(run.id, run.sources, run.flow);
      refreshRuns();
    } catch (err) {
      setStartError(err.message);
    } finally {
      setStarting(false);
    }
  };

  const stopRun = async () => {
    if (!currentRun) return;
    await api.stopRun(currentRun.id);
  };

  const openHistoricalRun = async (id) => {
    const { run } = await api.run(id);
    setCurrentRun({ id: run.id, status: run.status, exitCode: run.exitCode, config: run.config });
    setActiveTab('pytest');
    connectWs(run.id, run.sources, run.flow);
  };

  // After a page refresh, pick the last viewed run back up (the server keeps runs until it restarts).
  useEffect(() => {
    let id = null;
    try { id = localStorage.getItem('nevis.tests.currentRun'); } catch (_) { /* storage unavailable */ }
    if (id) api.run(id).then(() => openHistoricalRun(id)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!currentRun?.id) return;
    try { localStorage.setItem('nevis.tests.currentRun', currentRun.id); } catch (_) { /* storage unavailable */ }
  }, [currentRun?.id]);

  const tabNames = Object.keys(sources);
  const allEntries = tabNames
    .flatMap((name) => sources[name])
    .sort((a, b) => a.ts - b.ts)
    .map((e) => ({ ...e, line: `[${e.source}] ${e.line}` }));

  const visibleNamespaces = allNamespaces.filter((n) => n.toLowerCase().includes(nsFilter.toLowerCase()));
  const visiblePods = pods.filter((p) => p.name.toLowerCase().includes(podFilter.toLowerCase()));
  const podsByNamespace = visiblePods.reduce((acc, p) => {
    (acc[p.namespace] = acc[p.namespace] || []).push(p);
    return acc;
  }, {});

  const running = currentRun && (currentRun.status === 'running' || currentRun.status === 'starting');

  useEffect(() => {
    if (currentRun?.id) setActiveRun(currentRun.id);
  }, [currentRun?.id]);

  const popOut = (params, key) => {
    if (!currentRun) return;
    if (!openPopout(`run-${currentRun.id}-${key}`, { kind: 'run', run: currentRun.id, ...params })) toast('The browser blocked the new window. Allow pop-ups for this site and try again.', 'error');
  };
  const canRun = namespace.trim() && parseList(labelsText).length > 0 && !starting;

  return (
    <div className="view">
      {sideOpen && (
        <aside className="panel side" style={{ width: sideW }}>
          <div className="panel-head">
            <span className="panel-title">Run configuration</span>
            <IconButton size="sm" icon={<LuPanelLeftClose size={16} />} title="Hide configuration" onClick={() => setSideOpen(false)} />
          </div>

          <div className="panel-scroll">
            <Section title="Scenarios" icon={<LuTags size={15} />} storageKey="tests.sec.scenarios">
              <Field label="Labels" hint="Space or comma separated. Resolves the namespaces that support them.">
                <Combobox multiToken value={labelsText} onChange={setLabelsText} suggestions={labelCatalog} placeholder="e.g. SEK-200288" />
              </Field>
              {(resolving || resolveError || debouncedLabels.trim()) && (
                <div className="resolve-line">
                  {resolving && <span className="muted"><LuLoader size={13} className="spin" /> Resolving…</span>}
                  {!resolving && resolveError && <span className="text-danger">{resolveError}</span>}
                  {!resolving && !resolveError && debouncedLabels.trim() && (
                    <span className={resolution.scenarios.length ? 'text-ok' : 'text-warn'}>
                      {resolution.scenarios.length
                        ? `${resolution.scenarios.length} scenario${resolution.scenarios.length === 1 ? '' : 's'} match · ${resolution.namespaces.join(', ')}`
                        : 'No scenarios match these labels'}
                    </span>
                  )}
                </div>
              )}
              <Field label="Exclusion labels">
                <input className="input" value={exclusionText} onChange={(e) => setExclusionText(e.target.value)} placeholder="eid" spellCheck={false} />
              </Field>
              <AusweisAppControl />
              <Field label="Test namespace">
                <Select
                  value={namespace}
                  onChange={setNamespace}
                  disabled={resolution.namespaces.length === 0}
                  options={resolution.namespaces}
                  placeholder={resolution.namespaces.length ? 'Select namespace' : 'Enter labels first'}
                />
              </Field>
            </Section>

            <Section title="Cluster" icon={<LuServer size={15} />} storageKey="tests.sec.cluster">
              <Field label="Environment">
                <Select
                  value={env}
                  onChange={setEnv}
                  options={[
                    { value: 'dev', label: 'dev', hint: 'direct oc' },
                    { value: 'devtest', label: 'devtest', hint: 'via ssh' },
                  ]}
                />
              </Field>

              {env === 'devtest' && (
                <div className="ssh-fields">
                  <Field label="SSH host"><input className="input" value={sshHost} onChange={(e) => setSshHost(e.target.value)} /></Field>
                  <Field label="SSH user"><input className="input" value={sshUser} onChange={(e) => setSshUser(e.target.value)} /></Field>
                  <Field label="SSH key path"><input className="input" value={sshKeyPath} onChange={(e) => setSshKeyPath(e.target.value)} /></Field>
                  <Field label="Key passphrase (optional)"><input className="input" type="password" value={sshPassphrase} onChange={(e) => setSshPassphrase(e.target.value)} /></Field>
                </div>
              )}

              <Field
                label="Cluster namespaces"
                hint="OC projects whose pods can be tailed."
                right={<IconButton size="xs" icon={<LuRefreshCw size={13} className={nsLoading ? 'spin' : ''} />} title="Refresh namespaces" onClick={() => fetchNamespaces()} disabled={nsLoading} />}
              >
                <div className="search-box">
                  <LuSearch size={14} className="search-box-icon" />
                  <input value={nsFilter} onChange={(e) => setNsFilter(e.target.value)} placeholder="Filter namespaces" spellCheck={false} />
                </div>
                {nsError && <div className="text-danger small">{nsError}</div>}
                <div className="check-list">
                  {visibleNamespaces.map((ns) => (
                    <Checkbox key={ns} className="check-row" checked={selectedNamespaces.has(ns)} onChange={() => toggleNamespace(ns)} label={ns} />
                  ))}
                  {allNamespaces.length === 0 && !nsLoading && <div className="list-hint">Pick a test namespace to auto-load projects.</div>}
                  {allNamespaces.length > 0 && visibleNamespaces.length === 0 && <div className="list-hint">No match for “{nsFilter}”.</div>}
                </div>
              </Field>

              <Field label="Pods to tail" right={podsLoading && <LuLoader size={13} className="spin muted" />}>
                {podsError && <div className="text-danger small">{podsError}</div>}
                <div className="search-box">
                  <LuSearch size={14} className="search-box-icon" />
                  <input value={podFilter} onChange={(e) => setPodFilter(e.target.value)} placeholder="Filter pods" spellCheck={false} />
                </div>
                <div className="check-list">
                  {Object.entries(podsByNamespace).map(([ns, nsPods]) => (
                    <div key={ns} className="check-group">
                      <div className="check-group-title">{ns}</div>
                      {nsPods.map((p) => (
                        <Checkbox
                          key={p.name}
                          className="check-row"
                          checked={selectedPods.has(podKey(ns, p.name))}
                          onChange={() => togglePod(ns, p.name)}
                          label={
                            <>
                              <span className="check-row-name">{p.name}</span>
                              <span className={`pod-status ${p.status === 'Running' ? 'ok' : ''}`}>{p.status}</span>
                            </>
                          }
                        />
                      ))}
                    </div>
                  ))}
                  {pods.length === 0 && !podsLoading && <div className="list-hint">Check a cluster namespace to auto-load its pods.</div>}
                  {pods.length > 0 && visiblePods.length === 0 && <div className="list-hint">No match for “{podFilter}”.</div>}
                </div>
              </Field>
            </Section>

            <Section title="Run history" icon={<LuHistory size={15} />} badge={runs.length || null} defaultOpen={false} storageKey="tests.sec.history">
              <div className="run-history">
                {runs.map((r) => (
                  <button type="button" key={r.id} className={`run-item ${currentRun?.id === r.id ? 'active' : ''}`} onClick={() => openHistoricalRun(r.id)}>
                    <StatusDot status={r.status} />
                    <span className="run-item-time">{new Date(r.createdAt).toLocaleTimeString()}</span>
                    <span className="run-item-labels">{(r.config.labels || []).join(', ')}</span>
                    <span className="run-item-ns">{r.config.namespace}</span>
                  </button>
                ))}
                {runs.length === 0 && <div className="list-hint">No runs yet.</div>}
              </div>
            </Section>
          </div>

          <Sash edge="end" size={sideW} onSize={setSideW} onReset={resetSideW} />
        </aside>
      )}

      <section className="workspace">
        <div className="tabstrip">
          {!sideOpen && <IconButton size="sm" icon={<LuPanelLeftOpen size={16} />} title="Show configuration" onClick={() => setSideOpen(true)} />}
          <Segmented
            size="sm"
            block={false}
            value={mainView}
            onChange={setMainView}
            options={[
              { value: 'flow', label: 'Scenario flow', icon: <LuWorkflow size={14} />, count: flow.length || undefined },
              { value: 'logs', label: 'Logs', icon: <LuTerminal size={14} /> },
              { value: 'traces', label: 'Traces', icon: <LuWaypoints size={14} />, count: runTraces.traces.length || undefined },
            ]}
          />
          <span className="spacer" />
          {currentRun ? (
            <div className={`run-pill s-${currentRun.status}`}>
              <StatusDot status={currentRun.status} />
              <span>
                Run {currentRun.id.slice(0, 8)} · {currentRun.status}
                {currentRun.exitCode !== null && currentRun.exitCode !== undefined ? ` (exit ${currentRun.exitCode})` : ''}
              </span>
            </div>
          ) : (
            <span className="muted">No run yet</span>
          )}
          {currentRun && (
            <MenuButton
              className="btn sm"
              icon={<LuSquareArrowOutUpRight size={14} />}
              label="Pop out"
              title="Open this run's output in a separate window, e.g. on another screen"
              items={[
                { key: 'h', heading: 'Open in a separate window' },
                { key: 'logs', label: activeTab === 'all' ? 'All logs' : `Logs: ${activeTab}`, onClick: () => popOut({ view: 'logs', source: activeTab, only: '1' }, `logs-${activeTab}`) },
                { key: 'all', label: 'Everything (logs, flow, traces)', hint: shortcutLabel('L'), onClick: () => popOut({ view: 'logs' }, 'all') },
                { key: 'flow', label: 'Scenario flow', onClick: () => popOut({ view: 'flow' }, 'flow') },
                { key: 'traces', label: 'Traces', onClick: () => popOut({ view: 'traces' }, 'traces') },
              ]}
            />
          )}
          {running ? (
            <button type="button" className="btn danger" onClick={stopRun}>
              <LuSquare size={13} /> Stop
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={startRun} disabled={!canRun} title={canRun ? 'Run the matching scenarios through pytest' : 'Enter labels and pick a test namespace first'}>
              {starting ? <LuLoader size={14} className="spin" /> : <LuPlay size={14} />}
              <span>{starting ? 'Starting…' : 'Run tests'}</span>
            </button>
          )}
        </div>
        {startError && <div className="notice danger banner"><LuCircleAlert size={15} /><div>{startError}</div></div>}

        <TraceLinkContext.Provider value={traceLinks}>
        {mainView === 'traces' ? (
          <TracesPanel runTraces={runTraces} focus={traceFocus} />
        ) : tabNames.length === 0 ? (
          <EmptyState icon={<LuTerminal size={26} />} title="No run selected">
            Configure the run on the left and press <b>Run tests</b> to stream logs here in real time.
          </EmptyState>
        ) : mainView === 'flow' ? (
          <ScenarioFlow tests={flow} pytestEntries={sources.pytest || []} />
        ) : (
          <>
            <div className="subtabs">
              <button className={activeTab === 'all' ? 'subtab active' : 'subtab'} onClick={() => setActiveTab('all')}>
                all <em>{allEntries.length}</em>
              </button>
              {tabNames.map((name) => (
                <button key={name} className={activeTab === name ? 'subtab active' : 'subtab'} onClick={() => setActiveTab(name)}>
                  {name} <em>{sources[name].length}</em>
                </button>
              ))}
            </div>
            {activeTab === 'all' ? (
              <LogPanel title="all" entries={allEntries} onPopout={currentRun ? () => popOut({ view: 'logs', source: 'all', only: '1' }, 'logs-all') : undefined} />
            ) : (
              <LogPanel key={activeTab} title={activeTab} entries={sources[activeTab] || []} onPopout={currentRun ? () => popOut({ view: 'logs', source: activeTab, only: '1' }, `logs-${activeTab}`) : undefined} />
            )}
          </>
        )}
        </TraceLinkContext.Provider>
        {traceSheet && (
          <TraceSheet
            runTraces={runTraces}
            target={traceSheet}
            onClose={() => setTraceSheet(null)}
            onExpand={() => { setTraceFocus({ ...traceSheet, nonce: Date.now() }); setMainView('traces'); setTraceSheet(null); }}
          />
        )}
      </section>
    </div>
  );
}
