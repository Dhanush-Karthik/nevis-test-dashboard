const BASE = '';

async function j(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
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

export const api = {
  explorer: {
    tree: () => fetch(`${BASE}/api/explorer/tree`).then(j),
    file: (path) => fetch(`${BASE}/api/explorer/file?path=${encodeURIComponent(path)}`).then(j),
    preview: (payload) => fetch(`${BASE}/api/explorer/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json()),
    save: (payload) => fetch(`${BASE}/api/explorer/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json()),
  },
  git: {
    status: () => fetch(`${BASE}/api/git/status`).then(j),
    branches: () => fetch(`${BASE}/api/git/branches`).then(j),
    log: () => fetch(`${BASE}/api/git/log?limit=30`).then(j),
    diff: (path, untracked) => fetch(`${BASE}/api/git/diff?path=${encodeURIComponent(path)}${untracked ? '&untracked=1' : ''}`).then(j),
    checkout: (branch) => post('/api/git/checkout', { branch }),
    createBranch: (name, from) => post('/api/git/branch', { name, from }),
    fetch: () => post('/api/git/fetch', {}),
    pull: (strategy) => post('/api/git/pull', { strategy }),
    commit: (message, paths) => post('/api/git/commit', { message, paths }),
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
  runs: () => fetch(`${BASE}/api/runs`).then(j),
  run: (id) => fetch(`${BASE}/api/runs/${id}`).then(j),
  startRun: (config) => post('/api/runs', config),
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
