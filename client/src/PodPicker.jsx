import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LuLoader, LuRefreshCw, LuSearch } from 'react-icons/lu';
import { api } from './api.js';
import { useOnOcLogin } from './OcSession.jsx';
import { Checkbox, Field, IconButton, Switch } from './ui.jsx';

// Optional pod log tailing for a test run: pick cluster namespaces (OC projects), then the pods whose
// logs should stream next to pytest's output. Nothing is fetched until it is switched on.
// `value` is a Set of "namespace::pod" keys; the parent turns it into [{ namespace, name }].
export const podKey = (ns, name) => `${ns}::${name}`;
export const podsFromKeys = (keys) => [...keys].map((k) => { const [namespace, name] = k.split('::'); return { namespace, name }; });

export default function PodPicker({ testNamespace, value, onChange }) {
  const [on, setOn] = useState(false);
  const [projects, setProjects] = useState([]);
  const [chosen, setChosen] = useState(new Set());
  const [pods, setPods] = useState([]);
  const [filter, setFilter] = useState('');
  const [podFilter, setPodFilter] = useState('');
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingPods, setLoadingPods] = useState(false);
  const [error, setError] = useState('');

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    setError('');
    try {
      const { projects: list } = await api.projects({ env: 'dev' });
      setProjects(list);
      // like Run tests: the OC project named like the test namespace is the natural first pick
      setChosen((cur) => (cur.size ? cur : list.includes(testNamespace) ? new Set([testNamespace]) : cur));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingProjects(false);
    }
  }, [testNamespace]);

  const loadPods = useCallback(async () => {
    if (!chosen.size) { setPods([]); return; }
    setLoadingPods(true);
    setError('');
    try {
      const { pods: list, errors } = await api.pods({ env: 'dev', namespaces: [...chosen] });
      setPods(list);
      if (errors && errors.length) setError(errors.map((e) => `${e.namespace}: ${e.message}`).join('; '));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingPods(false);
    }
  }, [chosen]);

  useEffect(() => { if (on && !projects.length) loadProjects(); }, [on, projects.length, loadProjects]);
  useEffect(() => {
    if (!on) return undefined;
    const t = setTimeout(loadPods, 200);
    return () => clearTimeout(t);
  }, [on, chosen, loadPods]);
  useEffect(() => { if (!on) onChange(new Set()); }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  useOnOcLogin(() => { if (on) { loadProjects(); loadPods(); } });

  const shownProjects = useMemo(() => projects.filter((p) => p.toLowerCase().includes(filter.toLowerCase())), [projects, filter]);
  const shownPods = useMemo(() => pods.filter((p) => p.name.toLowerCase().includes(podFilter.toLowerCase())), [pods, podFilter]);
  const byNs = useMemo(() => shownPods.reduce((acc, p) => { (acc[p.namespace] = acc[p.namespace] || []).push(p); return acc; }, {}), [shownPods]);
  const toggle = (set, setter, key) => { const next = new Set(set); if (next.has(key)) next.delete(key); else next.add(key); setter(next); };

  return (
    <div className="podpick">
      <Switch checked={on} onChange={setOn} label="Also tail pod logs (read-only)" title="Streams the selected pods' logs into the test run, next to pytest's output" />
      {on && (
        <div className="stack tight">
          <Field label="Cluster namespaces" right={<IconButton size="xs" icon={<LuRefreshCw size={13} className={loadingProjects ? 'spin' : ''} />} title="Refresh" onClick={loadProjects} disabled={loadingProjects} />}>
            <div className="search-box">
              <LuSearch size={14} className="search-box-icon" />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter namespaces" spellCheck={false} />
            </div>
            <div className="check-list short">
              {shownProjects.map((ns) => <Checkbox key={ns} className="check-row" checked={chosen.has(ns)} onChange={() => toggle(chosen, setChosen, ns)} label={ns} />)}
              {!projects.length && !loadingProjects && <div className="list-hint">No projects loaded.</div>}
              {!!projects.length && !shownProjects.length && <div className="list-hint">No match for “{filter}”.</div>}
            </div>
          </Field>
          <Field label="Pods to tail" right={loadingPods && <LuLoader size={13} className="spin muted" />}>
            {!!pods.length && (
              <div className="search-box">
                <LuSearch size={14} className="search-box-icon" />
                <input value={podFilter} onChange={(e) => setPodFilter(e.target.value)} placeholder="Filter pods" spellCheck={false} />
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
