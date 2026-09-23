import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LuCircleAlert, LuLoader, LuRefreshCw, LuSearch } from 'react-icons/lu';
import { api } from './api.js';
import { useOnOcLogin } from './OcSession.jsx';
import { Checkbox, Field, IconButton, Switch } from './ui.jsx';
import { nsCacheKey, podCacheKey, readCache, writeCache } from './clusterCache.js';

// The Test scenario modal only ever runs against dev directly (same as before this cache was added).
const PICKER_ENV = 'dev';

// Optional pod log tailing for a test run: pick cluster namespaces (OC projects), then the pods whose
// logs should stream next to pytest's output. A namespace/pod list barely changes, so it's cached
// (see clusterCache.js) and the dev's own choice of namespaces (any number, not just the test's own
// one) and pods is remembered across runs - nothing is re-picked just because this modal was closed
// and reopened, or the scenario was rerun with the same test namespace. Two things override that:
// nothing has ever been picked yet (falls back to ticking the OC project named like the scenario's
// own test namespace, so a first-time dev isn't left with an empty list to fill in by hand), or the
// "Run against namespace" dropdown actually changes mid-dialog (drops the old namespace/pod pick
// entirely and lands on the newly chosen namespace instead - see the effect below).
export const podKey = (ns, name) => `${ns}::${name}`;
export const podsFromKeys = (keys) => [...keys].map((k) => { const [namespace, name] = k.split('::'); return { namespace, name }; });

function loadStoredKeys(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (_) {
    return new Set();
  }
}

