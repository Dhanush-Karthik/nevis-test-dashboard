'use strict';

// Global search across everything the dashboard knows about: project files and scenarios, labels, workflow /
// endpoint blocks, default configs, .env variable NAMES (never values), runs, traces, git. Read-only.
// Each result carries a `nav` the client uses to jump to the right place.

const explorer = require('./explorer');
const testBuilder = require('./testBuilder');
const defaultsConfig = require('./defaultsConfig');
const envFile = require('./envFile');
const gitApi = require('./git');
const tempo = require('./tempo');

const PER_GROUP = 8;

const GROUPS = [
  { id: 'files', label: 'Files' },
  { id: 'scenarios', label: 'Scenarios' },
  { id: 'labels', label: 'Labels' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'endpoints', label: 'Endpoints' },
  { id: 'defaults', label: 'Default configs' },
  { id: 'env', label: '.env variables' },
  { id: 'runs', label: 'History' },
  { id: 'traces', label: 'Traces' },
  { id: 'spans', label: 'Spans' },
  { id: 'git', label: 'Git' },
];

const has = (v, needle) => v !== undefined && v !== null && String(v).toLowerCase().includes(needle);
const any = (needle, ...vals) => vals.some((v) => (Array.isArray(v) ? v.some((x) => has(x, needle)) : has(v, needle)));

