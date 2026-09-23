import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api, wsUrl } from './api.js';
import LogPanel from './LogPanel.jsx';
import ScenarioFlow from './ScenarioFlow.jsx';
import { LuCircleAlert, LuFileText, LuFolderOpen, LuHistory, LuLoader, LuPanelLeftClose, LuPanelLeftOpen, LuPlay, LuRefreshCw, LuSearch, LuServer, LuSquare, LuSquareArrowOutUpRight, LuTags, LuTerminal, LuWorkflow } from 'react-icons/lu';
import OutputFiles from './OutputFiles.jsx';
import AusweisAppControl from './AusweisAppControl.jsx';
import ReportFlow from './Report.jsx';
import { TracesPanel, TraceSheet, TraceLinkContext, useRunTraces } from './tracing.jsx';
import { LuWaypoints } from 'react-icons/lu';
import { useOnOcLogin } from './OcSession.jsx';
import { openPopout, setActiveRun, shortcutLabel } from './popout.js';
import { Checkbox, Combobox, EmptyState, Field, IconButton, Sash, Section, MenuButton, Segmented, Select, usePanelSize, useLocalState, useToast, StatusDot } from './ui.jsx';
import { nsCacheKey, podCacheKey, readCache, writeCache } from './clusterCache.js';

const DEBOUNCE_MS = 450;
const finished = (r) => r && !['starting', 'running'].includes(r.status);

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

// A dev's chosen "which namespaces/pods to tail logs from" is cluster-wide housekeeping, not part
// of any one test run - restore it from where they left it instead of making them re-check the
// same boxes every time they open Run tests.
function loadStoredKeys(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (_) {
    return new Set();
  }
}

