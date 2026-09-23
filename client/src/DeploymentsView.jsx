import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { LuBox, LuBoxes, LuCheck, LuCircleAlert, LuCloud, LuCopy, LuEllipsis, LuGlobe, LuHexagon, LuLoader, LuLock, LuMinus, LuPanelLeftClose, LuPanelLeftOpen, LuPlus, LuRefreshCw, LuRotateCw, LuSearch, LuServer, LuTrash2, LuX } from 'react-icons/lu';
import { useOnOcLogin } from './OcSession.jsx';
import { EmptyState, IconButton, Modal, Sash, Section, Segmented, Select, Field, usePanelSize, useLocalState, useToast } from './ui.jsx';

// Kinds `oc get <kind> -o yaml` is allowed for - matches the server's own allowlist.
// Not Secret: this workspace keeps Secrets metadata-only (see listSecretsMeta server-side).
const MANIFEST_KINDS = new Set(['deployment', 'pod', 'service']);

// A destructive oc write is never one click: this names the exact command and target
// first, matching how ArgoCD confirms a sync/restart before it touches the cluster.
function ConfirmModal({ title, command, danger, busy, onConfirm, onClose }) {
  return (
    <Modal
      title={title}
      icon={<LuCircleAlert size={16} />}
      width={480}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>
            {busy && <LuLoader size={14} className="spin" />} {busy ? 'Running…' : 'Run it'}
          </button>
        </>
      }
    >
      <div className="muted-block">
        This runs directly against the live cluster:
        <pre className="code-block mono">{command}</pre>
      </div>
    </Modal>
  );
}

