import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LuCircleAlert, LuFilePlus2, LuLoader, LuPlus, LuRefreshCw, LuSave, LuSearch, LuSlidersHorizontal, LuTrash2, LuUndo2, LuX } from 'react-icons/lu';
import { api } from './api.js';
import { ValueEditor, emptyValueFor, typeOf, TYPE_CHOICES, convertValue } from './CreateTestView.jsx';
import { Badge, DiffView, EmptyState, Field, IconButton, Modal, Segmented, Select, useLocalState, useToast } from './ui.jsx';

const TABS = [
  { value: 'namespaces', label: 'Namespaces' },
  { value: 'workflows', label: 'Workflows' },
  { value: 'endpoints', label: 'Endpoint interactions' },
];
const HINT = {
  namespaces: 'Values a namespace overrides: hosts, domains, credentials names, and any workflow or endpoint property.',
  workflows: 'What every workflow starts from before a scenario overrides it.',
  endpoints: 'What every endpoint interaction starts from before a scenario overrides it.',
};
const uid = () => Math.random().toString(36).slice(2, 9);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NS_RE = /^[A-Za-z0-9_.-]+$/;

const rowsFrom = (entries) => entries.map((e) => ({ id: uid(), key: e.key, value: e.value, comment: e.comment, orig: e.value, isNew: false, deleted: false }));

function NewNamespaceModal({ names, hash, onClose, onDone }) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = NS_RE.test(name) && !names.includes(name);
  const ops = useMemo(() => [{ op: 'addNamespace', name, copyFrom: from || undefined }], [name, from]);

  useEffect(() => {
    if (!valid) { setPreview(null); setError(''); return undefined; }
    let cancelled = false;
    api.defaultConfigs.preview({ section: 'namespaces', ops, hash }).then((r) => !cancelled && (setPreview(r), setError(''))).catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [valid, ops, hash]);

  const create = async () => {
    setBusy(true);
    try {
      await api.defaultConfigs.save({ section: 'namespaces', ops, hash });
      onDone(name);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New namespace"
      icon={<LuFilePlus2 size={16} />}
      width={760}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!valid || busy || !preview} onClick={create}>
            {busy && <LuLoader size={14} className="spin" />} Add namespace
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name" hint={name && !valid ? (names.includes(name) ? 'That namespace already exists.' : 'Use letters, digits and . _ -') : 'For example dev-main'}>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} spellCheck={false} placeholder="dev-new" />
        </Field>
        <Field label="Start from" hint="Copies every value (and its comment) from an existing namespace, which you can then adjust. Leave empty to start blank.">
          <Select value={from} onChange={setFrom} searchable options={[{ value: '', label: 'Blank namespace' }, ...names.map((n) => ({ value: n, label: n }))]} />
        </Field>
        {error && <div className="notice danger"><LuCircleAlert size={15} /><div>{error}</div></div>}
        {preview && <DiffView diff={preview.diff} empty="No change" />}
      </div>
    </Modal>
  );
}

