import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LuCircleAlert, LuEye, LuEyeOff, LuKeyRound, LuLoader, LuPlus, LuRefreshCw, LuSave, LuSearch, LuShieldAlert, LuTrash2, LuUndo2, LuX } from 'react-icons/lu';
import { api } from './api.js';
import { Badge, EmptyState, IconButton, Modal, Segmented, Select, useLocalState, useToast } from './ui.jsx';

const uid = () => Math.random().toString(36).slice(2, 9);
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const toRows = (entries) => entries.map((e) => ({ id: uid(), key: e.key, value: e.value, comment: e.comment, orig: e.value, isNew: false, deleted: false }));

function ReviewModal({ summary, busy, onClose, onWrite, creating }) {
  const part = (label, keys, tone) => keys.length > 0 && (
    <div className="env-sum">
      <Badge tone={tone}>{label}</Badge>
      <span className="mono">{keys.join(', ')}</span>
    </div>
  );
  return (
    <Modal
      title={creating ? 'Create .env' : 'Save .env'}
      icon={<LuSave size={16} />}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={onWrite}>{busy && <LuLoader size={14} className="spin" />} Write .env</button>
        </>
      }
    >
      <div className="stack">
        <div className="muted">Values are not shown here. Comments, order and everything you did not change stay as they are.</div>
        {part('added', summary.added, 'ok')}
        {part('changed', summary.changed, 'warn')}
        {part('removed', summary.removed, 'danger')}
        {!summary.added.length && !summary.changed.length && !summary.removed.length && <div className="muted">No changes.</div>}
        {creating && <div className="muted">The new file is created readable by you only.</div>}
      </div>
    </Modal>
  );
}