function relativeAge(iso) {
  if (!iso) return '—';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function labelsSatisfy(labels, selector) {
  const keys = Object.keys(selector || {});
  if (!keys.length) return false;
  return keys.every((k) => labels[k] === selector[k]);
}

// Mirrors ArgoCD's own Deployment health check: the "Progressing" condition's reason is what
// actually says whether a rollout (e.g. our own Restart) is still under way, not just replica
// counts - counts alone briefly read as 0 ready / degraded while old pods are still terminating
// and new ones haven't come up yet, even though nothing is actually wrong.
function deploymentHealth(d) {
  if (d.replicas.desired === 0) return 'unknown';
  const progressing = d.conditions.find((c) => c.type === 'Progressing');
  if (progressing?.reason === 'ProgressDeadlineExceeded') return 'degraded';
  const settled = !progressing || progressing.reason === 'NewReplicaSetAvailable';
  if (settled && d.replicas.ready >= d.replicas.desired && d.replicas.updated >= d.replicas.desired) return 'healthy';
  if (settled && d.replicas.ready === 0) return 'degraded';
  return 'progressing';
}

// Every status a pod passes through while starting up (after our own Restart/Delete, or on its
// own) reads as "progressing", not "degraded" - matching how ArgoCD shows a pod mid-transition,
// instead of flashing red for what's actually a normal init/creating/not-ready-yet phase.
const POD_PROGRESSING_STATUSES = new Set(['Pending', 'ContainerCreating', 'PodInitializing', 'Terminating']);
function podHealth(p) {
  const [ready, total] = p.ready.split('/').map(Number);
  if (p.status === 'Completed' || p.status === 'Succeeded') return 'unknown';
  if (POD_PROGRESSING_STATUSES.has(p.status) || /^Init:/.test(p.status)) return 'progressing';
  if (p.status === 'Running') return ready === total ? 'healthy' : 'progressing';
  return 'degraded';
}

const KIND_ICON = { namespace: LuBoxes, deployment: LuBox, pod: LuHexagon, service: LuGlobe, secret: LuLock, bucket: LuEllipsis };
const KIND_LABEL = { namespace: 'Namespace', deployment: 'Deployment', pod: 'Pod', service: 'Service', secret: 'Secret', bucket: 'Group' };
const HEALTH_GLYPH = { healthy: <LuCheck size={11} strokeWidth={3} />, degraded: <LuX size={11} strokeWidth={3} />, progressing: <LuLoader size={11} className="spin" />, unknown: null, neutral: null };
const HEALTH_LABEL = { healthy: 'Healthy', degraded: 'Degraded', progressing: 'Progressing', unknown: 'Unknown' };

// The tag off the first container image, e.g. "de.icr.io/ns-nevis/nevis-auth:8.2511.8" -> "8.2511.8".
function imageVersion(images) {
  const img = (images || [])[0];
  if (!img || !img.includes(':')) return '—';
  return img.slice(img.lastIndexOf(':') + 1);
}

// Builds the dependency tree: namespace (root) -> each Deployment -> the Pods/
// Services/Secrets that actually belong to it (via label-selector match, or -
// for secrets - via being referenced from its pod template's env/envFrom/
// volumes). Whatever isn't claimed by any deployment collapses into "Other ..."
// buckets so a namespace with hundreds of service-account secrets doesn't turn
// into hundreds of root-level nodes.
function buildTree(namespace, { deployments, services, pods, secrets }) {
  const usedPods = new Set();
  const usedServices = new Set();
  const usedSecrets = new Set();

  const deploymentNodes = deployments.map((d) => {
    const childPods = pods.filter((p) => labelsSatisfy(p.labels, d.selectorLabels));
    childPods.forEach((p) => usedPods.add(p.name));
    const childServices = services.filter((s) => labelsSatisfy(d.selectorLabels, s.selector));
    childServices.forEach((s) => usedServices.add(s.name));
    const childSecrets = secrets.filter((s) => d.secretRefs.includes(s.name));
    childSecrets.forEach((s) => usedSecrets.add(s.name));

    return {
      id: `deployment:${d.name}`,
      kind: 'deployment',
      title: d.name,
      health: deploymentHealth(d),
      age: relativeAge(d.createdAt),
      data: d,
      children: [
        ...childServices.map((s) => serviceNode(s)),
        ...childPods.map((p) => podNode(p)),
        ...childSecrets.map((s) => secretNode(s)),
      ],
    };
  });

  function serviceNode(s) {
    return { id: `service:${s.name}`, kind: 'service', title: s.name, health: 'neutral', age: relativeAge(s.createdAt), data: s, children: [] };
  }
  function podNode(p) {
    return { id: `pod:${p.name}`, kind: 'pod', title: p.name, health: podHealth(p), age: p.age, data: p, children: [] };
  }
  function secretNode(s) {
    return { id: `secret:${s.name}`, kind: 'secret', title: s.name, health: 'neutral', age: relativeAge(s.createdAt), data: s, children: [] };
  }

  const bucket = (idSuffix, label, items, nodeFn) =>
    items.length
      ? [{ id: `bucket:${idSuffix}`, kind: 'bucket', title: `${label} (${items.length})`, health: 'neutral', children: items.map(nodeFn), isBucket: true }]
      : [];

  const orphanServices = bucket('services', 'Other services', services.filter((s) => !usedServices.has(s.name)), serviceNode);
  const orphanPods = bucket('pods', 'Other pods', pods.filter((p) => !usedPods.has(p.name)), podNode);
  const orphanSecrets = bucket('secrets', 'Other secrets', secrets.filter((s) => !usedSecrets.has(s.name)), secretNode);

  return {
    id: 'root',
    kind: 'namespace',
    title: namespace,
    health: 'neutral',
    children: [...deploymentNodes, ...orphanServices, ...orphanPods, ...orphanSecrets],
  };
}

function nodeDetailRows(node) {
  const d = node.data;
  switch (node.kind) {
    case 'deployment':
      return [
        ['namespace', d.namespace],
        ['version', imageVersion(d.images)],
        ['replicas', `${d.replicas.ready}/${d.replicas.desired} ready, ${d.replicas.available} available`],
        ['images', d.images.join(', ') || '—'],
        ['age', relativeAge(d.createdAt)],
        ...d.conditions.map((c) => [`condition: ${c.type}`, `${c.status}${c.reason ? ` (${c.reason})` : ''}`]),
      ];
    case 'service':
      return [
        ['namespace', d.namespace],
        ['type', d.type],
        ['clusterIP', d.clusterIP],
        ['ports', d.ports.map((p) => `${p.name || ''} ${p.port}->${p.targetPort}/${p.protocol}`).join(', ') || '—'],
        ['selector', Object.entries(d.selector).map(([k, v]) => `${k}=${v}`).join(', ') || '—'],
        ['age', relativeAge(d.createdAt)],
      ];
    case 'pod':
      return [
        ['status', d.status],
        ['ready', d.ready],
        ['restarts', d.restarts],
        ['age', d.age],
      ];
    case 'secret':
      return [
        ['namespace', d.namespace],
        ['type', d.type],
        ['keys', d.keys.join(', ') || '—'],
        ['age', relativeAge(d.createdAt)],
      ];
    default:
      return [];
  }
}

function TreeCard({ node, selected, onClick }) {
  const isBucket = node.kind === 'bucket';
  const Icon = KIND_ICON[node.kind];
  return (
    <div className={`rtree-card kind-${node.kind} ${selected ? 'selected' : ''}`} onClick={onClick}>
      <div className={`rtree-avatar health-${node.health}`}><Icon size={16} /></div>
      <div className="rtree-card-main">
        <div className="rtree-card-title-row">
          <span className="rtree-card-title">{node.title}</span>
          {!isBucket && node.health !== 'neutral' && <span className={`rtree-health-icon health-${node.health}`}>{HEALTH_GLYPH[node.health]}</span>}
        </div>
        {!isBucket && <div className="rtree-card-kind">{KIND_LABEL[node.kind]}</div>}
      </div>
      {node.age && <span className="rtree-age-badge">{node.age}</span>}
    </div>
  );
}

function TreeBranch({ node, selectedId, onSelect, collapsed, onToggleCollapse }) {
  const isCollapsed = collapsed.has(node.id);
  const showChildren = node.children.length > 0 && !isCollapsed;
  return (
    <div className="rtree-node">
      <TreeCard
        node={node}
        selected={selectedId === node.id}
        onClick={() => (node.kind === 'bucket' ? onToggleCollapse(node.id) : onSelect(node))}
      />
      {node.children.length > 0 && (
        <button className="rtree-toggle" onClick={() => onToggleCollapse(node.id)} title={isCollapsed ? 'Expand' : 'Collapse'}>
          {isCollapsed ? <LuPlus size={12} /> : <LuMinus size={12} />}
        </button>
      )}
      {showChildren && (
        <div className="rtree-children">
          {node.children.map((child) => (
            <div className="rtree-child-row" key={child.id}>
              <TreeBranch node={child} selectedId={selectedId} onSelect={onSelect} collapsed={collapsed} onToggleCollapse={onToggleCollapse} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function YamlView({ node, onFetchYaml }) {
  const [yaml, setYaml] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    setYaml(null);
    setError('');
    if (!MANIFEST_KINDS.has(node.kind)) return undefined;
    setLoading(true);
    onFetchYaml(node)
      .then((r) => !cancelled && setYaml(r.yaml))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  if (!MANIFEST_KINDS.has(node.kind)) {
    return <div className="list-hint pad">No YAML view for a {KIND_LABEL[node.kind].toLowerCase()} — {node.kind === 'secret' ? 'this workspace keeps Secrets metadata-only, never their values.' : 'pick a Deployment, Pod or Service.'}</div>;
  }
  if (loading) return <div className="list-hint pad"><LuLoader size={13} className="spin" /> Loading manifest…</div>;
  if (error) return <div className="notice danger"><LuCircleAlert size={15} /><div>{error}</div></div>;
  return (
    <div className="yaml-view">
      <div className="yaml-view-bar">
        <span className="muted small">oc get {node.kind} {node.title} -o yaml</span>
        <IconButton size="xs" icon={<LuCopy size={13} />} title="Copy YAML" onClick={() => navigator.clipboard?.writeText(yaml || '').then(() => toast('YAML copied')).catch(() => toast('Could not copy', 'error'))} />
      </div>
      <pre className="code-block mono yaml-view-pre">{yaml}</pre>
    </div>
  );
}

function Detail({ node, onClose, onRestart, onDeletePod, onFetchYaml, busy }) {
  const [tab, setTab] = useState('overview');
  useEffect(() => setTab('overview'), [node.id]);
  return (
    <div className="res-detail">
      <div className="card-head">
        {React.createElement(KIND_ICON[node.kind], { size: 15, className: 'muted' })}
        <span className="card-title">{KIND_LABEL[node.kind]}</span>
        <IconButton size="sm" icon={<LuX size={15} />} title="Close details" onClick={onClose} />
      </div>
      <div className="res-detail-title-row">
        <strong className="res-detail-title">{node.title}</strong>
        {node.health && node.health !== 'neutral' && <span className={`status-chip health-${node.health}`}>{HEALTH_GLYPH[node.health]} {HEALTH_LABEL[node.health]}</span>}
      </div>
      <div className="res-detail-actions">
        {node.kind === 'deployment' && onRestart && (
          <button type="button" className="btn sm" disabled={busy} onClick={() => onRestart(node)} title="oc rollout restart - recreates its pods with the same image and replica count">
            <LuRotateCw size={13} /> Restart
          </button>
        )}
        {node.kind === 'pod' && onDeletePod && (
          <button type="button" className="btn sm danger-ghost" disabled={busy} onClick={() => onDeletePod(node)} title="oc delete pod - its controller recreates it">
            <LuTrash2 size={13} /> Delete pod
          </button>
        )}
      </div>
      <Segmented size="sm" value={tab} onChange={setTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'yaml', label: 'YAML' }]} />
      <div className="res-detail-body">
        {tab === 'overview' ? (
          <table className="kv-table">
            <tbody>
              {nodeDetailRows(node).map(([k, v]) => (
                <tr key={k}>
                  <td className="kv-key">{k}</td>
                  <td className="kv-val">{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <YamlView node={node} onFetchYaml={onFetchYaml} />
        )}
      </div>
    </div>
  );
}

export default function DeploymentsView() {
  const toast = useToast();
  const [env, setEnv] = useState('dev');
  const [sshHost, setSshHost] = useState('');
  const [sshUser, setSshUser] = useState('');
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [sshPassphrase, setSshPassphrase] = useState('');

  const [nsFilter, setNsFilter] = useState('');
  const [allNamespaces, setAllNamespaces] = useState([]);
  const [nsLoading, setNsLoading] = useState(false);
  const [nsError, setNsError] = useState('');
  const [activeNamespace, setActiveNamespace] = useState('');

  const [resources, setResources] = useState({ deployments: [], services: [], pods: [], secrets: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null); // an id, not the node itself, so it re-resolves against fresh data on every poll instead of freezing at whatever it looked like the moment it was selected
  const [reloadTick, setReloadTick] = useState(0);
  const [collapsed, setCollapsed] = useState(new Set());
  const [sideOpen, setSideOpen] = useLocalState('deploy.sideOpen', true);
  const [sideW, setSideW, resetSideW] = usePanelSize('deploy.side', 300, 240, () => Math.min(560, window.innerWidth - 420));
  const [detailW, setDetailW, resetDetailW] = usePanelSize('deploy.detail', 380, 300, () => Math.min(680, window.innerWidth - 420));
  const [confirmAction, setConfirmAction] = useState(null); // { kind: 'restart' | 'delete-pod', node, command }
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    api.defaults().then((d) => {
      setNsFilter(d.namespaceFilter);
      setSshHost(d.ssh.host);
      setSshUser(d.ssh.user);
      setSshKeyPath(d.ssh.keyPath);
    });
  }, []);

  const sshCfg = () => ({ host: sshHost, user: sshUser, keyPath: sshKeyPath, passphrase: sshPassphrase || undefined });

  const fetchNamespaces = async () => {
    setNsError('');
    setNsLoading(true);
    try {
      const cfg = { env, ...(env === 'devtest' ? { ssh: sshCfg() } : {}) };
      const { projects } = await api.projects(cfg);
      setAllNamespaces(projects);
    } catch (err) {
      setNsError(err.message);
    } finally {
      setNsLoading(false);
    }
  };

  useOnOcLogin(() => {
    fetchNamespaces();
    setReloadTick((n) => n + 1);
  });

  // Switching namespace (or connection) starts fresh - but a plain data refresh (reloadTick, or
  // the poll-while-something's-transitioning effect below) must NOT reset these, or watching a
  // deployment restart would mean the detail panel closing and the tree re-collapsing on you
  // every couple of seconds while it's exactly what you're trying to watch.
  useEffect(() => {
    setSelectedId(null);
  }, [activeNamespace, env]);

  useEffect(() => {
    if (!activeNamespace) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    const cfg = { env, namespace: activeNamespace, ...(env === 'devtest' ? { ssh: sshCfg() } : {}) };
    const podsCfg = { env, namespaces: [activeNamespace], ...(env === 'devtest' ? { ssh: sshCfg() } : {}) };
    Promise.all([api.oc.deployments(cfg), api.oc.services(cfg), api.pods(podsCfg), api.oc.secrets(cfg)])
      .then(([d, s, p, se]) => {
        if (cancelled) return;
        setResources({ deployments: d.deployments, services: s.services, pods: p.pods, secrets: se.secrets });
        window.__nevisCluster = { namespace: activeNamespace, deployments: d.deployments, services: s.services, pods: p.pods, secrets: se.secrets }; // for the global search
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNamespace, env, reloadTick]);

  const tree = useMemo(() => (activeNamespace ? buildTree(activeNamespace, resources) : null), [activeNamespace, resources]);

  const findNode = (node, id) => {
    if (!node) return null;
    if (node.id === id) return node;
    for (const c of node.children) {
      const f = findNode(c, id);
      if (f) return f;
    }
    return null;
  };
  // Re-resolved against the current tree on every render (not the object captured at click time),
  // so the detail panel keeps showing the SAME resource - live - through however many polls it
  // takes to settle, instead of freezing on whatever its health/status looked like at selection.
  const selected = useMemo(() => (tree && selectedId ? findNode(tree, selectedId) : null), [tree, selectedId]);

  // Same reasoning as the selection effect above: only (re-)collapse-by-default once per
  // namespace, the first time its tree appears - not on every subsequent poll, which would fight
  // whatever branch the user has since expanded to watch.
  const collapseInitFor = useRef(null);
  useEffect(() => {
    // Skip the very first (empty-children) tree too - it appears for an instant as soon as a
    // namespace is picked, before the actual oc data has loaded, and latching onto THAT as "already
    // initialized for this namespace" would leave every real branch permanently un-collapsed once
    // the real tree replaces it a moment later.
    if (!tree || !tree.children.length || collapseInitFor.current === activeNamespace) return;
    collapseInitFor.current = activeNamespace;
    // Every tier-1 branch (each deployment, each "Other ..." bucket) starts
    // collapsed. A deployment can reference dozens of secrets - if every branch
    // auto-expanded, the tree's total height could run into the tens of
    // thousands of pixels, and flexbox's align-items:center (which centers
    // each node against the full height of its own children) would push the
    // root node absurdly far down the page trying to center against that.
    // Collapsed-by-default keeps heights sane; expanding one branch at a time
    // is also just how you'd actually want to drill into this anyway.
    setCollapsed(new Set(tree.children.filter((n) => n.children.length > 0).map((n) => n.id)));
  }, [tree, activeNamespace]);

  // Keeps polling on its own the whole time a namespace is open - the live "state management"
  // ArgoCD does, instead of sitting on one static snapshot until someone hits refresh. Faster
  // while something's actually mid-transition (just restarted, a pod still coming up, ...) so a
  // restart or delete visibly moves through progressing to healthy; a slower baseline the rest of
  // the time still catches anything that changes on its own (a crash, someone else's deploy).
  useEffect(() => {
    if (!activeNamespace) return undefined;
    const transitioning = resources.deployments.some((d) => deploymentHealth(d) === 'progressing') || resources.pods.some((p) => podHealth(p) === 'progressing');
    const t = setInterval(() => setReloadTick((n) => n + 1), transitioning ? 2500 : 15000);
    return () => clearInterval(t);
  }, [activeNamespace, resources]);

  const toggleCollapse = (id) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const askRestart = (node) =>
    setConfirmAction({ kind: 'restart', node, command: `oc rollout restart deployment/${node.data.name} -n ${activeNamespace}` });
  const askDeletePod = (node) =>
    setConfirmAction({ kind: 'delete-pod', node, command: `oc delete pod ${node.data.name} -n ${activeNamespace}` });

  const fetchManifest = (node) =>
    api.oc.manifest({ namespace: activeNamespace, kind: node.kind, name: node.data.name, env, ...(env === 'devtest' ? { ssh: sshCfg() } : {}) });

  const runConfirmedAction = async () => {
    if (!confirmAction) return;
    setActionBusy(true);
    try {
      const cfg = { namespace: activeNamespace, name: confirmAction.node.data.name, env, ...(env === 'devtest' ? { ssh: sshCfg() } : {}) };
      if (confirmAction.kind === 'restart') await api.oc.restartDeployment(cfg);
      else await api.oc.deletePod(cfg);
      toast(confirmAction.kind === 'restart' ? `Restarting ${cfg.name}…` : `Deleted pod ${cfg.name}`, 'ok');
      setConfirmAction(null);
      // Deliberately not clearing the selection: for a restart especially, staying on the same
      // deployment is the point - the detail panel keeps showing it, live, as it settles (see the
      // poll-while-transitioning effect above). A deleted pod's own id simply stops resolving
      // once it's gone (its replacement gets a new name), which closes the panel on its own.
      setReloadTick((n) => n + 1);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setActionBusy(false);
    }
  };

  const visibleNamespaces = allNamespaces.filter((n) => n.toLowerCase().includes(nsFilter.toLowerCase()));

  return (
    <div className="view">
      {sideOpen && (
        <aside className="panel side" style={{ width: sideW }}>
          <div className="panel-head">
            <span className="panel-title">Cluster</span>
            <IconButton size="sm" icon={<LuPanelLeftClose size={16} />} title="Hide panel" onClick={() => setSideOpen(false)} />
          </div>
          <div className="panel-scroll">
            <Section title="Connection" icon={<LuServer size={15} />} storageKey="deploy.sec.conn">
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
            </Section>

            <Section
              title="Namespaces"
              icon={<LuCloud size={15} />}
              badge={allNamespaces.length || null}
              storageKey="deploy.sec.ns"
              actions={
                <IconButton size="xs" icon={<LuRefreshCw size={13} className={nsLoading ? 'spin' : ''} />} title="Fetch namespaces" onClick={fetchNamespaces} disabled={nsLoading} />
              }
            >
              <div className="search-box">
                <LuSearch size={14} className="search-box-icon" />
                <input value={nsFilter} onChange={(e) => setNsFilter(e.target.value)} placeholder="Filter namespaces" spellCheck={false} />
              </div>
              {nsError && <div className="text-danger small">{nsError}</div>}
              <div className="pick-list">
                {visibleNamespaces.map((ns) => (
                  <button type="button" key={ns} className={`pick-row ${activeNamespace === ns ? 'active' : ''}`} onClick={() => setActiveNamespace(ns)}>
                    {ns}
                  </button>
                ))}
                {allNamespaces.length === 0 && !nsLoading && <div className="list-hint">Press refresh to fetch namespaces.</div>}
              </div>
            </Section>
          </div>
          <Sash edge="end" size={sideW} onSize={setSideW} onReset={resetSideW} />
        </aside>
      )}

      <section className="workspace">
        <div className="tabstrip">
          {!sideOpen && <IconButton size="sm" icon={<LuPanelLeftOpen size={16} />} title="Show panel" onClick={() => setSideOpen(true)} />}
          <span className="tabstrip-title">{activeNamespace || 'Deployment dependency tree'}</span>
          {loading && <LuLoader size={14} className="spin muted" />}
        </div>
        {!tree ? (
          <EmptyState icon={<LuBoxes size={26} />} title="No namespace selected">Pick a namespace on the left to see its deployment dependency tree.</EmptyState>
        ) : (
          <div className="deploy-body">
            <div className="workspace-scroll">
              {error && <div className="text-danger pad"><LuCircleAlert size={13} /> {error}</div>}
              <div className="rtree-scroll">
                <TreeBranch node={tree} selectedId={selectedId} onSelect={(n) => setSelectedId(n.id)} collapsed={collapsed} onToggleCollapse={toggleCollapse} />
              </div>
            </div>
            {selected && (
              <aside className="res-detail-panel" style={{ width: detailW }}>
                <Sash edge="start" size={detailW} onSize={setDetailW} onReset={resetDetailW} />
                <Detail node={selected} onClose={() => setSelectedId(null)} onRestart={askRestart} onDeletePod={askDeletePod} onFetchYaml={fetchManifest} busy={actionBusy} />
              </aside>
            )}
          </div>
        )}
      </section>
      {confirmAction && (
        <ConfirmModal
          title={confirmAction.kind === 'restart' ? 'Restart this deployment?' : 'Delete this pod?'}
          command={confirmAction.command}
          danger={confirmAction.kind === 'delete-pod'}
          busy={actionBusy}
          onConfirm={runConfirmedAction}
          onClose={() => !actionBusy && setConfirmAction(null)}
        />
      )}
    </div>
  );
}