function DeleteNamespaceModal({ name, hash, onClose, onDone }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ops = useMemo(() => [{ op: 'deleteNamespace', name }], [name]);
  useEffect(() => {
    let cancelled = false;
    api.defaultConfigs.preview({ section: 'namespaces', ops, hash }).then((r) => !cancelled && setPreview(r)).catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [ops, hash]);
  const remove = async () => {
    setBusy(true);
    try {
      await api.defaultConfigs.save({ section: 'namespaces', ops, hash });
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Delete namespace ${name}?`}
      icon={<LuTrash2 size={16} />}
      width={760}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn danger" disabled={busy || !preview} onClick={remove}>{busy && <LuLoader size={14} className="spin" />} Delete namespace</button>
        </>
      }
    >
      <div className="stack">
        <div className="notice warn"><LuCircleAlert size={15} /><div>Scenarios that list this namespace lose its defaults. The change is only in the file, so git can bring it back until you commit.</div></div>
        {error && <div className="notice danger"><LuCircleAlert size={15} /><div>{error}</div></div>}
        {preview && <DiffView diff={preview.diff} empty="No change" />}
      </div>
    </Modal>
  );
}

function ReviewModal({ groups, onClose, onSaved }) {
  const toast = useToast();
  const [previews, setPreviews] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all(groups.map((g) => api.defaultConfigs.preview({ section: g.section, ops: g.ops, hash: g.hash }).then((r) => ({ ...g, ...r }))))
      .then((r) => !cancelled && setPreviews(r))
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [groups]);

  const write = async () => {
    setBusy(true);
    try {
      for (const g of previews) if (g.changed) await api.defaultConfigs.save({ section: g.section, ops: g.ops, hash: g.hash });
      toast('Default configs saved — review and commit them in the Git tab');
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Save default configs"
      icon={<LuSave size={16} />}
      width={860}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !previews || !previews.some((p) => p.changed)} onClick={write}>
            {busy && <LuLoader size={14} className="spin" />} Write to file{previews && previews.filter((p) => p.changed).length > 1 ? 's' : ''}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="muted">Only the lines you changed are rewritten. Comments, ordering and formatting elsewhere in the files stay as they are.</div>
        {error && <div className="notice danger"><LuCircleAlert size={15} /><div>{error}</div></div>}
        {!previews && !error && <div className="muted"><LuLoader size={13} className="spin" /> Preparing the diff…</div>}
        {(previews || []).map((p) => (
          <div key={p.section} className="stack tight">
            <div className="mono small">{p.relPath}</div>
            <DiffView diff={p.diff} empty="No change" />
          </div>
        ))}
      </div>
    </Modal>
  );
}

export default function DefaultsView({ active = true }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useLocalState('defaults.tab', 'namespaces');
  const [ns, setNs] = useLocalState('defaults.ns', '');
  const [nsQ, setNsQ] = useState('');
  const [q, setQ] = useState('');
  const [drafts, setDrafts] = useState({}); // scope -> rows
  const [customKey, setCustomKey] = useState('');
  const [modal, setModal] = useState(null); // 'review' | 'newNs' | 'delNs'

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.defaultConfigs.get());
      setDrafts({});
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active && !data) load();
  }, [active, data, load]);

  const sectionData = data?.sections[tab];
  const nsList = data?.sections.namespaces.namespaces || [];
  const currentNs = tab === 'namespaces' ? (nsList.find((n) => n.name === ns) || nsList[0])?.name : '';
  const scope = `${tab}:${currentNs || ''}`;

  const baseEntries = useMemo(() => {
    if (!data) return [];
    if (tab === 'namespaces') return nsList.find((n) => n.name === currentNs)?.entries || [];
    return sectionData.entries;
  }, [data, tab, nsList, currentNs, sectionData]);

  const rows = drafts[scope] || rowsFrom(baseEntries);
  const setRows = (fn) => setDrafts((d) => ({ ...d, [scope]: fn(d[scope] || rowsFrom(baseEntries)) }));
  const patch = (id, p) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  const catalogFor = (section) => data?.catalog[section] || [];
  const propByKey = useMemo(() => Object.fromEntries(catalogFor(tab).map((p) => [p.key, p])), [data, tab]);

  // pending changes across every scope, grouped into one operation list per file
  const groups = useMemo(() => {
    if (!data) return [];
    const out = {};
    for (const [sc, rs] of Object.entries(drafts)) {
      const [section, nsName] = sc.split(/:(.*)/s);
      const ops = [];
      for (const r of rs) {
        const base = nsName ? { ns: nsName } : {};
        if (r.isNew && !r.deleted) ops.push({ op: 'add', ...base, key: r.key, value: r.value, comment: r.comment });
        else if (!r.isNew && r.deleted) ops.push({ op: 'delete', ...base, key: r.key });
        else if (!r.isNew && !same(r.value, r.orig)) ops.push({ op: 'set', ...base, key: r.key, value: r.value });
      }
      if (ops.length) (out[section] ||= { section, hash: data.sections[section].hash, ops: [] }).ops.push(...ops);
    }
    return Object.values(out);
  }, [drafts, data]);
  const pendingCount = groups.reduce((n, g) => n + g.ops.length, 0);
  const scopeDirty = (sc) => (drafts[sc] || []).some((r) => (r.isNew && !r.deleted) || (!r.isNew && (r.deleted || !same(r.value, r.orig))));

  const present = new Set(rows.filter((r) => !r.deleted).map((r) => r.key));
  const addOptions = [];
  const groupsDef = [['known', 'Documented'], ['code', 'Discovered from pytest code'], ['defaults', 'Seen in the defaults'], ['namespace', 'Environment defaults']];
  for (const [src, title] of groupsDef) {
    const g = catalogFor(tab).filter((p) => !present.has(p.key) && (src === 'known' ? p.source === 'known' || !p.source : p.source === src));
    if (g.length) {
      addOptions.push({ heading: true, disabled: true, label: title, value: `__h_${title}` });
      g.forEach((p) => addOptions.push({ value: p.key, label: p.key, hint: p.description ? String(p.description).slice(0, 60) : undefined }));
    }
  }

  const addKey = (key) => {
    if (!key) return;
    const prop = propByKey[key];
    const value = prop ? emptyValueFor(prop) : '';
    const existing = rows.find((r) => r.key === key && r.deleted);
    if (existing) return patch(existing.id, { deleted: false });
    setRows((rs) => [...rs, { id: uid(), key, value, comment: prop?.description && prop.source !== 'code' ? prop.description : '', orig: undefined, isNew: true, deleted: false }]);
    setQ('');
  };

  const visibleRows = rows.filter((r) => !q || r.key.toLowerCase().includes(q.toLowerCase()) || (r.comment || '').toLowerCase().includes(q.toLowerCase()));
  const visibleNs = nsList.filter((n) => n.name.toLowerCase().includes(nsQ.toLowerCase()));

  if (error && !data) return <EmptyState icon={<LuCircleAlert size={26} />} title="Could not read the default configs">{error}</EmptyState>;
  if (!data) return <EmptyState icon={<LuLoader size={24} className="spin" />} title="Reading the default configs…" />;

  return (
    <div className="view col">
      <div className="tabstrip">
        <LuSlidersHorizontal size={15} className="muted" />
        <span className="tabstrip-title">Default configs</span>
        <Segmented size="sm" block={false} value={tab} onChange={setTab} options={TABS.map((t) => ({ ...t, count: undefined }))} />
        <span className="spacer" />
        <IconButton size="md" icon={<LuRefreshCw size={14} className={loading ? 'spin' : ''} />} title="Reload from disk (drops unsaved edits)" onClick={load} />
        <button type="button" className="btn" disabled={!pendingCount} onClick={() => setDrafts({})}><LuUndo2 size={14} /> Discard</button>
        <button type="button" className="btn primary" disabled={!pendingCount} onClick={() => setModal('review')}>
          <LuSave size={14} /> Review &amp; save{pendingCount ? ` (${pendingCount})` : ''}
        </button>
      </div>

      <div className="view-main">
        {tab === 'namespaces' && (
          <aside className="panel side" style={{ width: 260 }}>
            <div className="panel-head">
              <span className="panel-title">Namespaces</span>
              <span className="count-pill">{nsList.length}</span>
              <span className="spacer" />
              <IconButton size="sm" icon={<LuPlus size={15} />} title="Add a namespace" onClick={() => setModal('newNs')} />
            </div>
            <div className="ft-controls">
              <div className="search-box">
                <LuSearch size={14} className="search-box-icon" />
                <input value={nsQ} onChange={(e) => setNsQ(e.target.value)} placeholder="Filter namespaces" spellCheck={false} />
              </div>
            </div>
            <div className="panel-scroll tight">
              {visibleNs.map((n) => (
                <button type="button" key={n.name} className={`pick-row split ${n.name === currentNs ? 'active' : ''}`} onClick={() => setNs(n.name)}>
                  <span className="mono ellipsis">{n.name}</span>
                  <span className="muted nowrap">{scopeDirty(`namespaces:${n.name}`) ? <span className="dirty-dot" title="Unsaved changes" /> : n.entries.length}</span>
                </button>
              ))}
              {!visibleNs.length && <div className="list-hint pad">No namespace matches.</div>}
            </div>
          </aside>
        )}

        <section className="workspace">
          <div className="cfg-head">
            <div className="cfg-head-text">
              <div className="cfg-title">
                {tab === 'namespaces' ? <>Namespace <span className="mono">{currentNs || '—'}</span></> : TABS.find((t) => t.value === tab).label}
              </div>
              <div className="muted">{HINT[tab]}</div>
            </div>
            <span className="spacer" />
            {tab === 'namespaces' && currentNs && (
              <button type="button" className="btn sm danger-ghost" onClick={() => setModal('delNs')}><LuTrash2 size={13} /> Delete namespace</button>
            )}
          </div>

          <div className="cfg-toolbar">
            <div className="search-box cfg-search">
              <LuSearch size={14} className="search-box-icon" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or description" spellCheck={false} />
              {q && <IconButton size="xs" icon={<LuX size={13} />} title="Clear" onClick={() => setQ('')} />}
            </div>
            <Select className="cfg-add" searchable value="" placeholder="Add a config…" options={addOptions} onChange={addKey} title="Choose a known config to add" />
            <div className="input-row cfg-custom">
              <input className="input" placeholder="Custom key" value={customKey} onChange={(e) => setCustomKey(e.target.value)} spellCheck={false} />
              <button type="button" className="btn" disabled={!/^[A-Za-z0-9_.-]+$/.test(customKey) || present.has(customKey)} onClick={() => { addKey(customKey); setCustomKey(''); }}>
                <LuPlus size={14} /> Add
              </button>
            </div>
          </div>

          <div className="cfg-list">
            {visibleRows.map((r) => {
              const prop = propByKey[r.key];
              const changed = r.isNew || (!r.isNew && !same(r.value, r.orig));
              return (
                <div key={r.id} className={`cfg-row ${r.deleted ? 'deleted' : ''} ${changed && !r.deleted ? 'changed' : ''}`}>
                  <div className="cfg-key">
                    <span className="mono cfg-key-name">{r.key}</span>
                    {r.isNew && !r.deleted && <Badge tone="ok">new</Badge>}
                    {!r.isNew && changed && !r.deleted && <Badge tone="warn">edited</Badge>}
                    {r.deleted && <Badge tone="danger">will be removed</Badge>}
                    {r.comment && <div className="cfg-desc" title={r.comment}>{r.comment}</div>}
                  </div>
                  <div className="cfg-value">
                    {r.deleted ? (
                      <span className="muted mono ellipsis">{typeof r.orig === 'object' ? JSON.stringify(r.orig) : String(r.orig ?? '')}</span>
                    ) : (
                      <ValueEditor propKey={r.key} value={r.value} prop={prop} suggestions={data.suggestions} onChange={(v) => patch(r.id, { value: v })} />
                    )}
                  </div>
                  <div className="cfg-tools">
                    {!r.deleted && (!prop || prop.type === 'auto') && (
                      <Select size="xs" value={typeOf(r.value)} options={TYPE_CHOICES} title="How this value is edited and written" onChange={(t) => patch(r.id, { value: convertValue(r.value, t) })} />
                    )}
                    {r.deleted ? (
                      <IconButton size="sm" icon={<LuUndo2 size={14} />} title="Keep it" onClick={() => patch(r.id, { deleted: false })} />
                    ) : r.isNew ? (
                      <IconButton size="sm" icon={<LuX size={14} />} title="Remove this new config" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} />
                    ) : !same(r.value, r.orig) ? (
                      <IconButton size="sm" icon={<LuUndo2 size={14} />} title="Revert to the saved value" onClick={() => patch(r.id, { value: r.orig })} />
                    ) : null}
                    {!r.deleted && !r.isNew && <IconButton size="sm" icon={<LuTrash2 size={14} />} title="Delete this config" onClick={() => patch(r.id, { deleted: true })} />}
                  </div>
                </div>
              );
            })}
            {!visibleRows.length && (
              <EmptyState icon={<LuSlidersHorizontal size={24} />} title={q ? 'No config matches' : 'Nothing defined here yet'}>
                {q ? 'Try another search.' : 'Use “Add a config…” to pick one from the list of known configs.'}
              </EmptyState>
            )}
          </div>
        </section>
      </div>

      {modal === 'review' && (
        <ReviewModal
          groups={groups}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
      {modal === 'newNs' && (
        <NewNamespaceModal
          names={nsList.map((n) => n.name)}
          hash={data.sections.namespaces.hash}
          onClose={() => setModal(null)}
          onDone={async (name) => { setModal(null); await load(); setNs(name); toast(`Added namespace ${name}`); }}
        />
      )}
      {modal === 'delNs' && currentNs && (
        <DeleteNamespaceModal
          name={currentNs}
          hash={data.sections.namespaces.hash}
          onClose={() => setModal(null)}
          onDone={async () => { setModal(null); setNs(''); await load(); toast(`Deleted namespace ${currentNs}`); }}
        />
      )}
    </div>
  );
}