export default function EnvView({ active = true }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [mode, setMode] = useLocalState('env.mode', 'vars');
  const [raw, setRaw] = useState('');
  const [reveal, setReveal] = useState(false);
  const [shown, setShown] = useState({}); // per-row reveal
  const [q, setQ] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.env.get();
      setData(d);
      setRows(toRows(d.entries));
      setRaw(d.text);
      setShown({});
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

  const ops = useMemo(() => {
    const out = [];
    for (const r of rows) {
      if (r.isNew && !r.deleted) out.push({ op: 'add', key: r.key, value: r.value, comment: r.comment });
      else if (!r.isNew && r.deleted) out.push({ op: 'delete', key: r.key });
      else if (!r.isNew && r.value !== r.orig) out.push({ op: 'set', key: r.key, value: r.value });
    }
    return out;
  }, [rows]);
  const rawDirty = data && raw !== data.text;
  const dirty = mode === 'raw' ? rawDirty : ops.length > 0;

  const present = new Set(rows.filter((r) => !r.deleted).map((r) => r.key));
  const missing = (data?.known || []).filter((k) => !present.has(k.key));
  const emptyKeys = rows.filter((r) => !r.deleted && r.value === '').length;

  const addKey = (key, comment = '') => {
    if (!KEY_RE.test(key) || present.has(key)) return;
    const gone = rows.find((r) => r.key === key && r.deleted);
    if (gone) setRows((rs) => rs.map((r) => (r.id === gone.id ? { ...r, deleted: false } : r)));
    else setRows((rs) => [...rs, { id: uid(), key, value: '', comment, orig: undefined, isNew: true, deleted: false }]);
    setShown((s) => ({ ...s, [key]: true }));
  };

  const summary = useMemo(() => {
    if (mode === 'raw') return null;
    return {
      added: ops.filter((o) => o.op === 'add').map((o) => o.key),
      changed: ops.filter((o) => o.op === 'set').map((o) => o.key),
      removed: ops.filter((o) => o.op === 'delete').map((o) => o.key),
    };
  }, [ops, mode]);

  const write = async () => {
    setBusy(true);
    try {
      await api.env.save(mode === 'raw' ? { text: raw, hash: data.hash } : { ops, hash: data.hash });
      toast('.env saved');
      setReview(false);
      await load();
    } catch (e) {
      toast(e.message, 'error');
      setReview(false);
    } finally {
      setBusy(false);
    }
  };

  const openReview = async () => {
    if (mode === 'raw') {
      // the server works out the key-level summary; do a dry comparison here from the parsed lines
      const parse = (t) => Object.fromEntries(t.split('\n').map((l) => l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
      const a = parse(data.text);
      const b = parse(raw);
      setReview({ added: Object.keys(b).filter((k) => !(k in a)), removed: Object.keys(a).filter((k) => !(k in b)), changed: Object.keys(b).filter((k) => k in a && a[k] !== b[k]) });
    } else setReview(summary);
  };

  if (error && !data) return <EmptyState icon={<LuCircleAlert size={26} />} title="Could not read .env">{error}</EmptyState>;
  if (!data) return <EmptyState icon={<LuLoader size={24} className="spin" />} title="Reading .env…" />;

  const visible = rows.filter((r) => !q || r.key.toLowerCase().includes(q.toLowerCase()));
  const addOptions = missing.map((k) => ({ value: k.key, label: k.key, hint: k.file }));

  return (
    <div className="view col">
      <div className="tabstrip">
        <LuKeyRound size={15} className="muted" />
        <span className="tabstrip-title">.env</span>
        <Segmented size="sm" block={false} value={mode} onChange={setMode} options={[{ value: 'vars', label: 'Variables' }, { value: 'raw', label: 'Raw text' }]} />
        <span className="spacer" />
        <IconButton size="md" icon={<LuRefreshCw size={14} className={loading ? 'spin' : ''} />} title="Reload from disk (drops unsaved edits)" onClick={load} />
        <button type="button" className="btn" disabled={!dirty} onClick={() => { setRows(toRows(data.entries)); setRaw(data.text); }}><LuUndo2 size={14} /> Discard</button>
        <button type="button" className="btn primary" disabled={!dirty} onClick={openReview}><LuSave size={14} /> Review &amp; save{mode === 'vars' && ops.length ? ` (${ops.length})` : ''}</button>
      </div>

      {data.ignored === false && (
        <div className="notice warn banner">
          <LuShieldAlert size={15} />
          <div><b>.env is not ignored by git.</b> It usually holds secrets: add <span className="mono">.env</span> to the project's .gitignore before committing anything.</div>
        </div>
      )}
      {!data.exists && <div className="notice banner"><LuCircleAlert size={15} /><div>There is no .env yet. Saving creates it, readable by you only.</div></div>}
      {missing.length > 0 && mode === 'vars' && (
        <div className="notice banner">
          <LuCircleAlert size={15} />
          <div>
            {missing.length} variable{missing.length === 1 ? ' is' : 's are'} referenced by the project but not set:{' '}
            {missing.slice(0, 6).map((k) => (
              <button type="button" key={k.key} className="link-btn mono env-missing" onClick={() => addKey(k.key)} title={`Add ${k.key} (${k.file})`}>{k.key}</button>
            ))}
            {missing.length > 6 && <> and {missing.length - 6} more (use “Add a variable”)</>}
          </div>
        </div>
      )}

      {mode === 'raw' ? (
        <div className="env-raw">
          <textarea className="input textarea mono" value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} aria-label=".env contents" />
        </div>
      ) : (
        <>
          <div className="cfg-toolbar">
            <div className="search-box cfg-search">
              <LuSearch size={14} className="search-box-icon" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter variables" spellCheck={false} />
              {q && <IconButton size="xs" icon={<LuX size={13} />} title="Clear" onClick={() => setQ('')} />}
            </div>
            <Select className="cfg-add" searchable value="" placeholder="Add a variable…" options={addOptions} onChange={(k) => addKey(k, '')} disabled={!addOptions.length} title="Variables the project reads that are not set yet" />
            <div className="input-row cfg-custom">
              <input className="input" placeholder="Custom name" value={customKey} onChange={(e) => setCustomKey(e.target.value)} spellCheck={false} />
              <button type="button" className="btn" disabled={!KEY_RE.test(customKey) || present.has(customKey)} onClick={() => { addKey(customKey); setCustomKey(''); }}><LuPlus size={14} /> Add</button>
            </div>
            <span className="spacer" />
            <button type="button" className="btn" onClick={() => setReveal((v) => !v)} title="Show or hide every value">
              {reveal ? <LuEyeOff size={14} /> : <LuEye size={14} />} {reveal ? 'Hide values' : 'Show values'}
            </button>
          </div>
          <div className="cfg-list">
            {visible.map((r) => {
              const changed = r.isNew || (!r.isNew && r.value !== r.orig);
              const open = reveal || shown[r.key];
              return (
                <div key={r.id} className={`cfg-row env-row ${r.deleted ? 'deleted' : ''} ${changed && !r.deleted ? 'changed' : ''}`}>
                  <div className="cfg-key">
                    <span className="mono cfg-key-name">{r.key}</span>
                    {r.isNew && !r.deleted && <Badge tone="ok">new</Badge>}
                    {!r.isNew && changed && !r.deleted && <Badge tone="warn">edited</Badge>}
                    {r.deleted && <Badge tone="danger">will be removed</Badge>}
                    {r.value === '' && !r.deleted && <Badge tone="warn">empty</Badge>}
                    {r.comment && <div className="cfg-desc" title={r.comment}>{r.comment}</div>}
                  </div>
                  <div className="cfg-value">
                    {r.deleted ? (
                      <span className="muted">value hidden</span>
                    ) : (
                      <input
                        className="input mono"
                        type={open ? 'text' : 'password'}
                        value={r.value}
                        onChange={(e) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, value: e.target.value } : x)))}
                        placeholder="value"
                        spellCheck={false}
                        autoComplete="off"
                      />
                    )}
                  </div>
                  <div className="cfg-tools">
                    {!r.deleted && <IconButton size="sm" icon={open ? <LuEyeOff size={14} /> : <LuEye size={14} />} title={open ? 'Hide this value' : 'Show this value'} onClick={() => setShown((s) => ({ ...s, [r.key]: !s[r.key] }))} />}
                    {r.deleted ? (
                      <IconButton size="sm" icon={<LuUndo2 size={14} />} title="Keep it" onClick={() => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, deleted: false } : x)))} />
                    ) : r.isNew ? (
                      <IconButton size="sm" icon={<LuX size={14} />} title="Remove this new variable" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} />
                    ) : (
                      <>
                        {r.value !== r.orig && <IconButton size="sm" icon={<LuUndo2 size={14} />} title="Revert to the saved value" onClick={() => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, value: x.orig } : x)))} />}
                        <IconButton size="sm" icon={<LuTrash2 size={14} />} title="Delete this variable" onClick={() => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, deleted: true } : x)))} />
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            {!visible.length && (
              <EmptyState icon={<LuKeyRound size={24} />} title={q ? 'No variable matches' : 'No variables yet'}>
                {q ? 'Try another search.' : 'Add the variables the project needs with “Add a variable…”.'}
              </EmptyState>
            )}
            {emptyKeys > 0 && <div className="muted pad">{emptyKeys} variable{emptyKeys === 1 ? ' has' : 's have'} an empty value.</div>}
          </div>
        </>
      )}

      {review && <ReviewModal summary={review} busy={busy} creating={!data.exists} onClose={() => setReview(false)} onWrite={write} />}
    </div>
  );
}