async function search(rawQuery, runManager) {
  const q = String(rawQuery || '').trim().toLowerCase();
  const out = new Map(GROUPS.map((g) => [g.id, { ...g, items: [], total: 0 }]));
  const add = (group, item) => {
    const g = out.get(group);
    g.total += 1;
    if (g.items.length < PER_GROUP) g.items.push({ group, ...item });
  };
  if (q.length < 2) return { query: q, groups: [] };

  const safe = async (fn) => { try { await fn(); } catch (_) { /* a source that is unavailable just contributes nothing */ } };

  await safe(() => {
    const files = explorer.tree();
    const labelIndex = new Map();
    for (const f of files) {
      if (has(f.relPath, q)) add('files', { title: f.relPath.split('/').pop(), sub: `${f.relPath} · ${f.scenarios.length} scenario${f.scenarios.length === 1 ? '' : 's'}`, nav: { section: 'explorer', file: f.relPath } });
      for (const s of f.scenarios) {
        for (const l of s.labels) {
          const e = labelIndex.get(l) || labelIndex.set(l, { scenarios: 0, files: new Set() }).get(l);
          e.scenarios += 1;
          e.files.add(f.relPath);
        }
        if (any(q, s.name, s.labels)) add('scenarios', { title: s.name || `Scenario ${s.index + 1}`, sub: `${f.relPath.split('/').pop()}${s.labels.length ? ` · ${s.labels.slice(0, 4).join(', ')}` : ''}`, nav: { section: 'explorer', file: f.relPath, scenario: s.index } });
      }
    }
    for (const [label, e] of labelIndex) {
      if (has(label, q)) add('labels', { title: label, sub: `${e.scenarios} scenario${e.scenarios === 1 ? '' : 's'} in ${e.files.size} file${e.files.size === 1 ? '' : 's'}`, nav: { section: 'explorer', treeQuery: label } });
    }
  });

  await safe(() => {
    const { workflows, endpoints } = testBuilder.getCatalogPayload();
    for (const w of workflows) {
      if (any(q, w.name, w.labels, w.source, w.def.flow, w.def.method_ident, w.def.method_auth)) add('workflows', { title: w.name, sub: `${[w.def.flow, w.def.method_ident || w.def.method_auth].filter(Boolean).join(' · ')} · ${w.source.split('/').pop()}`, nav: { section: 'explorer', library: { kind: 'workflow', query: w.name } } });
    }
    for (const e of endpoints) {
      if (any(q, e.name, e.labels, e.source, e.def.endpoint, e.def.host)) add('endpoints', { title: e.name, sub: `${[e.def.method, e.def.host, e.def.endpoint].filter(Boolean).join(' ')} · ${e.source.split('/').pop()}`, nav: { section: 'explorer', library: { kind: 'endpoint', query: e.name } } });
    }
  });

  await safe(() => {
    for (const id of Object.keys(defaultsConfig.SECTIONS)) {
      const r = defaultsConfig.read(id);
      const title = r.title;
      if (id === 'namespaces') {
        for (const ns of r.namespaces) {
          if (has(ns.name, q)) add('defaults', { title: ns.name, sub: `${title} · namespace`, nav: { section: 'settings', tab: 'defaults' } });
          for (const en of ns.entries) if (has(en.key, q)) add('defaults', { title: en.key, sub: `${title} · ${ns.name}`, nav: { section: 'settings', tab: 'defaults' } });
        }
      } else {
        for (const en of r.entries) if (has(en.key, q)) add('defaults', { title: en.key, sub: title, nav: { section: 'settings', tab: 'defaults' } });
      }
    }
  });

  await safe(() => {
    for (const en of envFile.read().entries) if (has(en.key, q)) add('env', { title: en.key, sub: '.env · value hidden', nav: { section: 'settings', tab: 'env' } });
  });

  await safe(() => {
    for (const r of runManager.list()) {
      const title = r.title || (r.config.labels || []).join(', ') || 'Run';
      if (any(q, title, r.config.namespace, r.scenarios, r.status, r.id)) add('runs', { title, sub: `${r.kind === 'scenario-test' ? 'Scenario test' : 'Test run'} · ${r.status} · ${r.config.namespace}${r.counts && r.counts.total ? ` · ${r.counts.passed} passed, ${r.counts.failed} failed` : ''}`, when: r.createdAt, status: r.status, nav: { section: 'history', run: r.id } });
      const info = runManager.traces(r.id);
      for (const t of (info && info.traces) || []) {
        if (any(q, t.traceId, t.stepName, t.scenarioName)) add('traces', { title: t.stepName || t.traceId, sub: `${t.scenarioName || ''} · ${t.traceId.slice(0, 12)}…${t.errors ? ` · ${t.errors} error line${t.errors === 1 ? '' : 's'}` : ''}`, status: t.errors ? 'failed' : undefined, nav: { section: 'history', run: r.id, view: 'traces', traceId: t.traceId } });
      }
    }
  });

  // spans: ids seen in component logs of a run, and spans of traces already opened (id, parent id or operation name)
  await safe(() => {
    const runOfTrace = new Map();
    for (const r of runManager.list()) {
      for (const t of (runManager.traces(r.id) || {}).traces || []) if (!runOfTrace.has(t.traceId)) runOfTrace.set(t.traceId, r.id);
      for (const s of runManager.spanRefs(r.id)) {
        if (s.spanId.includes(q)) add('spans', { title: s.spanId, sub: `span · trace ${s.traceId.slice(0, 12)}… · seen in ${String(s.source).replace(/^pod:[^/]*\//, '')}`, nav: { section: 'history', run: r.id, view: 'traces', traceId: s.traceId, spanId: s.spanId } });
      }
    }
    for (const s of tempo.cachedSpanMatches(q)) {
      const run = runOfTrace.get(s.traceId);
      add('spans', { title: s.name || s.spanId, sub: `${s.service} · span ${s.spanId} · trace ${s.traceId.slice(0, 12)}…`, status: s.error ? 'failed' : undefined, nav: run ? { section: 'history', run, view: 'traces', traceId: s.traceId, spanId: s.spanId } : { section: 'history' } });
    }
  });

  await safe(async () => {
    const st = await gitApi.status();
    for (const f of st.files || []) if (has(f.path, q)) add('git', { title: f.path.split('/').pop(), sub: `changed · ${f.status}${f.staged ? ' · staged' : ''} · ${f.path}`, nav: { section: 'git' } });
    const br = await gitApi.branches();
    for (const b of [...(br.local || []), ...(br.remote || [])]) if (has(b.name, q)) add('git', { title: b.name, sub: `branch${b.current ? ' · current' : ''}`, nav: { section: 'git' } });
    for (const c of await gitApi.log(40)) if (has(c.subject, q) || has(c.sha, q)) add('git', { title: c.subject, sub: `commit ${c.sha} · ${c.author} · ${c.when}`, nav: { section: 'git' } });
  });

  return { query: q, groups: [...out.values()].filter((g) => g.total > 0) };
}

module.exports = { search, GROUPS };
