const BASE = '';

async function j(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `${res.status} ${res.statusText}`);
    err.code = body.code;
    // an expired cluster login: let the app offer to log in again (see OcSession.jsx)
    if (body.code === 'OC_LOGIN_REQUIRED') window.dispatchEvent(new CustomEvent('oc-login-required'));
    throw err;
  }
  return res.json();
}

function post(url, body) {
  return fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j);
}

// git operations change what the sidebar badge counts: tell the app to look again
const gitChanged = (p) => p.then((r) => { window.dispatchEvent(new Event('nevis-git-changed')); return r; });

export const api = {
  explorer: {
    tree: () => fetch(`${BASE}/api/explorer/tree`).then(j),
    create: (dir, name) => post('/api/explorer/create', { dir, name }),
    folder: (parent, name) => post('/api/explorer/folder', { parent, name }),
    copy: (from) => post('/api/explorer/copy', { from }),
    rename: (from, name) => post('/api/explorer/rename', { from, name }),
    remove: (path, kind) => post('/api/explorer/delete', { path, kind }),
    move: (from, toDir) => post('/api/explorer/move', { from, toDir }),
    file: (path) => fetch(`${BASE}/api/explorer/file?path=${encodeURIComponent(path)}`).then(j),
    preview: (payload) => fetch(`${BASE}/api/explorer/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json()),
    save: (payload) => fetch(`${BASE}/api/explorer/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json()),
  },
  git: {
    status: () => fetch(`${BASE}/api/git/status`).then(j),
    branches: () => fetch(`${BASE}/api/git/branches`).then(j),
    log: () => fetch(`${BASE}/api/git/log?limit=30`).then(j),
    diff: (path, { untracked, staged } = {}) => fetch(`${BASE}/api/git/diff?path=${encodeURIComponent(path)}${untracked ? '&untracked=1' : ''}${staged ? '&staged=1' : ''}`).then(j),
    stage: (paths) => gitChanged(post('/api/git/stage', { paths })),
    unstage: (paths) => gitChanged(post('/api/git/unstage', { paths })),
    push: () => gitChanged(post('/api/git/push', {})),
    checkout: (branch) => gitChanged(post('/api/git/checkout', { branch })),
    createBranch: (name, from) => post('/api/git/branch', { name, from }),
    fetch: () => post('/api/git/fetch', {}),
    pull: (strategy) => gitChanged(post('/api/git/pull', { strategy })),
    commit: (message) => gitChanged(post('/api/git/commit', { message })),
  },
  tracing: {
    status: () => fetch(`${BASE}/api/tracing/status`).then(j),
    trace: (id) => fetch(`${BASE}/api/tracing/trace/${encodeURIComponent(id)}`).then(j),
    grafana: ({ traceId, from, to }) => {
      const q = new URLSearchParams({ traceId });
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      return fetch(`${BASE}/api/tracing/grafana?${q}`).then(j);
    },
  },
  ides: () => fetch(`${BASE}/api/ides`).then(j),
  openLog: (payload) => post('/api/logs/open', payload),
  defaults: () => fetch(`${BASE}/api/defaults`).then(j),
  projects: (cfg) => post('/api/oc/projects', cfg),
  pods: (cfg) => post('/api/oc/pods', cfg),
  ausweisApp: {
    status: () => fetch(`${BASE}/api/ausweisapp/status`).then(j),
    start: () => post('/api/ausweisapp/start', {}),
    stop: () => post('/api/ausweisapp/stop', {}),
  },
  runs: () => fetch(`${BASE}/api/runs`).then(j),
  run: (id) => fetch(`${BASE}/api/runs/${id}`).then(j),
  startRun: (config) => post('/api/runs', config),
  removeRun: (id) => fetch(`${BASE}/api/runs/${id}`, { method: 'DELETE' }).then(j),
  clearRuns: () => post('/api/runs/clear', {}),
  stopRun: (id) => fetch(`${BASE}/api/runs/${id}/stop`, { method: 'POST' }).then(j),
  scenarios: {
    labels: () => fetch(`${BASE}/api/scenarios/labels`).then(j),
    resolve: ({ labels, exclusionLabels }) => {
      const params = new URLSearchParams();
      if (labels) params.set('labels', labels);
      if (exclusionLabels) params.set('exclusionLabels', exclusionLabels);
      return fetch(`${BASE}/api/scenarios/resolve?${params.toString()}`).then(j);
    },
  },
  builder: {
    schema: () => fetch(`${BASE}/api/builder/schema`).then(j),
    catalog: () => fetch(`${BASE}/api/builder/catalog`).then(j),
    files: () => fetch(`${BASE}/api/builder/files`).then(j),
    test: (payload) => post('/api/builder/test', payload),
    preview: (payload) => post('/api/builder/preview', payload),
    yaml: (sections) => post('/api/builder/yaml', { sections }),
    parse: (text) => post('/api/builder/parse', { text }),
    save: (payload) =>
      fetch(`${BASE}/api/builder/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json()),
    validate: (payload) => post('/api/builder/validate', payload),
  },
  ocSession: () => fetch(`${BASE}/api/oc/session`).then(j),
  ocLogin: (server, code) => post('/api/oc/login', { server, code }),
  defaultConfigs: {
    get: () => fetch(`${BASE}/api/default-configs`).then(j),
    preview: (payload) => post('/api/default-configs/preview', payload),
    save: (payload) => post('/api/default-configs/save', payload),
  },
  env: {
    get: () => fetch(`${BASE}/api/env`).then(j),
    save: (payload) => post('/api/env/save', payload),
  },
  oc: {
    deployments: (cfg) => post('/api/oc/deployments', cfg),
    services: (cfg) => post('/api/oc/services', cfg),
    secrets: (cfg) => post('/api/oc/secrets', cfg),
  },
};

export function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}
