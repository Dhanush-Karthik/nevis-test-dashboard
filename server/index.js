'use strict';

const path = require('path');
const { REPO_ROOT } = require('./paths'); // exits with a clear message when the test project cannot be found
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { listProjects, listPods, listDeployments, listServices, listSecretsMeta, restartDeployment, deletePod, getManifest } = require('./oc');
const { RunManager } = require('./runManager');
const scenarioCatalog = require('./scenarioCatalog');
const testBuilder = require('./testBuilder');
const tempo = require('./tempo');
const explorer = require('./explorer');
const gitApi = require('./git');
const ocLogin = require('./ocLogin');
const defaultsConfig = require('./defaultsConfig');
const envFile = require('./envFile');
const ausweisApp = require('./ausweisApp');

const PORT = process.env.DASHBOARD_PORT || 4570;

const app = express();
app.use(cors());
// 5mb was too tight for "Open in VS Code" on a long-running scenario: a filtered log excerpt of
// ~20k lines already gets close to it once JSON-escaped, and the request was silently rejected
// with a generic "Payload Too Large" before it ever reached the route. This server only ever
// talks to the developer's own machine, so a generous ceiling here costs nothing.
app.use(express.json({ limit: '50mb' }));

// runId -> Set<ws>
const subscribers = new Map();
function broadcast(runId, message) {
  const set = subscribers.get(runId);
  if (!set) return;
  const payload = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

const runManager = new RunManager(broadcast);
testBuilder.cleanupDrafts(); // drop drafts a previous crash may have left behind

// An expired cluster login is reported distinctly so the UI can offer to log in again instead of a raw error.
const ocFail = (res, err) => {
  if (ocLogin.isAuthError(err.message)) return res.status(401).json({ code: 'OC_LOGIN_REQUIRED', error: 'Your OpenShift login has expired. Log in again to continue.' });
  return res.status(502).json({ error: err.message });
};

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/defaults', (req, res) => {
  res.json({
    namespaceFilter: 'dev-main',
    exclusionLabels: ['eid'],
    ssh: {
      host: process.env.SSH_HOST || '',
      user: process.env.SSH_USER || '',
      keyPath: process.env.SSH_KEY || '',
    },
  });
});

app.post('/api/oc/projects', async (req, res) => {
  try {
    const projects = await listProjects(req.body || {});
    res.json({ projects });
  } catch (err) {
    ocFail(res, err);
  }
});

// Fetches pods across one or more oc namespaces/projects at once (e.g. "dev-main" +
// "dev-main-idbroker"), tagging every pod with the namespace it came from so the
// dashboard can tail the right one and disambiguate same-named pods.
app.post('/api/oc/pods', async (req, res) => {
  const { namespaces, ...cfg } = req.body || {};
  if (!namespaces || !namespaces.length) return res.status(400).json({ error: 'at least one namespace is required' });
  const pods = [];
  const errors = [];
  for (const ns of namespaces) {
    try {
      const nsPods = await listPods(cfg, ns);
      for (const p of nsPods) pods.push({ ...p, namespace: ns });
    } catch (err) {
      errors.push({ namespace: ns, message: err.message });
    }
  }
  if (!pods.length && errors.length && errors.every((e) => ocLogin.isAuthError(e.message))) return ocFail(res, new Error(errors[0].message));
  res.json({ pods, errors });
});