export default function TestsView() {
  const toast = useToast();
  const [env, setEnv] = useLocalState('tests.env', 'dev');
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
  const [allNamespaces, setAllNamespaces] = useState(() => readCache(nsCacheKey(env)) || []);
  const [selectedNamespaces, setSelectedNamespaces] = useState(() => loadStoredKeys('nevis.tests.selectedNamespaces'));
  const [nsLoading, setNsLoading] = useState(false);
  const [nsError, setNsError] = useState('');

  const [pods, setPods] = useState([]);
  const [selectedPods, setSelectedPods] = useState(() => loadStoredKeys('nevis.tests.selectedPods'));
  const [podsLoading, setPodsLoading] = useState(false);
  const [podsError, setPodsError] = useState('');

  useEffect(() => {
    try { localStorage.setItem('nevis.tests.selectedNamespaces', JSON.stringify([...selectedNamespaces])); } catch (_) { /* storage unavailable */ }
  }, [selectedNamespaces]);
  useEffect(() => {
    try { localStorage.setItem('nevis.tests.selectedPods', JSON.stringify([...selectedPods])); } catch (_) { /* storage unavailable */ }
  }, [selectedPods]);

  const [runs, setRuns] = useState([]);
  const [currentRun, setCurrentRun] = useState(null); // {id, status, exitCode, config}
  const [sources, setSources] = useState({}); // sourceName -> entries[]
  const [flow, setFlow] = useState([]); // scenario re-runs already swapped in server-side - see runManager's `_mergedFlow`
  const rerunOutcomes = useRef({}); // scenarioName -> last-seen outcome of its re-run, just to toast on a transition
  const [activeTab, setActiveTab] = useState('pytest');
  const [mainView, setMainView] = useState('flow'); // 'flow' | 'logs' | 'traces'
  const [reportOpen, setReportOpen] = useState(false);
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

  // A namespace/pod list barely changes, so it's cached (see clusterCache.js) and reused as-is -
  // fetchNamespaces/fetchPods only hit the cluster on first-ever use, an explicit refresh
  // (`force: true`), or when a fetch actually fails (a real sign the cache is stale).
  const fetchNamespaces = useCallback(
    async (autoSelect, { force = false } = {}) => {
      const key = nsCacheKey(env);
      if (!force) {
        const cached = readCache(key);
        if (cached) {
          setAllNamespaces(cached);
          setNsError('');
          if (autoSelect && cached.includes(autoSelect)) setSelectedNamespaces(new Set([autoSelect]));
          return;
        }
      }
      setNsError('');
      setNsLoading(true);
      try {
        const cfg = { env, ...(env === 'devtest' ? { ssh: sshCfg() } : {}) };
        const { projects } = await api.projects(cfg);
        setAllNamespaces(projects);
        writeCache(key, projects);
        if (autoSelect && projects.includes(autoSelect)) {
          setSelectedNamespaces(new Set([autoSelect]));
        } else {
          // A fresh fetch is authoritative - drop any selected namespace that's gone, instead of
          // leaving a ghost selection with no checkbox to ever uncheck it from.
          setSelectedNamespaces((prev) => {
            const pruned = new Set([...prev].filter((ns) => projects.includes(ns)));
            return pruned.size === prev.size ? prev : pruned;
          });
        }
      } catch (err) {
        setNsError(err.message);
      } finally {
        setNsLoading(false);
      }
    },
    [env, sshHost, sshUser, sshKeyPath, sshPassphrase]
  );

  // Reloads from that environment's own cache (not the network) the moment the Environment
  // dropdown changes, so switching dev <-> devtest shows what was last seen there instantly.
  useEffect(() => {
    setAllNamespaces(readCache(nsCacheKey(env)) || []);
  }, [env]);

  // Step 2 of the auto-chain: once a test namespace is picked, go find the matching oc project(s)
  // automatically - cache-first, so this is instant once anything has been fetched before.
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

  const fetchPods = useCallback(
    async ({ force = false } = {}) => {
      if (selectedNamespaces.size === 0) {
        setPods([]);
        return;
      }
      const nsList = [...selectedNamespaces];
      const toFetch = force ? nsList : nsList.filter((ns) => readCache(podCacheKey(env, ns)) === null);
      const fromCache = nsList.filter((ns) => !toFetch.includes(ns)).flatMap((ns) => readCache(podCacheKey(env, ns)) || []);
      if (!toFetch.length) {
        setPods(fromCache);
        setPodsError('');
        return;
      }
      setPodsError('');
      setPodsLoading(true);
      try {
        const cfg = { env, namespaces: toFetch, ...(env === 'devtest' ? { ssh: sshCfg() } : {}) };
        const { pods: fetched, errors } = await api.pods(cfg);
        for (const ns of toFetch) writeCache(podCacheKey(env, ns), fetched.filter((p) => p.namespace === ns));
        setPods([...fromCache, ...fetched]);
        // A namespace just (re)fetched is authoritative now - drop any selected pod in it that
        // isn't there anymore (rescheduled under a new name, or gone), instead of leaving a ghost
        // selection with no checkbox to ever uncheck it from.
        const freshKeys = new Set(fetched.map((p) => podKey(p.namespace, p.name)));
        setSelectedPods((prev) => {
          const pruned = new Set([...prev].filter((k) => !toFetch.includes(k.split('::')[0]) || freshKeys.has(k)));
          return pruned.size === prev.size ? prev : pruned;
        });
        if (errors && errors.length) {
          setPodsError(errors.map((e) => `${e.namespace}: ${e.message}`).join('; '));
        }
      } catch (err) {
        setPodsError(err.message);
      } finally {
        setPodsLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [env, sshHost, sshUser, sshKeyPath, sshPassphrase, selectedNamespaces]
  );

  // Step 3 of the auto-chain: pods load themselves the moment a namespace is checked - no
  // separate "fetch pods" click required. Cache-first (see fetchPods), so re-checking a namespace
  // whose pods are already cached is instant, no network round trip.
  useEffect(() => {
    const t = setTimeout(() => fetchPods(), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNamespaces, env]);

  // Namespaces/pods restored from a previous session (see loadStoredKeys above) still need
  // something to render the checkboxes against - cache-first, so this only reaches the network
  // the very first time the dashboard is used.
  useEffect(() => {
    if (!namespace) fetchNamespaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // after logging in again, reload what the expired login could not fetch - a real sign
  // whatever's cached needs a fresh look, so this bypasses the cache.
  useOnOcLogin(() => {
    fetchNamespaces(undefined, { force: true });
    fetchPods({ force: true });
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
    rerunOutcomes.current = {};
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
      setCurrentRun({ id: run.id, status: run.status, exitCode: run.exitCode, config: run.config, createdAt: run.createdAt });
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

  // Re-runs one scenario out of the current run (pytest's own -k, matched against the scenario's
  // name) as its own background run, `replaces`-linked to it - the server persists that link on
  // the current run itself and swaps the result into its flow (see runManager's `_mergedFlow`),
  // cleared to "running" the instant it's registered, then live as the re-run progresses, same as
  // any other flow update over this run's existing subscription.
  const rerunScenario = async (name) => {
    if (!currentRun || running) return;
    try {
      const cfg = currentRun.config;
      await api.startRun({
        env: cfg.env,
        namespace: cfg.namespace,
        labels: cfg.labels,
        exclusionLabels: cfg.exclusionLabels,
        pods: cfg.pods || [],
        keyword: name,
        replaces: { runId: currentRun.id, scenarioName: name },
        ...(cfg.env === 'devtest' ? { ssh: sshCfg() } : {}),
      });
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  // Toast once a re-run visible in `flow` (via the websocket subscription above) settles - a
  // pure side effect of the outcome changing, not something this view drives itself.
  useEffect(() => {
    for (const t of flow) {
      if (!t._rerun || !t.scenarioName) continue;
      const prev = rerunOutcomes.current[t.scenarioName];
      if (prev !== undefined && prev === null && t.outcome !== null) {
        toast(`Re-run finished: ${t.scenarioName} — ${t.outcome}`, t.outcome === 'passed' ? 'ok' : 'error');
      }
      rerunOutcomes.current[t.scenarioName] = t.outcome;
    }
  }, [flow, toast]);

  const anyRerunning = flow.some((t) => t._rerun && t.outcome === null);

  const openHistoricalRun = async (id) => {
    const { run } = await api.run(id);
    setCurrentRun({ id: run.id, status: run.status, exitCode: run.exitCode, config: run.config, createdAt: run.createdAt });
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
  // A cached list can go stale on its own (a namespace removed, a pod rescheduled under a new
  // name) without any fetch ever failing - flagged here instead, so it's visible at a glance
  // rather than only discovered when a run actually tries to tail a pod that's gone.
  const staleNamespaces = allNamespaces.length ? [...selectedNamespaces].filter((ns) => !allNamespaces.includes(ns)) : [];
  const knownPodKeys = new Set(pods.map((p) => podKey(p.namespace, p.name)));
  const stalePods = podsLoading ? [] : [...selectedPods].filter((k) => !knownPodKeys.has(k));

  const running = currentRun && (currentRun.status === 'running' || currentRun.status === 'starting');

  useEffect(() => {
    if (currentRun?.id) setActiveRun(currentRun.id);
  }, [currentRun?.id]);

  const popOut = (params, key) => {
    if (!currentRun) return;
    if (!openPopout(`run-${currentRun.id}-${key}`, { kind: 'run', run: currentRun.id, ...params })) toast('The browser blocked the new window. Allow pop-ups for this site and try again.', 'error');
  };
  const canRun = namespace.trim() && parseList(labelsText).length > 0 && !starting && !anyRerunning;

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
                hint="OC projects whose pods can be tailed. Remembered - refresh only if one you need is missing."
                right={<IconButton size="xs" icon={<LuRefreshCw size={13} className={nsLoading ? 'spin' : ''} />} title="Refresh from the cluster" onClick={() => fetchNamespaces(undefined, { force: true })} disabled={nsLoading} />}
              >
                <div className="search-box">
                  <LuSearch size={14} className="search-box-icon" />
                  <input value={nsFilter} onChange={(e) => setNsFilter(e.target.value)} placeholder="Filter namespaces" spellCheck={false} />
                </div>
                {nsError && <div className="text-danger small">{nsError}</div>}
                {staleNamespaces.length > 0 && (
                  <div className="notice warn small">
                    <LuCircleAlert size={13} />
                    <div>{staleNamespaces.join(', ')} {staleNamespaces.length === 1 ? "isn't" : "aren't"} in the cluster's project list anymore — hit refresh above.</div>
                  </div>
                )}
                <div className="check-list">
                  {visibleNamespaces.map((ns) => (
                    <Checkbox key={ns} className="check-row" checked={selectedNamespaces.has(ns)} onChange={() => toggleNamespace(ns)} label={ns} />
                  ))}
                  {allNamespaces.length === 0 && !nsLoading && <div className="list-hint">Pick a test namespace to auto-load projects.</div>}
                  {allNamespaces.length > 0 && visibleNamespaces.length === 0 && <div className="list-hint">No match for “{nsFilter}”.</div>}
                </div>
              </Field>

              <Field
                label="Pods to tail"
                hint="Remembered per namespace - refresh only if a pod you tailed before is missing."
                right={
                  <>
                    {podsLoading && <LuLoader size={13} className="spin muted" />}
                    <IconButton size="xs" icon={<LuRefreshCw size={13} />} title="Refresh from the cluster" onClick={() => fetchPods({ force: true })} disabled={podsLoading || !selectedNamespaces.size} />
                  </>
                }
              >
                {podsError && <div className="text-danger small">{podsError}</div>}
                {stalePods.length > 0 && (
                  <div className="notice warn small">
                    <LuCircleAlert size={13} />
                    <div>{stalePods.length} tailed pod{stalePods.length === 1 ? '' : 's'} no longer {stalePods.length === 1 ? 'exists' : 'exist'} (likely rescheduled) — hit refresh above.</div>
                  </div>
                )}
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
              { value: 'output', label: 'Output', icon: <LuFolderOpen size={14} /> },
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
          {finished(currentRun) && (
            <button type="button" className="btn sm" onClick={() => setReportOpen(true)} disabled={anyRerunning} title={anyRerunning ? 'Wait for the scenario re-run to finish first' : 'Build a print-ready PDF of this run, for a ticket or release mail'}>
              <LuFileText size={14} /> Generate report <span className="badge">Beta</span>
            </button>
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
        ) : mainView === 'output' ? (
          currentRun ? <OutputFiles runId={currentRun.id} since={currentRun.createdAt} /> : (
            <EmptyState icon={<LuFolderOpen size={26} />} title="No run selected">
              Configure the run on the left and press <b>Run tests</b> to see what it wrote to output/.
            </EmptyState>
          )
        ) : tabNames.length === 0 ? (
          <EmptyState icon={<LuTerminal size={26} />} title="No run selected">
            Configure the run on the left and press <b>Run tests</b> to stream logs here in real time.
          </EmptyState>
        ) : mainView === 'flow' ? (
          <ScenarioFlow tests={flow} pytestEntries={sources.pytest || []} onRerun={rerunScenario} />
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
        {reportOpen && currentRun && <ReportFlow run={currentRun} onClose={() => setReportOpen(false)} />}
      </section>
    </div>
  );
}
