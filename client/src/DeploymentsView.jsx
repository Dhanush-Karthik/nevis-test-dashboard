import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { LuBox, LuBoxes, LuCheck, LuCircleAlert, LuCloud, LuEllipsis, LuGlobe, LuHexagon, LuLoader, LuLock, LuMinus, LuPanelLeftClose, LuPanelLeftOpen, LuPlus, LuRefreshCw, LuSearch, LuServer, LuX } from 'react-icons/lu';
import { EmptyState, IconButton, Sash, Section, Select, Field, usePanelSize, useLocalState } from './ui.jsx';

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

function deploymentHealth(d) {
  if (d.replicas.desired === 0) return 'unknown';
  if (d.replicas.ready >= d.replicas.desired) return 'healthy';
  if (d.replicas.ready === 0) return 'degraded';
  return 'progressing';
}

function podHealth(p) {
  const [ready, total] = p.ready.split('/').map(Number);
  if (p.status === 'Completed' || p.status === 'Succeeded') return 'unknown';
  if (p.status === 'Running' && ready === total) return 'healthy';
  if (p.status === 'Pending' || p.status === 'ContainerCreating') return 'progressing';
  return 'degraded';
}

const KIND_ICON = { namespace: LuBoxes, deployment: LuBox, pod: LuHexagon, service: LuGlobe, secret: LuLock, bucket: LuEllipsis };
const KIND_LABEL = { namespace: 'Namespace', deployment: 'Deployment', pod: 'Pod', service: 'Service', secret: 'Secret', bucket: 'Group' };
const HEALTH_GLYPH = { healthy: <LuCheck size={11} strokeWidth={3} />, degraded: <LuX size={11} strokeWidth={3} />, progressing: <LuLoader size={11} className="spin" />, unknown: null, neutral: null };

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

function Detail({ node, onClose }) {
  return (
    <div className="card res-detail">
      <div className="card-head">
        {React.createElement(KIND_ICON[node.kind], { size: 15, className: 'muted' })}
        <span className="card-title">{KIND_LABEL[node.kind]} · <strong>{node.title}</strong></span>
        <span className="spacer" />
        <IconButton size="sm" icon={<LuX size={15} />} title="Close details" onClick={onClose} />
      </div>
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
    </div>
  );
}

export default function DeploymentsView() {
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
  const [selected, setSelected] = useState(null);
  const [collapsed, setCollapsed] = useState(new Set());
  const [sideOpen, setSideOpen] = useLocalState('deploy.sideOpen', true);
  const [sideW, setSideW, resetSideW] = usePanelSize('deploy.side', 300, 240, () => Math.min(560, window.innerWidth - 420));

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

  useEffect(() => {
    if (!activeNamespace) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setSelected(null);
    const cfg = { env, namespace: activeNamespace, ...(env === 'devtest' ? { ssh: sshCfg() } : {}) };
    const podsCfg = { env, namespaces: [activeNamespace], ...(env === 'devtest' ? { ssh: sshCfg() } : {}) };
    Promise.all([api.oc.deployments(cfg), api.oc.services(cfg), api.pods(podsCfg), api.oc.secrets(cfg)])
      .then(([d, s, p, se]) => {
        if (cancelled) return;
        setResources({ deployments: d.deployments, services: s.services, pods: p.pods, secrets: se.secrets });
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNamespace, env]);

  const tree = useMemo(() => (activeNamespace ? buildTree(activeNamespace, resources) : null), [activeNamespace, resources]);

  useEffect(() => {
    if (!tree) return;
    // Every tier-1 branch (each deployment, each "Other ..." bucket) starts
    // collapsed. A deployment can reference dozens of secrets - if every branch
    // auto-expanded, the tree's total height could run into the tens of
    // thousands of pixels, and flexbox's align-items:center (which centers
    // each node against the full height of its own children) would push the
    // root node absurdly far down the page trying to center against that.
    // Collapsed-by-default keeps heights sane; expanding one branch at a time
    // is also just how you'd actually want to drill into this anyway.
    setCollapsed(new Set(tree.children.filter((n) => n.children.length > 0).map((n) => n.id)));
  }, [tree]);

  const toggleCollapse = (id) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
          <div className="workspace-scroll">
            {error && <div className="text-danger pad"><LuCircleAlert size={13} /> {error}</div>}
            <div className="rtree-scroll">
              <TreeBranch node={tree} selectedId={selected?.id} onSelect={setSelected} collapsed={collapsed} onToggleCollapse={toggleCollapse} />
            </div>
            {selected && <Detail node={selected} onClose={() => setSelected(null)} />}
          </div>
        )}
      </section>
    </div>
  );
}