// Reads config/**/*.yaml (same files pytest_generate_tests scans) so a dev can pick
// a label and immediately see which namespaces support it, without reading code.
app.get('/api/scenarios/labels', (req, res) => {
  try {
    res.json({ labels: scenarioCatalog.allLabels() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scenarios/resolve', (req, res) => {
  try {
    const labels = req.query.labels || '';
    const exclusionLabels = req.query.exclusionLabels
      ? String(req.query.exclusionLabels).split(/[\s,]+/).filter(Boolean)
      : [];
    const { scenarios, namespaces } = scenarioCatalog.resolve(labels, exclusionLabels);
    res.json({
      namespaces,
      scenarios: scenarios.map((s) => ({ name: s.name, description: s.description, labels: s.labels, supportedNamespaces: s.supportedNamespaces })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// OpenShift resource browser for the Deployments tab. Mostly read-only; the two
// exceptions below (restart a deployment, delete a pod) are the only mutating
// routes, are each gated behind a confirm dialog client-side naming the exact oc
// command before it's ever called (DeploymentsView.jsx), and go no further than
// that - no scale, no delete-deployment, no edit. Secrets stay metadata-only: see
// listSecretsMeta.
app.post('/api/oc/deployments', async (req, res) => {
  const { namespace, ...cfg } = req.body || {};
  if (!namespace) return res.status(400).json({ error: 'namespace is required' });
  try {
    res.json({ deployments: await listDeployments(cfg, namespace) });
  } catch (err) {
    ocFail(res, err);
  }
});

app.post('/api/oc/services', async (req, res) => {
  const { namespace, ...cfg } = req.body || {};
  if (!namespace) return res.status(400).json({ error: 'namespace is required' });
  try {
    res.json({ services: await listServices(cfg, namespace) });
  } catch (err) {
    ocFail(res, err);
  }
});

app.post('/api/oc/secrets', async (req, res) => {
  const { namespace, ...cfg } = req.body || {};
  if (!namespace) return res.status(400).json({ error: 'namespace is required' });
  try {
    res.json({ secrets: await listSecretsMeta(cfg, namespace) });
  } catch (err) {
    ocFail(res, err);
  }
});

const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const MANIFEST_KINDS = new Set(['deployment', 'pod', 'service']);

// Raw YAML for the detail panel's "YAML" view. Secret is not in MANIFEST_KINDS on purpose -
// this workspace's rule is metadata-only for Secrets (see listSecretsMeta); a full manifest
// dump would print `.data`.
app.post('/api/oc/manifest', async (req, res) => {
  const { namespace, kind, name, ...cfg } = req.body || {};
  if (!namespace || !name || !K8S_NAME_RE.test(namespace) || !K8S_NAME_RE.test(name) || !MANIFEST_KINDS.has(kind)) {
    return res.status(400).json({ error: 'namespace, a valid name, and a supported kind are required' });
  }
  try {
    res.json({ yaml: await getManifest(cfg, namespace, kind, name) });
  } catch (err) {
    ocFail(res, err);
  }
});

app.post('/api/oc/deployments/restart', async (req, res) => {
  const { namespace, name, ...cfg } = req.body || {};
  if (!namespace || !name || !K8S_NAME_RE.test(namespace) || !K8S_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'namespace and name are required' });
  }
  try {
    await restartDeployment(cfg, namespace, name);
    res.json({ ok: true });
  } catch (err) {
    ocFail(res, err);
  }
});

app.post('/api/oc/pods/delete', async (req, res) => {
  const { namespace, name, ...cfg } = req.body || {};
  if (!namespace || !name || !K8S_NAME_RE.test(namespace) || !K8S_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'namespace and name are required' });
  }
  try {
    await deletePod(cfg, namespace, name);
    res.json({ ok: true });
  } catch (err) {
    ocFail(res, err);
  }
});

// "Create test case" tab. Read-only against existing config; the only write is a
// single new file under config/tickets/ (see testBuilder.saveTestCase).
app.get('/api/builder/schema', (req, res) => {
  try {
    res.json(testBuilder.getSchema());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/builder/catalog', (req, res) => {
  try {
    res.json(testBuilder.getCatalogPayload());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/builder/preview', (req, res) => {
  res.json(testBuilder.buildTestCase(req.body || {}));
});

// Raw YAML of blocks as they would be written to a config file (read-only, nothing is saved).
app.post('/api/builder/yaml', (req, res) => {
  try {
    const sections = Array.isArray(req.body?.sections) ? req.body.sections : [];
    const out = sections.map((s) => {
      if (!['workflows', 'endpoint_interactions', 'scenarios'].includes(s.key)) throw new Error('unknown section');
      const items = Array.isArray(s.items) ? s.items : [];
      const yaml = items.length ? testBuilder.itemsBlock(s.key, items).replace(/^ {2}/gm, '') : '';
      return { key: s.key, yaml, block: items.length ? `${s.key}:\n${testBuilder.itemsBlock(s.key, items)}` : '' };
    });
    res.json({ sections: out, document: out.map((s) => s.block).filter(Boolean).join('\n\n') + '\n' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Parses hand-edited YAML from the editor; nothing is written anywhere.
app.post('/api/builder/parse', (req, res) => {
  const YAML = require('yaml');
  const text = String(req.body?.text ?? '');
  try {
    const doc = YAML.parseDocument(text);
    if (doc.errors.length) {
      const e = doc.errors[0];
      return res.json({ ok: false, error: e.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, ''), line: e.linePos?.[0]?.line || null });
    }
    const data = doc.toJS() || {};
    if (typeof data !== 'object' || Array.isArray(data)) return res.json({ ok: false, error: 'Top level must be a mapping (workflows / endpoint_interactions / scenarios).', line: 1 });
    res.json({ ok: true, doc: data });
  } catch (err) {
    res.json({ ok: false, error: err.message.split('\n')[0], line: null });
  }
});

app.post('/api/builder/save', (req, res) => {
  try {
    const result = testBuilder.saveTestCase(req.body || {});
    res.status(result.ok ? 201 : result.conflict ? 409 : 400).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

app.get('/api/builder/files', (req, res) => res.json({ files: testBuilder.listScenarioFiles() }));

// Test-before-save: runs ONE draft scenario through real pytest (real requests, like
// the Tests tab does) via a throw-away config file that is removed when the run ends.
app.post('/api/builder/test', (req, res) => {
  const { scenario, namespace, pods, exclusionLabels } = req.body || {};
  if (!namespace) return res.status(400).json({ error: 'namespace is required' });
  const podList = Array.isArray(pods) ? pods : [];
  if (podList.some((p) => !p || !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(p.name || '') || !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(p.namespace || ''))) return res.status(400).json({ error: 'each pod needs a valid name and namespace' });
  const exclusion = Array.isArray(exclusionLabels) ? exclusionLabels.map((l) => String(l).trim()).filter(Boolean) : ['eid'];
  // A test run only needs a flow + a target namespace: the scenario's own name and
  // supported namespaces are filled in for the throw-away draft when left blank.
  if (runActive()) return res.status(409).json({ error: 'A test is already running. Only one scenario runs at a time: wait for it to finish or stop it first.' });
  const sc = { ...scenario, name: (scenario?.name || '').trim() || 'dashboard-test', supportedNamespaces: [namespace] };
  const draft = testBuilder.createDraft({ scenarios: [sc] });
  if (!draft.ok) return res.status(400).json({ error: draft.errors.join(' ') });
  try {
    const run = runManager.start({ env: 'dev', namespace, labels: [draft.uuid], exclusionLabels: exclusion, pods: podList, kind: 'scenario-test', title: sc.name, onFinish: draft.cleanup });
    res.status(201).json({ run });
  } catch (err) {
    draft.cleanup();
    res.status(500).json({ error: err.message });
  }
});

// ---- explorer: existing scenario files as structured data, edited in place ----
const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
app.get('/api/explorer/tree', wrap(() => ({ files: explorer.tree(), ...explorer.scenarioDirs() })));
app.post('/api/explorer/folder', wrap((req) => explorer.createFolder(req.body || {})));
app.post('/api/explorer/copy', wrap((req) => explorer.copyFile(req.body || {})));
app.post('/api/explorer/rename', wrap((req) => { guardRun('renaming files'); return explorer.renameFile(req.body || {}); }));
app.post('/api/explorer/delete', wrap((req) => { guardRun('deleting files'); return explorer.deleteEntry(req.body || {}); }));
app.post('/api/explorer/create', wrap((req) => explorer.createFile(req.body || {})));
app.post('/api/explorer/move', wrap((req) => { guardRun('moving files'); return explorer.moveFile(req.body || {}); }));
app.get('/api/explorer/file', wrap((req) => explorer.readFile(String(req.query.path || ''))));
app.post('/api/explorer/preview', wrap((req) => explorer.preview(req.body || {})));
app.post('/api/explorer/save', wrap((req) => explorer.save(req.body || {})));

// ---- eID simulator (AusweisApp2, the same podman container lib/eid_helper.py starts for an
// eid-labelled run) - so a dev doesn't need a separate terminal for it ----
app.get('/api/ausweisapp/status', wrap(async () => ({ port: ausweisApp.PORT, ...(await ausweisApp.status()) })));
app.post('/api/ausweisapp/start', wrap(async () => ({ port: ausweisApp.PORT, ...(await ausweisApp.start()) })));
app.post('/api/ausweisapp/stop', wrap(async () => ({ port: ausweisApp.PORT, ...(await ausweisApp.stop()) })));

// ---- git (the integration-tests repo) ----
const runActive = () => runManager.list().some((r) => r.status === 'running' || r.status === 'starting');
const guardRun = (what) => {
  if (runActive()) throw new Error(`A test run is in progress - wait for it to finish before ${what} (it would change the files pytest is using).`);
};
app.get('/api/git/status', wrap(() => gitApi.status()));
app.get('/api/git/branches', wrap(() => gitApi.branches()));
app.get('/api/git/log', wrap(async (req) => ({ commits: await gitApi.log(req.query.limit) })));
app.get('/api/git/diff', wrap(async (req) => ({
  diff: await gitApi.diff(String(req.query.path || ''), { untracked: req.query.untracked === '1', staged: req.query.staged === '1' }),
})));
app.post('/api/git/checkout', wrap(async (req) => { guardRun('switching branches'); return gitApi.checkout((req.body || {}).branch); }));
app.post('/api/git/branch', wrap((req) => gitApi.createBranch((req.body || {}).name, (req.body || {}).from)));
app.post('/api/git/fetch', wrap(async () => ({ output: await gitApi.fetchRemote() })));
app.post('/api/git/pull', wrap(async (req) => { guardRun('pulling'); return { output: await gitApi.pull((req.body || {}).strategy) }; }));
app.post('/api/git/stage', wrap(async (req) => { await gitApi.stage((req.body || {}).paths); return gitApi.status(); }));
app.post('/api/git/unstage', wrap(async (req) => { await gitApi.unstage((req.body || {}).paths); return gitApi.status(); }));
app.post('/api/git/commit', wrap(async (req) => ({ output: await gitApi.commit((req.body || {}).message), status: await gitApi.status() })));
app.post('/api/git/push', wrap(async () => ({ output: await gitApi.push(), status: await gitApi.status() })));

// ---- tracing (Tempo via managed oc port-forward; read-only) ----
app.get('/api/tracing/status', async (req, res) => res.json(await tempo.status()));

app.get('/api/tracing/trace/:id', async (req, res) => {
  try {
    res.json(await tempo.getTrace(req.params.id));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/tracing/grafana', async (req, res) => {
  try {
    res.json({ url: await tempo.grafanaTraceUrl(req.query.traceId, Number(req.query.from) || undefined, Number(req.query.to) || undefined) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Traces a run produced: exact ids reported by the pytest plugin, each looked up in Tempo,
// plus (when the run sent none) a time-window list of what the cluster traced meanwhile.
app.get('/api/runs/:id/traces', async (req, res) => {
  const info = runManager.traces(req.params.id);
  if (!info) return res.status(404).json({ error: 'not found' });
  try {
    const looked = await Promise.all(
      info.traces.slice(0, 80).map(async (t) => {
        try {
          const tr = await tempo.getTrace(t.traceId);
          return { ...t, found: tr.found, summary: tr.summary };
        } catch (err) {
          return { ...t, found: false, error: err.message };
        }
      })
    );
    res.json({ ...info, traces: looked });
  } catch (err) {
    res.status(502).json({ ...info, error: err.message });
  }
});

app.get('/api/runs/:id/trace-window', async (req, res) => {
  const info = runManager.traces(req.params.id);
  if (!info) return res.status(404).json({ error: 'not found' });
  try {
    res.json({ traces: await tempo.searchWindow(info.startedAt - 5000, (info.endedAt || Date.now()) + 60000, 30) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- open logs in a local IDE (the server runs on the dev's own machine) ----
const ideLauncher = require('./ideLauncher');
app.get('/api/ides', (req, res) => res.json({ ides: ideLauncher.available() }));
app.post('/api/logs/open', (req, res) => {
  const { ide, name, content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content is required' });
  try {
    res.json(ideLauncher.open({ ide, name, content }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/builder/validate', async (req, res) => {
  res.json(await testBuilder.validateWithDryRun(req.body || {}));
});

// ---- output/ artifacts a run wrote (downloaded PDFs, exported tokens/certs, screenshots, ...) ----
const outputFiles = require('./outputFiles');
app.get('/api/output/files', (req, res) => {
  res.json({ files: outputFiles.list(Number(req.query.since) || 0) });
});
app.get('/api/output/file', (req, res) => {
  const abs = outputFiles.resolve(req.query.path);
  if (!abs) return res.status(404).json({ error: 'not found' });
  res.download(abs);
});

app.get('/api/runs', (req, res) => res.json({ runs: runManager.list() }));

app.get('/api/runs/:id', (req, res) => {
  const run = runManager.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json({ run });
});

app.post('/api/runs', (req, res) => {
  const { env, namespace, labels, exclusionLabels, pods, ssh, keyword, replaces } = req.body || {};
  if (runActive()) return res.status(409).json({ error: 'A test is already running. Only one run at a time: wait for it to finish or stop it first.' });
  if (!namespace || !labels || !labels.length) {
    return res.status(400).json({ error: 'namespace and at least one label are required' });
  }
  if (env === 'devtest' && (!ssh || !ssh.host || !ssh.user || !ssh.keyPath)) {
    return res.status(400).json({ error: 'devtest requires ssh host, user and keyPath' });
  }
  if ((pods || []).some((p) => !p.name || !p.namespace)) {
    return res.status(400).json({ error: 'each pod must have a name and namespace' });
  }
  if (keyword !== undefined && (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 300)) {
    return res.status(400).json({ error: 'keyword must be a short, non-empty string' });
  }
  // `replaces` says this run's result should stand in for one scenario of another (the run this
  // was re-run from) - the point of a scenario re-run. Only meaningful alongside `keyword`, and
  // only onto a run that actually exists (Run tests' current run, or any run open in History).
  if (replaces !== undefined) {
    if (!keyword || typeof replaces !== 'object' || !replaces.runId || typeof replaces.scenarioName !== 'string' || !replaces.scenarioName.trim()) {
      return res.status(400).json({ error: 'replaces requires a keyword and { runId, scenarioName }' });
    }
    if (!runManager.get(replaces.runId)) return res.status(400).json({ error: 'the run being replaced was not found' });
  }
  try {
    const run = runManager.start({
      env: env === 'devtest' ? 'devtest' : 'dev',
      namespace,
      labels,
      exclusionLabels: exclusionLabels || ['eid'],
      pods: pods || [],
      ssh,
      keyword: keyword ? keyword.trim() : undefined,
      replaces: replaces ? { runId: replaces.runId, scenarioName: replaces.scenarioName.trim() } : undefined,
      // A keyword targets one scenario out of an already-run label set - that's a re-run, not
      // a new top-level execution, so it's kept out of the run history list (see GET /api/runs).
      kind: keyword ? 'scenario-rerun' : 'tests',
    });
    res.status(201).json({ run });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/runs/:id', (req, res) => {
  const r = runManager.remove(req.params.id);
  if (r === null) return res.status(404).json({ error: 'not found' });
  if (r === false) return res.status(409).json({ error: 'Stop the run before removing it.' });
  res.json({ ok: true });
});
app.post('/api/runs/clear', (req, res) => res.json({ removed: runManager.clearFinished() }));

app.post('/api/runs/:id/stop', (req, res) => {
  const ok = runManager.stop(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// Serve the built client, if present, so a single port does everything.
// ---- global search (files, scenarios, labels, blocks, defaults, env names, runs, traces, git) ----
const globalSearch = require('./search');
app.get('/api/search', wrap((req) => globalSearch.search(req.query.q, runManager)));

// ---- OpenShift session (log in again from the dashboard when the 24h login has expired) ----
app.get('/api/oc/session', wrap(() => ocLogin.session()));
app.post('/api/oc/login', wrap((req) => ocLogin.login(req.body || {})));

// ---- default configs (config/defaults/*.yaml) ----
app.get('/api/default-configs', wrap(() => {
  const schema = testBuilder.getSchema();
  const sections = {};
  for (const id of Object.keys(defaultsConfig.SECTIONS)) sections[id] = defaultsConfig.read(id);
  const seen = new Map();
  for (const ns of sections.namespaces.namespaces) for (const e of ns.entries) if (!seen.has(e.key)) seen.set(e.key, e);
  const known = new Map();
  for (const prop of [...schema.workflowProps, ...schema.endpointProps]) if (!known.has(prop.key)) known.set(prop.key, prop);
  for (const [key, e] of seen) {
    if (known.has(key)) continue;
    const v = e.value;
    known.set(key, { key, type: typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : Array.isArray(v) ? 'list' : v && typeof v === 'object' ? 'object' : 'string', description: e.comment || 'used in another namespace', source: 'defaults' });
  }
  return {
    sections,
    suggestions: schema.suggestions,
    catalog: { namespaces: [...known.values()].sort((a, b) => a.key.localeCompare(b.key)), workflows: schema.workflowProps, endpoints: schema.endpointProps },
  };
}));
const defaultsPlan = async (body) => {
  const p = defaultsConfig.plan(String(body.section || ''), body.ops, body.hash);
  return { ...p, diff: p.changed ? await gitApi.diffTexts(p.oldText, p.newText, p.relPath) : '' };
};
app.post('/api/default-configs/preview', wrap(async (req) => {
  const p = await defaultsPlan(req.body || {});
  return { ok: true, changed: p.changed, relPath: p.relPath, diff: p.diff };
}));
app.post('/api/default-configs/save', wrap(async (req) => {
  guardRun('editing the default configs');
  return defaultsConfig.save(String((req.body || {}).section || ''), (req.body || {}).ops, (req.body || {}).hash);
}));

// ---- .env of the test project ----
const envHash = (t) => require('crypto').createHash('sha1').update(t).digest('hex');
app.get('/api/env', wrap(async () => {
  const r = envFile.read();
  let ignored = null;
  try { ignored = await gitApi.isIgnored('.env'); } catch (_) { /* not a git checkout */ }
  return { exists: r.exists, path: '.env', ignored, hash: envHash(r.text), text: r.text, entries: r.entries, known: envFile.scanUsedKeys() };
}));
app.post('/api/env/save', wrap((req) => {
  guardRun('editing .env');
  const body = req.body || {};
  const cur = envFile.read();
  if (body.hash && body.hash !== envHash(cur.text)) throw new Error('.env changed on disk since you opened it. Reload and redo your changes.');
  const next = typeof body.text === 'string' ? body.text : envFile.applyOps(cur.text, Array.isArray(body.ops) ? body.ops : []);
  const before = new Map(cur.entries.map((e) => [e.key, e.value]));
  const after = new Map(envFile.parse(next).map((e) => [e.key, e.value]));
  const summary = {
    added: [...after.keys()].filter((k) => !before.has(k)),
    removed: [...before.keys()].filter((k) => !after.has(k)),
    changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)),
  };
  if (next !== cur.text) envFile.write(next);
  return { ok: true, summary, hash: envHash(next) };
}));

const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) res.status(404).send('Client not built yet. Run: npm run build --prefix client');
  });
});

const server = app.listen(PORT, () => {
  console.log(`[dashboard] listening on http://localhost:${PORT}`);
  console.log(`[dashboard] test project: ${REPO_ROOT}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  let subscribedRunId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (msg.type === 'subscribe' && msg.runId) {
      if (subscribedRunId) subscribers.get(subscribedRunId)?.delete(ws);
      subscribedRunId = msg.runId;
      if (!subscribers.has(subscribedRunId)) subscribers.set(subscribedRunId, new Set());
      subscribers.get(subscribedRunId).add(ws);

      const run = runManager.get(subscribedRunId);
      if (run) {
        ws.send(
          JSON.stringify({
            type: 'backlog',
            runId: subscribedRunId,
            sources: run.sources,
            status: run.status,
            exitCode: run.exitCode,
            flow: run.flow,
          })
        );
      }
    }
  });

  ws.on('close', () => {
    if (subscribedRunId) subscribers.get(subscribedRunId)?.delete(ws);
  });
});