export default function PodPicker({ testNamespace, on, onToggle, value, onChange }) {
  const [projects, setProjects] = useState(() => readCache(nsCacheKey(PICKER_ENV)) || []);
  const [chosen, setChosen] = useState(() => loadStoredKeys('nevis.podpicker.namespaces'));
  const [pods, setPods] = useState([]);
  const [filter, setFilter] = useState('');
  const [podFilter, setPodFilter] = useState('');
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingPods, setLoadingPods] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    try { localStorage.setItem('nevis.podpicker.namespaces', JSON.stringify([...chosen])); } catch (_) { /* storage unavailable */ }
  }, [chosen]);

  const loadProjects = useCallback(
    async ({ force = false } = {}) => {
      if (!force) {
        const cached = readCache(nsCacheKey(PICKER_ENV));
        if (cached) {
          setProjects(cached);
          return;
        }
      }
      setLoadingProjects(true);
      setError('');
      try {
        const { projects: list } = await api.projects({ env: PICKER_ENV });
        setProjects(list);
        writeCache(nsCacheKey(PICKER_ENV), list);
        setChosen((cur) => {
          // a fresh fetch is authoritative - drop any selected namespace that's gone, instead of
          // leaving a ghost selection with no checkbox to ever uncheck it from
          const pruned = new Set([...cur].filter((ns) => list.includes(ns)));
          return pruned.size === cur.size ? cur : pruned;
        });
      } catch (e) {
        setError(e.message);
      } finally {
        setLoadingProjects(false);
      }
    },
    []
  );

  const loadPods = useCallback(
    async ({ force = false } = {}) => {
      if (!chosen.size) {
        setPods([]);
        return;
      }
      const nsList = [...chosen];
      const toFetch = force ? nsList : nsList.filter((ns) => readCache(podCacheKey(PICKER_ENV, ns)) === null);
      const fromCache = nsList.filter((ns) => !toFetch.includes(ns)).flatMap((ns) => readCache(podCacheKey(PICKER_ENV, ns)) || []);
      if (!toFetch.length) {
        setPods(fromCache);
        setError('');
        return;
      }
      setLoadingPods(true);
      setError('');
      try {
        const { pods: fetched, errors } = await api.pods({ env: PICKER_ENV, namespaces: toFetch });
        for (const ns of toFetch) writeCache(podCacheKey(PICKER_ENV, ns), fetched.filter((p) => p.namespace === ns));
        setPods([...fromCache, ...fetched]);
        // A namespace just (re)fetched is authoritative now - drop any selected pod in it that
        // isn't there anymore (rescheduled under a new name, or gone), instead of leaving a ghost
        // selection with no checkbox to ever uncheck it from.
        const freshKeys = new Set(fetched.map((p) => podKey(p.namespace, p.name)));
        const pruned = new Set([...value].filter((k) => !toFetch.includes(k.split('::')[0]) || freshKeys.has(k)));
        if (pruned.size !== value.size) onChange(pruned);
        if (errors && errors.length) setError(errors.map((e) => `${e.namespace}: ${e.message}`).join('; '));
      } catch (e) {
        setError(e.message);
      } finally {
        setLoadingPods(false);
      }
    },
    [chosen, value, onChange]
  );

  useEffect(() => { if (on && !projects.length) loadProjects(); }, [on, projects.length, loadProjects]);
  // First-ever use (chosen is still empty - nothing stored, nothing picked this session): tick the
  // OC project named like the scenario's own test namespace, so there's not an empty list to fill
  // in by hand. Runs off projects/testNamespace directly (not loadProjects) because projects can
  // already be cache-warm at mount, in which case loadProjects's own effect below never fires.
  // Once the dev has picked anything - one namespace or several - this leaves it alone; that pick
  // is remembered across reruns and reopens, same as the pods ticked per namespace already are.
  useEffect(() => {
    if (testNamespace && projects.includes(testNamespace)) {
      setChosen((cur) => (cur.size ? cur : new Set([testNamespace])));
    }
  }, [testNamespace, projects]);
  // But actually switching the "Run against namespace" dropdown mid-dialog is a different case
  // from opening the dialog: whatever was ticked (one namespace or several, sticky from a previous
  // run) no longer describes what's actually being tested, and neither do the pods ticked under
  // it - a pod remembered under the old namespace almost certainly doesn't exist under the new one.
  // So a real change (not the initial mount - prevTestNamespace starts equal to it, so that doesn't
  // count as one) drops both and lands on just the newly picked namespace, pods still empty until
  // they're fetched and ticked fresh.
  const prevTestNamespace = useRef(testNamespace);
  useEffect(() => {
    if (testNamespace === prevTestNamespace.current) return;
    prevTestNamespace.current = testNamespace;
    setChosen(testNamespace ? new Set([testNamespace]) : new Set());
    onChange(new Set());
  }, [testNamespace, onChange]);
  useEffect(() => {
    if (!on) return undefined;
    const t = setTimeout(() => loadPods(), 200);
    return () => clearTimeout(t);
  }, [on, chosen, loadPods]);
  // Switching this off no longer wipes the pod selection (TestModal just skips sending pods while
  // off) - flipping it on and off to re-check something shouldn't cost the dev their picks.
  useOnOcLogin(() => { if (on) { loadProjects({ force: true }); loadPods({ force: true }); } });

  const shownProjects = useMemo(() => projects.filter((p) => p.toLowerCase().includes(filter.toLowerCase())), [projects, filter]);
  const shownPods = useMemo(() => pods.filter((p) => p.name.toLowerCase().includes(podFilter.toLowerCase())), [pods, podFilter]);
  const byNs = useMemo(() => shownPods.reduce((acc, p) => { (acc[p.namespace] = acc[p.namespace] || []).push(p); return acc; }, {}), [shownPods]);
  const toggle = (set, setter, key) => { const next = new Set(set); if (next.has(key)) next.delete(key); else next.add(key); setter(next); };

  const staleNamespaces = projects.length ? [...chosen].filter((ns) => !projects.includes(ns)) : [];
  const knownPodKeys = useMemo(() => new Set(pods.map((p) => podKey(p.namespace, p.name))), [pods]);
  const stalePods = loadingPods ? [] : [...value].filter((k) => !knownPodKeys.has(k));

  return (
    <div className="podpick">
      <Switch checked={on} onChange={onToggle} label="Also tail pod logs (read-only)" title="Streams the selected pods' logs into the test run, next to pytest's output" />
      {on && (
        <div className="stack tight">
          <Field
            label="Cluster namespaces"
            hint="Remembered - refresh only if one you need is missing."
            right={<IconButton size="xs" icon={<LuRefreshCw size={13} className={loadingProjects ? 'spin' : ''} />} title="Refresh from the cluster" onClick={() => loadProjects({ force: true })} disabled={loadingProjects} />}
          >
            <div className="search-box">
              <LuSearch size={14} className="search-box-icon" />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter namespaces" spellCheck={false} />
            </div>
            {staleNamespaces.length > 0 && (
              <div className="notice warn small">
                <LuCircleAlert size={13} />
                <div>{staleNamespaces.join(', ')} {staleNamespaces.length === 1 ? "isn't" : "aren't"} in the cluster's project list anymore — refresh above.</div>
              </div>
            )}
            <div className="check-list short">
              {shownProjects.map((ns) => <Checkbox key={ns} className="check-row" checked={chosen.has(ns)} onChange={() => toggle(chosen, setChosen, ns)} label={ns} />)}
              {!projects.length && !loadingProjects && <div className="list-hint">No projects loaded.</div>}
              {!!projects.length && !shownProjects.length && <div className="list-hint">No match for “{filter}”.</div>}
            </div>
          </Field>
          <Field
            label="Pods to tail"
            hint="Remembered per namespace - refresh only if a pod you tailed before is missing."
            right={
              <>
                {loadingPods && <LuLoader size={13} className="spin muted" />}
                <IconButton size="xs" icon={<LuRefreshCw size={13} />} title="Refresh from the cluster" onClick={() => loadPods({ force: true })} disabled={loadingPods || !chosen.size} />
              </>
            }
          >
            {!!pods.length && (
              <div className="search-box">
                <LuSearch size={14} className="search-box-icon" />
                <input value={podFilter} onChange={(e) => setPodFilter(e.target.value)} placeholder="Filter pods" spellCheck={false} />
              </div>
            )}
            {stalePods.length > 0 && (
              <div className="notice warn small">
                <LuCircleAlert size={13} />
                <div>{stalePods.length} tailed pod{stalePods.length === 1 ? '' : 's'} no longer {stalePods.length === 1 ? 'exists' : 'exist'} (likely rescheduled) — refresh above.</div>
              </div>
            )}
            <div className="check-list short">
              {Object.entries(byNs).map(([ns, list]) => (
                <div key={ns} className="check-group">
                  <div className="check-group-title">{ns}</div>
                  {list.map((p) => (
                    <Checkbox
                      key={p.name}
                      className="check-row"
                      checked={value.has(podKey(ns, p.name))}
                      onChange={() => toggle(value, onChange, podKey(ns, p.name))}
                      label={<><span className="check-row-name">{p.name}</span><span className={`pod-status ${p.status === 'Running' ? 'ok' : ''}`}>{p.status}</span></>}
                    />
                  ))}
                </div>
              ))}
              {!pods.length && !loadingPods && <div className="list-hint">Tick a namespace to list its pods.</div>}
              {!!pods.length && !shownPods.length && <div className="list-hint">No match for “{podFilter}”.</div>}
            </div>
          </Field>
          {error && <div className="text-danger small">{error}</div>}
        </div>
      )}
    </div>
  );
}
