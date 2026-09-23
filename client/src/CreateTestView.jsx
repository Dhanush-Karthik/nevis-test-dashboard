import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, wsUrl } from './api.js';
import ScenarioFlow from './ScenarioFlow.jsx';
import LogPanel from './LogPanel.jsx';
import { TracesPanel, TraceSheet, TraceLinkContext, useRunTraces } from './tracing.jsx';
import FileTree from './FileTree.jsx';
import PodPicker, { podsFromKeys } from './PodPicker.jsx';
import AusweisAppControl from './AusweisAppControl.jsx';
import OutputFiles from './OutputFiles.jsx';
import { openPopout, setActiveRun, shortcutLabel } from './popout.js';
import {
  LuChevronDown, LuChevronRight, LuCircleAlert, LuCog, LuLayoutGrid, LuLoader, LuMaximize2, LuMinimize2, LuPanelBottomClose, LuPanelLeftClose,
  LuInfo, LuPanelLeftOpen, LuSlidersHorizontal, LuPlay, LuPlug, LuPlus, LuRefreshCw, LuSave, LuSearch, LuTrash2, LuX, LuCheck, LuWorkflow, LuBlocks, LuLibrary, LuFolderTree, LuUndo2, LuCode, LuCopy, LuChevronLeft, LuSquareArrowOutUpRight,
} from 'react-icons/lu';
import {
  Badge, Checkbox, Combobox, DiffView, EmptyState, Field, IconButton, Modal, Sash, Section, Segmented, Select, StatusDot, Switch, useLocalState, usePanelSize, useToast,
} from './ui.jsx';

const NODE_W = 210;
const NODE_H = 72;
const SNAP = 10;
const CANVAS_PAD = 140; // free space kept around the outermost block; the board grows only as far as the flow does

// Starter blocks for "build it from scratch". Deliberately minimal - anything
// not set falls back to config/defaults/*.yaml exactly like hand-written cases.
const TEMPLATES = [
  { id: 'register-user', group: 'Workflows', kind: 'workflow', title: 'Register user', hint: 'four-fields', def: { name: 'register-user', flow: 'register-user', method_ident: 'four-fields', reset_email: true, reset_online_id: true, expected_tokens: ['access-token'] } },
  { id: 'register-user-egk', group: 'Workflows', kind: 'workflow', title: 'Register user (EGK)', hint: 'method_ident: egk', def: { name: 'register-user-egk', flow: 'register-user', method_ident: 'egk', method_auth: 'egk', reset_kvnr: true, reset_email: true, expected_tokens: ['access-token'] } },
  { id: 'register-user-fake', group: 'Workflows', kind: 'workflow', title: 'Register user (fake-auth)', hint: 'method_ident: fake-auth', def: { name: 'register-user-fake-auth', flow: 'register-user', method_ident: 'fake-auth', reset_kvnr: true, reset_email: true, expected_tokens: ['access-token'] } },
  { id: 'login', group: 'Workflows', kind: 'workflow', title: 'Login (FIDO PIN)', hint: 'method_auth: fido-pin', def: { name: 'login', flow: 'login', method_auth: 'fido-pin', expected_tokens: ['access-token'] } },
  { id: 'login-egk', group: 'Workflows', kind: 'workflow', title: 'Login (EGK)', hint: 'method_auth: egk', def: { name: 'login-egk', flow: 'login', method_auth: 'egk', expected_tokens: ['access-token'] } },
  { id: 'login-stepup-eid', group: 'Workflows', kind: 'workflow', title: 'Step-up login (eID)', hint: 'method_ident: eid', def: { name: 'stepup-eid', flow: 'login', method_ident: 'eid', eid_card: 'user_matching', acr_values: 'gematik-ehealth-loa-high', expected_tokens: ['access-token'] } },
  { id: 'register-device', group: 'Workflows', kind: 'workflow', title: 'Register device', hint: 'new device, four-fields', def: { name: 'register-device', flow: 'register-device', method_ident: 'four-fields', device_registration_case: 'new_device', expected_tokens: ['access-token'] } },
  { id: 'register-device-otp', group: 'Workflows', kind: 'workflow', title: 'Register device (OTP)', hint: 'forgot PIN, method_ident: otp', def: { name: 'device-registration-otp', flow: 'register-device', method_ident: 'otp', device_registration_case: 'forgot_pin', expected_tokens: ['access-token'] } },
  { id: 'workflow', group: 'Workflows', kind: 'workflow', title: 'Workflow', hint: 'blank - pick any flow', def: { name: 'workflow', flow: '' } },
  { id: 'endpoint', group: 'Endpoints', kind: 'endpoint', title: 'Endpoint interaction', hint: 'single HTTP call', def: { name: 'endpoint-call', host: 'idp', endpoint: '/', method: 'GET', auth_config: { type: 'none' }, expected_status_code: 200 } },
  { id: 'ep-change-email', group: 'Endpoints', kind: 'endpoint', title: 'Change email', hint: 'POST /change-email', def: { name: 'change-email', host: 'idp', endpoint: '/change-email', method: 'POST', auth_config: { type: 'token' }, expected_status_code: 200 } },
  { id: 'ep-introspect', group: 'Endpoints', kind: 'endpoint', title: 'Introspect access token', hint: 'POST /oauth/introspect', def: { name: 'introspect-access-token', host: 'idbroker', endpoint: '/oauth/introspect', method: 'POST', auth_config: { type: 'none' }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: { token: '<file:output/access_token>' }, expected_status_code: 200 } },
  { id: 'ep-revoke', group: 'Endpoints', kind: 'endpoint', title: 'Revoke access token', hint: 'POST /oauth/revoke', def: { name: 'revoke-access-token', host: 'idbroker', endpoint: '/oauth/revoke', method: 'POST', store_session: true, auth_config: { type: 'none' }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: { token: '<file:output/access_token>' }, expected_status_code: 200 } },
  { id: 'ep-backend-token', group: 'Endpoints', kind: 'endpoint', title: 'Backend token', hint: 'GET /backend/token', def: { name: 'backend-token', host: 'idp', endpoint: '/backend/token', method: 'GET', auth_config: { type: 'basic', user: 'adapter' }, cert_config: { user: 'adapter' }, expected_status_code: 200 } },
  { id: 'ep-ident-cases', group: 'Endpoints', kind: 'endpoint', title: 'Ident cases', hint: 'GET /ident-cases', def: { name: 'ident-cases', host: 'idp', endpoint: '/ident-cases', method: 'GET', auth_config: { type: 'token' }, expected_status_code: 200 } },
];

const uid = () => Math.random().toString(36).slice(2, 9);
const clone = (v) => JSON.parse(JSON.stringify(v));
const snap = (n) => Math.max(0, Math.round(n / SNAP) * SNAP);
const parseList = (t) => t.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

export function typeOf(v) {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (Array.isArray(v)) return v.every((i) => ['string', 'number', 'boolean'].includes(typeof i)) ? 'list' : 'object';
  if (v && typeof v === 'object') return 'object';
  return 'string';
}

export function emptyValueFor(prop) {
  if (prop.defaultValue !== undefined && prop.defaultValue !== null) return clone(prop.defaultValue);
  return { boolean: false, list: [], number: 0, object: {}, string: '' }[prop.type] ?? '';
}

function newScenario(n) {
  return { id: uid(), name: '', description: '', labelsText: '', namespaces: [], clearOutput: null, nodes: [], edges: [], _n: n };
}

// The sequence is the single chain formed by the edges. Anything that isn't one
// unbroken chain is reported instead of guessed at.
function computeSequence(sc) {
  const out = new Map();
  const inc = new Map();
  sc.edges.forEach((e) => {
    out.set(e.from, e.to);
    inc.set(e.to, e.from);
  });
  const problems = [];
  if (!sc.nodes.length) return { order: [], problems: ['Drag a block onto the canvas to start.'] };
  const heads = sc.nodes.filter((n) => !inc.has(n.id));
  const order = [];
  if (heads.length === 1) {
    let cur = heads[0].id;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      order.push(cur);
      cur = out.get(cur);
    }
  }
  if (order.length !== sc.nodes.length) {
    problems.push('Connect all blocks into one chain (drag from a block\'s right dot to the next block\'s left dot).');
  }
  return { order: problems.length ? [] : order, problems };
}

function ChipsInput({ value, onChange, suggestions = [], placeholder, invalid }) {
  const [text, setText] = useState('');
  const add = (raw) => {
    const v = raw.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setText('');
  };
  const rest = suggestions.filter((x) => !value.includes(x));
  return (
    <div className={`chips ${invalid ? 'invalid' : ''}`}>
      {value.map((v, i) => (
        <span className="chip" key={`${v}-${i}`}>
          {String(v)}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((_, j) => j !== i))}><LuX size={12} /></button>
        </span>
      ))}
      <ChipInputInner text={text} setText={setText} add={add} rest={rest} placeholder={placeholder} onBackspace={() => value.length && onChange(value.slice(0, -1))} />
    </div>
  );
}

function ChipInputInner({ text, setText, add, rest, placeholder, onBackspace }) {
  return (
    <Combobox
      bare
      value={text}
      suggestions={rest}
      placeholder={placeholder || 'Add…'}
      onCommit={(v) => add(v)}
      onChange={(v) => (/[,\s]$/.test(v) ? add(v.slice(0, -1)) : setText(v))}
      onKeyDownExtra={(e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          add(text);
        } else if (e.key === 'Backspace' && !text) onBackspace();
      }}
      onBlurExtra={() => add(text)}
    />
  );
}

function JsonEditor({ value, onChange }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState('');
  return (
    <div>
      <textarea
        className="input textarea mono"
        rows={Math.min(10, Math.max(3, text.split('\n').length))}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setError('');
          } catch (err) {
            setError('Invalid JSON - not applied yet');
          }
        }}
      />
      {error && <div className="text-danger small">{error}</div>}
    </div>
  );
}

export function ValueEditor({ propKey, value, prop, suggestions, onChange }) {
  const t = value === null || value === undefined ? prop?.type || 'string' : typeOf(value);
  if (t === 'boolean') return <Switch checked={!!value} onChange={onChange} label={String(!!value)} />;
  if (t === 'number') return <input className="input" type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
  if (t === 'list') return <ChipsInput value={Array.isArray(value) ? value : []} onChange={onChange} suggestions={suggestions?.[propKey] || []} />;
  if (t === 'object') return <JsonEditor value={value ?? {}} onChange={onChange} />;
  if (prop?.options && prop.options.length) {
    const opts = prop.options.includes(value) || value === undefined || value === '' ? prop.options : [value, ...prop.options];
    return <Select value={value ?? ''} onChange={onChange} options={opts} placeholder="—" />;
  }
  const long = typeof value === 'string' && (value.length > 60 || value.includes('\n'));
  return long ? (
    <textarea className="input textarea mono" rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
  ) : (
    <Combobox value={value ?? ''} suggestions={suggestions?.[propKey] || []} onChange={onChange} />
  );
}

export const TYPE_CHOICES = [
  { value: 'string', label: 'text' },
  { value: 'boolean', label: 'true / false' },
  { value: 'number', label: 'number' },
  { value: 'list', label: 'list' },
  { value: 'object', label: 'json' },
];

export function convertValue(value, to) {
  if (to === 'boolean') return value === true || value === 'true';
  if (to === 'number') return Number(value) || 0;
  if (to === 'list') return Array.isArray(value) ? value : value === '' || value == null ? [] : String(value).split(/[\s,]+/).filter(Boolean);
  if (to === 'object') return value && typeof value === 'object' ? value : {};
  return typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
}

const KindIcon = ({ kind, size = 15 }) => (kind === 'workflow' ? <LuCog size={size} /> : <LuPlug size={size} />);

function scenarioYamlSections(s) {
  const seq = computeSequence(s);
  const byId = Object.fromEntries(s.nodes.map((n) => [n.id, n]));
  const nodes = (seq.order.length ? seq.order.map((id) => byId[id]) : s.nodes);
  const uniq = (kind) => {
    const seen = new Map();
    nodes.filter((n) => n.kind === kind).forEach((n) => seen.set(n.def.name, n.def));
    return [...seen.values()];
  };
  return [
    { key: 'workflows', items: uniq('workflow') },
    { key: 'endpoint_interactions', items: uniq('endpoint') },
    { key: 'scenarios', items: [{ name: s.name.trim(), description: s.description.trim(), supported_namespaces: s.namespaces, labels: parseList(s.labelsText), ...(typeof s.clearOutput === 'boolean' ? { clear_output: s.clearOutput } : {}), sequence: nodes.map((n) => n.def.name) }] },
  ];
}

const YAML_KEY_RE = /^(\s*(?:-\s+)?)([A-Za-z0-9_.-]+)(:)(\s.*|)$/;
const YAML_TOKEN_RE = /(#.*$)|("(?:[^"\\]|\\.)*"|'[^']*')|\b(true|false|null|-?\d+(?:\.\d+)?)\b/g;

function highlightValue(text, keyBase) {
  const out = [];
  let last = 0;
  let m;
  YAML_TOKEN_RE.lastIndex = 0;
  while ((m = YAML_TOKEN_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const cls = m[1] ? 'y-comment' : m[2] ? 'y-str' : 'y-lit';
    out.push(<span key={`${keyBase}-${m.index}`} className={cls}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function highlightLine(line, i) {
  if (/^\s*#/.test(line)) return <span className="y-comment">{line}</span>;
  const m = line.match(YAML_KEY_RE);
  if (m) {
    return (
      <>
        {m[1].includes('-') ? <>{m[1].replace(/-\s+$/, '')}<span className="y-dash">-</span> </> : m[1]}
        <span className="y-key">{m[2]}</span>
        <span className="y-punct">{m[3]}</span>
        {highlightValue(m[4], i)}
      </>
    );
  }
  const d = line.match(/^(\s*)-(\s.*|)$/);
  if (d) return <>{d[1]}<span className="y-dash">-</span>{highlightValue(d[2], i)}</>;
  return highlightValue(line, i);
}

// Editable YAML for the active scenario, shown in place of the board. Edits are parsed on the
// server and applied to the board whenever the text is valid; the board keeps the last valid state.
function YamlEditor({ scenario, focusName, onApply, onError }) {
  const [text, setText] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [status, setStatus] = useState({ kind: 'ok', msg: 'In sync with the board' });
  const [cursor, setCursor] = useState({ ln: 1, col: 1 });
  const taRef = useRef(null);
  const hlRef = useRef(null);
  const gutRef = useRef(null);
  const base = useRef('');
  const applied = useRef('');
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    api.builder.yaml(scenarioYamlSections(scenario)).then((r) => {
      if (cancelled) return;
      base.current = r.document;
      applied.current = r.document;
      setText(r.document);
    }).catch((e) => !cancelled && setLoadErr(e.message));
    return () => { cancelled = true; };
    // the text is generated once per mount; afterwards the editor owns it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => onError(''), [onError]);

  // jump to the block the user came from
  useEffect(() => {
    if (text === null || !focusName || !taRef.current) return;
    const lines = text.split('\n');
    const idx = lines.findIndex((l) => l.includes(`name: "${focusName}"`) || l.includes(`name: ${focusName}`));
    if (idx < 0) return;
    const ta = taRef.current;
    const start = lines.slice(0, idx).reduce((n, l) => n + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(start, start + lines[idx].length);
    ta.scrollTop = Math.max(0, idx * 19 - 80);
    syncScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text === null, focusName]);

  useEffect(() => {
    if (text === null || text === applied.current) return undefined;
    setStatus({ kind: 'pending', msg: 'Checking…' });
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.builder.parse(text);
        if (cancelled) return;
        if (!r.ok) {
          const msg = `${r.line ? `Line ${r.line}: ` : ''}${r.error}`;
          setStatus({ kind: 'error', msg });
          onError(msg);
          return;
        }
        const err = onApply(r.doc);
        if (err) {
          setStatus({ kind: 'error', msg: err });
          onError(err);
        } else {
          applied.current = text;
          setStatus({ kind: 'ok', msg: text === base.current ? 'In sync with the board' : 'Applied to the board' });
          onError('');
        }
      } catch (e) {
        if (!cancelled) setStatus({ kind: 'error', msg: e.message });
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  function syncScroll() {
    const ta = taRef.current;
    if (!ta) return;
    if (hlRef.current) hlRef.current.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    if (gutRef.current) gutRef.current.style.transform = `translateY(${-ta.scrollTop}px)`;
  }

  const trackCursor = () => {
    const ta = taRef.current;
    if (!ta) return;
    const before = ta.value.slice(0, ta.selectionStart).split('\n');
    setCursor({ ln: before.length, col: before[before.length - 1].length + 1 });
  };

  const insert = (str) => {
    const ta = taRef.current;
    ta.focus();
    if (!document.execCommand('insertText', false, str)) {
      ta.setRangeText(str, ta.selectionStart, ta.selectionEnd, 'end');
      setText(ta.value);
    }
  };

  const onKeyDown = (e) => {
    const ta = e.currentTarget;
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      insert('  ');
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const start = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      if (ta.value.startsWith('  ', start)) {
        const keep = ta.selectionStart;
        ta.setSelectionRange(start, start + 2);
        insert('');
        ta.setSelectionRange(Math.max(start, keep - 2), Math.max(start, keep - 2));
      }
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const start = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      const line = ta.value.slice(start, ta.selectionStart);
      const indent = line.match(/^\s*/)[0];
      const extra = /:\s*$/.test(line) ? '  ' : /^\s*-\s+\S/.test(line) ? '  ' : '';
      insert(`\n${indent}${extra}`);
    }
  };

  if (loadErr) return <EmptyState icon={<LuCircleAlert size={24} />} title="Could not build the YAML">{loadErr}</EmptyState>;
  if (text === null) return <EmptyState icon={<LuLoader size={22} className="spin" />} title="Building YAML…" />;

  const lines = text.split('\n');
  return (
    <div className="yed">
      <div className="yed-bar">
        <LuCode size={14} className="muted" />
        <span className="yed-title">scenario.yaml</span>
        <span className="yed-note">Edits apply to the board as you type. Comments are not kept.</span>
        <span className="spacer" />
        <IconButton
          size="sm"
          icon={<LuCopy size={14} />}
          title="Copy YAML"
          onClick={() => navigator.clipboard?.writeText(text).then(() => toast('YAML copied')).catch(() => toast('Could not copy', 'error'))}
        />
        <IconButton size="sm" icon={<LuUndo2 size={14} />} title="Reset to the board's YAML" disabled={text === base.current} onClick={() => setText(base.current)} />
      </div>
      <div className="yed-code">
        <div className="yed-gutter"><div ref={gutRef}>{lines.map((_, i) => <div key={i} className={cursor.ln === i + 1 ? 'cur' : ''}>{i + 1}</div>)}</div></div>
        <div className="yed-main">
          <pre className="yed-hl yed-text" ref={hlRef} aria-hidden="true">{lines.map((l, i) => <div key={i}>{highlightLine(l, i) || ' '}</div>)}</pre>
          <textarea
            ref={taRef}
            className="yed-ta yed-text"
            value={text}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Scenario YAML"
            onChange={(e) => setText(e.target.value)}
            onScroll={syncScroll}
            onKeyDown={onKeyDown}
            onKeyUp={trackCursor}
            onClick={trackCursor}
            onSelect={trackCursor}
          />
        </div>
      </div>
      <div className={`yed-status ${status.kind}`}>
        {status.kind === 'error' ? <LuCircleAlert size={13} /> : status.kind === 'pending' ? <LuLoader size={13} className="spin" /> : <LuCheck size={13} />}
        <span className="yed-msg">{status.msg}</span>
        {status.kind === 'error' && <span className="muted">Board keeps the last valid version; test and save are paused.</span>}
        <span className="spacer" />
        <span className="muted">Ln {cursor.ln}, Col {cursor.col} · YAML · {lines.length} lines</span>
      </div>
    </div>
  );
}

function Inspector({ node, schema, onChange, onDelete, onCopy }) {
  const [customKey, setCustomKey] = useState('');
  if (!node) {
    return (
      <EmptyState icon={<LuBlocks size={24} />} title="No block selected">
        Select a block on the board to configure it. Every property is optional except the ones marked <b>*</b>.
      </EmptyState>
    );
  }

  const props = node.kind === 'workflow' ? schema.workflowProps : schema.endpointProps;
  const byKey = Object.fromEntries(props.map((p) => [p.key, p]));
  const keys = Object.keys(node.def).filter((k) => k !== 'name');
  const available = props.filter((p) => p.key !== 'name' && !(p.key in node.def));
  const setDef = (patch) => onChange({ ...node, def: { ...node.def, ...patch } });
  const removeKey = (k) => {
    const next = { ...node.def };
    delete next[k];
    onChange({ ...node, def: next });
  };
  const required = node.kind === 'workflow' ? ['flow'] : ['host', 'endpoint', 'method'];

  const addOptions = [];
  [['', 'Documented'], ['code', 'Discovered from pytest code'], ['namespace', 'Environment defaults']].forEach(([src, title]) => {
    const group = available.filter((p) => (src === '' ? p.source !== 'code' && p.source !== 'namespace' : p.source === src));
    if (group.length) {
      addOptions.push({ heading: true, disabled: true, label: title, value: `__h_${title}` });
      group.forEach((p) => addOptions.push({ value: p.key, label: p.key }));
    }
  });

  return (
    <div className="inspector">
      <div className="card-head">
        <span className="muted"><KindIcon kind={node.kind} /></span>
        <span className="card-title">{node.kind === 'workflow' ? 'Workflow' : 'Endpoint interaction'}</span>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={onCopy} title="Copy this block (⌘/Ctrl+C) - paste it into any scenario with ⌘/Ctrl+V">
          <LuCopy size={13} /> Copy
        </button>
        <button type="button" className="btn sm danger-ghost" onClick={onDelete}>
          <LuTrash2 size={13} /> Delete
        </button>
      </div>
      {node.origin && <div className="origin-line">From <span className="mono">{node.origin}</span></div>}

      <div className="inspector-body">
        <Field label={<>name <span className="req">*</span></>} hint="Unique in the file. The scenario sequence references it.">
          <input className="input" value={node.def.name || ''} onChange={(e) => setDef({ name: e.target.value })} spellCheck={false} />
        </Field>

        {keys.map((k) => (
          <Field
            key={`${node.id}-${k}`}
            label={
              <>
                {k}
                {required.includes(k) && <span className="req"> *</span>}
                {byKey[k]?.source === 'code' && <Badge title="Found by scanning the pytest code">auto</Badge>}
              </>
            }
            right={
              <span className="field-tools">
                {(!byKey[k] || byKey[k].type === 'auto') && (
                  <Select size="xs" value={typeOf(node.def[k])} options={TYPE_CHOICES} title="How this value is edited and written" onChange={(t) => setDef({ [k]: convertValue(node.def[k], t) })} />
                )}
                {!required.includes(k) && <IconButton size="xs" icon={<LuX size={13} />} title="Remove property" onClick={() => removeKey(k)} />}
              </span>
            }
            hint={byKey[k]?.description}
          >
            <ValueEditor propKey={k} value={node.def[k]} prop={byKey[k]} suggestions={schema.suggestions} onChange={(v) => setDef({ [k]: v })} />
          </Field>
        ))}

        <div className="add-prop">
          <div className="section-caption">Add property</div>
          <Select
            value=""
            placeholder="Choose a known property…"
            searchable
            options={addOptions}
            onChange={(k) => k && setDef({ [k]: emptyValueFor(byKey[k]) })}
          />
          <div className="input-row">
            <input className="input" placeholder="Custom property name" value={customKey} onChange={(e) => setCustomKey(e.target.value)} spellCheck={false} />
            <button
              type="button"
              className="btn"
              disabled={!/^[A-Za-z0-9_-]+$/.test(customKey) || customKey in node.def}
              onClick={() => {
                setDef({ [customKey]: '' });
                setCustomKey('');
              }}
            >
              <LuPlus size={14} /> Add
            </button>
          </div>
        </div>

        <div className="foot-note">
          {schema.discovered.workflow + schema.discovered.endpoint} properties were auto-discovered from <span className="mono">lib/*.py</span>. New ones appear here without manual entry.
        </div>
      </div>
    </div>
  );
}

const fileLabel = (rel) => rel.replace(/^config\//, '').replace(/_?scenarios?_?config\.yaml$|\.yaml$/i, '');

function summarizeDef(def) {
  return Object.entries(def)
    .filter(([k]) => k !== 'name')
    .slice(0, 9)
    .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
}

function LibraryRow({ item, expanded, onToggle, onAdd, onDragStart, query = '' }) {
  const needle = query.trim().toLowerCase();
  const hitLabels = needle ? (item.labels || []).filter((l) => l.toLowerCase().includes(needle)) : [];
  const chips =
    item.kind === 'workflow'
      ? [item.def.flow, item.def.method_ident || item.def.method_auth].filter(Boolean)
      : [item.def.method, item.def.host].filter(Boolean);
  return (
    <div className={`lib-row kind-${item.kind} ${expanded ? 'open' : ''}`}>
      <div className="lib-row-main" draggable onDragStart={onDragStart} onClick={onToggle} title="Click for details · drag onto the board">
        <LuChevronRight size={13} className="lib-row-chevron" />
        <div className="lib-row-text">
          <div className="lib-row-name">{item.name}</div>
          <div className="lib-row-chips">
            {chips.map((c) => (
              <span key={c} className="chip-tag">{c}</span>
            ))}
            {item.kind === 'endpoint' && item.def.endpoint && <span className="lib-path mono">{item.def.endpoint}</span>}
          </div>
          {hitLabels.length > 0 && (
            <div className="lib-row-chips">
              {hitLabels.slice(0, 3).map((l) => <span key={l} className="chip-tag label" title="A scenario using this block has this label">{l}</span>)}
              {hitLabels.length > 3 && <span className="muted small">+{hitLabels.length - 3}</span>}
            </div>
          )}
        </div>
        <IconButton size="sm" icon={<LuPlus size={15} />} title="Add to board" className="lib-add" onClick={(e) => { e.stopPropagation(); onAdd(); }} />
      </div>
      {expanded && (
        <div className="lib-detail">
          {summarizeDef(item.def).map(([k, v]) => (
            <div key={k} className="lib-kv"><span>{k}</span><span className="mono">{v.length > 70 ? `${v.slice(0, 70)}…` : v}</span></div>
          ))}
          <div className="lib-detail-foot">
            <span className="muted">Used {item.count}× · <span className="mono">{item.source}</span>{(item.labels || []).length > 0 && <> · labels {item.labels.slice(0, 6).join(', ')}{item.labels.length > 6 ? '…' : ''}</>}</span>
            <button type="button" className="btn sm" onClick={onAdd}><LuPlus size={13} /> Add to board</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Palette({ catalog, onAdd, onReload, reloading, onCollapse }) {
  const [tab, setTab] = useState('blocks'); // starters are shown first
  const [sq, setSq] = useState('');
  const [kind, setKind] = useState('workflow');
  const [q, setQ] = useState('');
  // a search result asked for a block: show the library filtered to it
  useEffect(() => {
    const take = () => {
      const w = window.__pendingLibrary;
      if (!w) return;
      window.__pendingLibrary = null;
      setTab('library');
      setKind(w.kind);
      setQ(w.query);
    };
    take();
    window.addEventListener('nevis-library', take);
    return () => window.removeEventListener('nevis-library', take);
  }, []);
  const [f1, setF1] = useState('');
  const [f2, setF2] = useState('');
  const [group, setGroup] = useState('file');
  const [openGroups, setOpenGroups] = useState(new Set());
  const [expandedRow, setExpandedRow] = useState(null);
  const list = kind === 'workflow' ? catalog.workflows : catalog.endpoints;

  const facets = useMemo(() => {
    const a = new Set();
    const b = new Set();
    for (const x of list) {
      if (kind === 'workflow') {
        if (x.def.flow) a.add(x.def.flow);
        if (x.def.method_ident) b.add(x.def.method_ident);
        if (x.def.method_auth) b.add(x.def.method_auth);
      } else {
        if (x.def.host) a.add(x.def.host);
        if (x.def.method) b.add(String(x.def.method));
      }
    }
    return { a: [...a].sort(), b: [...b].sort() };
  }, [list, kind]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list.filter((x) => {
      if (f1 && (kind === 'workflow' ? x.def.flow : x.def.host) !== f1) return false;
      if (f2 && ![x.def.method_ident, x.def.method_auth, x.def.method].map(String).includes(f2)) return false;
      if (!needle) return true;
      return x.name.toLowerCase().includes(needle) || x.source.toLowerCase().includes(needle) || (x.labels || []).some((l) => l.toLowerCase().includes(needle)) || JSON.stringify(x.def).toLowerCase().includes(needle);
    });
  }, [list, q, f1, f2, kind]);

  const groups = useMemo(() => {
    if (group !== 'file') return null;
    const m = new Map();
    for (const x of filtered) (m.get(x.source) || m.set(x.source, []).get(x.source)).push(x);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [filtered, group]);

  const filtering = Boolean(q.trim() || f1 || f2);
  const dragStart = (e, item) => {
    e.dataTransfer.setData('application/x-bld', JSON.stringify({ kind: item.kind, def: item.def, origin: item.source }));
    e.dataTransfer.effectAllowed = 'copy';
  };
  const toggleGroup = (g) =>
    setOpenGroups((s) => {
      const n = new Set(s);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });
  const rowFor = (x, i) => {
    const id = `${x.source}::${x.name}::${i}`;
    return (
      <LibraryRow
        query={q}
        key={id}
        item={x}
        expanded={expandedRow === id}
        onToggle={() => setExpandedRow(expandedRow === id ? null : id)}
        onAdd={() => onAdd({ kind: x.kind, def: x.def, origin: x.source })}
        onDragStart={(e) => dragStart(e, x)}
      />
    );
  };
  const switchKind = (k) => {
    setKind(k);
    setF1('');
    setF2('');
  };

  return (
    <>
      <div className="panel-head slim">
        <Segmented
          size="sm"
          block={false}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'blocks', label: 'Starters', icon: <LuBlocks size={14} /> },
            { value: 'library', label: 'Library', icon: <LuLibrary size={14} /> },
          ]}
        />
        <span className="spacer" />
        {tab === 'library' && <IconButton size="sm" icon={<LuRefreshCw size={14} className={reloading ? 'spin' : ''} />} title="Re-read the repo (config files and pytest code)" onClick={onReload} disabled={reloading} />}
        <IconButton size="sm" icon={<LuPanelLeftClose size={15} />} title="Hide blocks" onClick={onCollapse} />
      </div>

      {tab === 'blocks' ? (
        <div className="panel-scroll">
          <div className="lib-controls">
            <div className="search-box">
              <LuSearch size={14} className="search-box-icon" />
              <input autoFocus placeholder="Search starters (register, login, token…)" value={sq} onChange={(e) => setSq(e.target.value)} spellCheck={false} />
              {sq && <IconButton size="xs" icon={<LuX size={13} />} title="Clear search" onClick={() => setSq('')} />}
            </div>
          </div>
          {['Workflows', 'Endpoints'].map((g) => {
            const list = TEMPLATES.filter((t) => t.group === g && (!sq.trim() || `${t.title} ${t.hint} ${t.def.name} ${t.def.flow || ''} ${t.def.endpoint || ''}`.toLowerCase().includes(sq.trim().toLowerCase())));
            return list.length ? (
            <div key={g} className="starter-group">
              <div className="starter-group-title">{g} <em>{list.length}</em></div>
              {list.map((t) => (
                <div
                  key={t.id}
                  className={`starter kind-${t.kind}`}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('application/x-bld', JSON.stringify({ kind: t.kind, def: t.def, origin: null }))}
                  onClick={() => onAdd({ kind: t.kind, def: t.def, origin: null })}
                >
                  <span className="starter-icon"><KindIcon kind={t.kind} size={16} /></span>
                  <div className="starter-text">
                    <div className="starter-title">{t.title}</div>
                    <div className="starter-sub">{t.hint}</div>
                  </div>
                  <LuPlus size={15} className="muted starter-plus" />
                </div>
              ))}
            </div>
            ) : null;
          })}
          {sq.trim() && !TEMPLATES.some((t) => `${t.title} ${t.hint} ${t.def.name}`.toLowerCase().includes(sq.trim().toLowerCase())) && (
            <div className="list-hint">No starter matches. <button type="button" className="link-btn" onClick={() => { window.__pendingLibrary = { kind: 'workflow', query: sq.trim() }; window.dispatchEvent(new Event('nevis-library')); setSq(''); }}>Search the library for “{sq.trim()}”</button></div>
          )}
        </div>
      ) : (
        <>
          <div className="lib-controls">
            <Segmented
              size="sm"
              value={kind}
              onChange={switchKind}
              options={[
                { value: 'workflow', label: 'Workflows', count: catalog.workflows.length },
                { value: 'endpoint', label: 'Endpoints', count: catalog.endpoints.length },
              ]}
            />
            <div className="search-box">
              <LuSearch size={14} className="search-box-icon" />
              <input placeholder="Search name, label, file or property" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
              {q && <IconButton size="xs" icon={<LuX size={13} />} title="Clear search" onClick={() => setQ('')} />}
            </div>
            <div className="lib-filters">
              <Select size="sm" value={f1} onChange={setF1} searchable options={[{ value: '', label: kind === 'workflow' ? 'Flow' : 'Host' }, ...facets.a]} />
              <Select size="sm" value={f2} onChange={setF2} searchable options={[{ value: '', label: kind === 'workflow' ? 'Method' : 'Verb' }, ...facets.b]} />
              <Select size="sm" value={group} onChange={setGroup} options={[{ value: 'file', label: 'By file' }, { value: 'none', label: 'Flat' }]} title="Grouping" />
            </div>
            <div className="lib-count">
              <span>{filtered.length} of {list.length}</span>
              {filtering && <button type="button" className="link-btn" onClick={() => { setQ(''); setF1(''); setF2(''); }}>Clear filters</button>}
            </div>
          </div>

          <div className="panel-scroll tight">
            {group === 'file'
              ? groups.map(([file, items]) => {
                  const open = filtering || openGroups.has(file);
                  return (
                    <div key={file} className="lib-group">
                      <button type="button" className="lib-group-head" onClick={() => toggleGroup(file)} title={file} aria-expanded={open}>
                        {open ? <LuChevronDown size={14} /> : <LuChevronRight size={14} />}
                        <span className="lib-group-name">{fileLabel(file)}</span>
                        <span className="count-pill">{items.length}</span>
                      </button>
                      {open && items.slice(0, 120).map(rowFor)}
                    </div>
                  );
                })
              : filtered.slice(0, 250).map(rowFor)}
            {!filtered.length && <div className="list-hint">No match.</div>}
          </div>
        </>
      )}
    </>
  );
}

function bezier(a, b) {
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const dx = Math.max(50, Math.abs(x2 - x1) / 2);
  return { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
}

function SaveModal({ payload, chainProblems, onClose }) {
  const [mode, setMode] = useState('new');
  const [ticket, setTicket] = useState('');
  const [files, setFiles] = useState(null);
  const [fileQ, setFileQ] = useState('');
  const [target, setTarget] = useState('');
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [validation, setValidation] = useState(null);

  useEffect(() => {
    if (mode === 'append' && !files) api.builder.files().then((r) => setFiles(r.files)).catch(() => setFiles([]));
  }, [mode, files]);

  const body = mode === 'append' ? { ...payload, mode: 'append', targetFile: target } : { ...payload, ticket: ticket.trim() };
  const ready = mode === 'append' ? !!target : !!ticket.trim();

  useEffect(() => {
    setResult(null);
    if (!ready || chainProblems.length) {
      setPreview(null);
      return undefined;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api.builder.preview(body).then((r) => !cancelled && setPreview(r)).catch(() => {});
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, ticket, target, payload, chainProblems]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.builder.save(body);
      setResult(r);
      if (r.ok) {
        const checks = [];
        for (const sc of r.scenarios) {
          const uuid = sc.labels.find((l) => /^[0-9a-f]{8}-/.test(l));
          checks.push({ name: sc.name, ...(await api.builder.validate({ label: uuid, namespace: sc.namespaces[0] })) });
          setValidation([...checks]);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const visibleFiles = (files || []).filter((f) => f.relPath.toLowerCase().includes(fileQ.toLowerCase())).slice(0, 80);
  const done = !chainProblems.length && result?.saved;

  return (
    <Modal
      title="Save to the repo"
      icon={<LuSave size={16} />}
      onClose={onClose}
      footer={
        done ? (
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        ) : chainProblems.length ? (
          <button type="button" className="btn" onClick={onClose}>Close</button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={!preview?.ok || saving} onClick={save}>
              {saving && <LuLoader size={14} className="spin" />}
              {saving ? 'Writing…' : mode === 'append' ? 'Append to file' : 'Create file'}
            </button>
          </>
        )
      }
    >
      {chainProblems.length > 0 ? (
        <div className="stack">
          <div className="notice warn"><LuCircleAlert size={15} /><div>{chainProblems.map((p) => <div key={p}>{p}</div>)}</div></div>
        </div>
      ) : done ? (
        <div className="stack">
          <div className="notice ok">
            <LuCheck size={15} />
            <div>
              {result.mode === 'append' ? 'Appended to' : 'Created'} <span className="mono">{result.relPath}</span>
              {result.mode === 'append' ? ' — existing content untouched.' : ' — new file only, nothing existing was modified.'}
            </div>
          </div>
          {result.mode === 'append' && (
            <div className="muted">
              Added: {result.added.scenarios.length} scenario(s), {result.added.workflows.length} workflow(s), {result.added.endpoints.length} endpoint interaction(s)
              {result.reused.length ? ` · reused from that file: ${result.reused.join(', ')}` : ''}
            </div>
          )}
          <div className="stack tight">
            <div className="section-caption">pytest --dry-run check · no requests are made</div>
            {!validation && <span className="muted"><LuLoader size={13} className="spin" /> Validating…</span>}
            {(validation || []).map((v) => (
              <div key={v.name} className={`notice ${v.ok ? 'ok' : 'danger'}`}>
                {v.ok ? <LuCheck size={15} /> : <LuX size={15} />}
                <div>
                  <b>{v.name}</b>: {v.ok ? `discovered (${v.scenarioCount} scenario${v.scenarioCount === 1 ? '' : 's'})` : v.error || 'not discovered'}
                  {v.scenarios?.[0]?.sequence && <div className="mono small dim">{v.scenarios[0].sequence}</div>}
                  {!v.ok && v.output && <pre className="code-block">{v.output}</pre>}
                </div>
              </div>
            ))}
          </div>
          <div className="muted">Run it from the Tests tab: pick the scenario's label, then Run tests.</div>
        </div>
      ) : (
        <div className="stack">
          <Segmented value={mode} onChange={setMode} options={[{ value: 'new', label: 'New file' }, { value: 'append', label: 'Add to existing file' }]} />

          {mode === 'new' ? (
            <Field label="Ticket name" hint={ticket.trim() ? <>Will create <span className="mono">config/tickets/{ticket.trim()}_scenarios_config.yaml</span></> : 'Used for the file name, e.g. SEK-200300'}>
              <input className="input" autoFocus value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="SEK-200300" spellCheck={false} />
            </Field>
          ) : (
            <Field label="Append the scenario(s) to" hint="Existing content is left untouched.">
              <div className="search-box">
                <LuSearch size={14} className="search-box-icon" />
                <input autoFocus value={fileQ} onChange={(e) => setFileQ(e.target.value)} placeholder="Filter files, e.g. SEK-2003" spellCheck={false} />
              </div>
              <div className="pick-list tall">
                {!files && <div className="list-hint">Loading…</div>}
                {visibleFiles.map((f) => (
                  <button type="button" key={f.relPath} className={`pick-row split ${target === f.relPath ? 'active' : ''}`} onClick={() => setTarget(f.relPath)}>
                    <span className="mono ellipsis">{f.relPath.replace(/^config\//, '')}</span>
                    <span className="muted nowrap">{f.scenarios} scenarios · {f.workflows} wf · {f.endpoints} ep</span>
                  </button>
                ))}
                {files && !visibleFiles.length && <div className="list-hint">No file matches.</div>}
              </div>
            </Field>
          )}

          {preview && !preview.ok && preview.errors.map((er) => <div key={er} className="notice danger"><LuCircleAlert size={15} /><div>{er}</div></div>)}
          {result && !result.ok && result.errors.map((er) => <div key={er} className="notice danger"><LuCircleAlert size={15} /><div>{er}</div></div>)}
          {preview?.ok && preview.mode === 'append' && (
            <div className="notice ok">
              <LuCheck size={15} />
              <div>
                Will add {preview.added.scenarios.length} scenario(s), {preview.added.workflows.length} workflow(s), {preview.added.endpoints.length} endpoint interaction(s)
                {preview.reused.length ? ` · reusing the file's own: ${preview.reused.join(', ')}` : ''}
              </div>
            </div>
          )}
          {preview?.ok && <pre className="code-block yaml">{preview.yaml}</pre>}
        </div>
      )}
    </Modal>
  );
}

// A stable fingerprint of what is editable in a scenario list (positions are not part of it).
const sig = (list) =>
  JSON.stringify(
    list.map((s) => [s.name, s.description, s.labelsText, s.namespaces, s.clearOutput ?? null, s.nodes.map((n) => [n.kind, n.def, n.origName]), s.edges.map((e) => [e.from, e.to])])
  );

function SaveChangesModal({ relPath, payload, onClose, onSaved }) {
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let cancelled = false;
    api.explorer.preview(payload).then((r) => !cancelled && setPreview(r)).catch((e) => !cancelled && setErr(e.message));
    return () => { cancelled = true; };
  }, [payload]);
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.explorer.save(payload);
      if (!r.ok) setErr((r.errors || [r.error]).join(' '));
      else onSaved(r);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={`Save changes to ${relPath.split('/').pop()}`}
      icon={<LuSave size={16} />}
      width={860}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!preview?.ok || !preview.changed || saving} onClick={save}>
            {saving && <LuLoader size={14} className="spin" />} Write to file
          </button>
        </>
      }
    >
      <div className="stack">
        {!preview && !err && <span className="muted"><LuLoader size={13} className="spin" /> Building the diff…</span>}
        {err && <div className="notice danger"><LuCircleAlert size={15} /><div>{err}</div></div>}
        {preview && !preview.ok && preview.errors.map((e) => <div key={e} className="notice danger"><LuCircleAlert size={15} /><div>{e}</div></div>)}
        {preview?.ok && !preview.changed && <div className="notice"><LuCheck size={15} /><div>No differences — the file already matches.</div></div>}
        {preview?.ok && preview.changed && (
          <>
            <div className="muted">
              {preview.counts.edited} definition/scenario edited · {preview.counts.added} added. Only these parts of the file are rewritten; everything else stays byte-for-byte as it is.
            </div>
            <div className="diff-modal"><DiffView diff={preview.diff} /></div>
          </>
        )}
      </div>
    </Modal>
  );
}

function ConfirmModal({ title, children, confirm, danger, onConfirm, onClose }) {
  return (
    <Modal
      title={title}
      icon={<LuCircleAlert size={16} />}
      width={460}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>{confirm}</button>
        </>
      }
    >
      <div className="muted-block">{children}</div>
    </Modal>
  );
}

function TestModal({ scenario, namespaces, defaultNamespace, busy, error, onRun, onClose }) {
  const [ns, setNs] = useState(defaultNamespace);
  // Remembered across modal opens, same as PodPicker's own namespace choice (see PodPicker.jsx) -
  // a dev who switched pod tailing on and ticked pods once shouldn't have to redo that next time.
  const [tailOn, setTailOn] = useLocalState('podpicker.on', false);
  const [podKeys, setPodKeys] = useState(() => {
    try {
      const raw = localStorage.getItem('nevis.podpicker.pods');
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (_) {
      return new Set();
    }
  });
  useEffect(() => {
    try { localStorage.setItem('nevis.podpicker.pods', JSON.stringify([...podKeys])); } catch (_) { /* storage unavailable */ }
  }, [podKeys]);
  const [exclusion, setExclusion] = useState('eid');
  return (
    <Modal
      title="Test scenario"
      icon={<LuPlay size={15} />}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !ns} onClick={() => onRun(ns, tailOn ? podsFromKeys(podKeys) : [], parseList(exclusion))}>
            {busy ? <LuLoader size={14} className="spin" /> : <LuPlay size={14} />}
            {busy ? 'Starting…' : 'Run test'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="seq-preview">
          {scenario.sequence.map((s, i) => (
            <React.Fragment key={i}>
              {i > 0 && <LuChevronRight size={13} className="muted" />}
              <span className="seq-chip">{s.def.name}</span>
            </React.Fragment>
          ))}
        </div>
        <Field label="Run against namespace" hint="Only namespaces defined in the repo's config are listed.">
          <Select value={ns} onChange={setNs} options={namespaces} placeholder="Select namespace" searchable={namespaces.length > 6} />
        </Field>
        <Field label="Exclusion labels">
          <input className="input" value={exclusion} onChange={(e) => setExclusion(e.target.value)} placeholder="eid" spellCheck={false} />
        </Field>
        <PodPicker testNamespace={ns} on={tailOn} onToggle={setTailOn} value={podKeys} onChange={setPodKeys} />
        <AusweisAppControl />
        <div className="notice warn">
          <LuCircleAlert size={15} />
          <div>
            Runs the flow through real pytest — <b>real requests</b> against <b>{ns || 'the chosen namespace'}</b>, like the Tests tab. Nothing is saved to the repo: a temporary config file is used and removed when the run ends.
          </div>
        </div>
        {error && <div className="notice danger"><LuCircleAlert size={15} /><div>{error}</div></div>}
      </div>
    </Modal>
  );
}

// pytest output plus any pod logs tailed for the run, switchable like in Run tests.
function DockLogs({ sources }) {
  const names = Object.keys(sources);
  const [tab, setTab] = useState('pytest');
  const current = tab === 'all' || names.includes(tab) ? tab : 'pytest';
  const all = useMemo(() => names.flatMap((n) => sources[n]).sort((a, b) => a.ts - b.ts).map((e) => ({ ...e, line: `[${e.source}] ${e.line}` })), [sources]); // eslint-disable-line react-hooks/exhaustive-deps
  const short = (n) => n.replace(/^pod:[^/]*\//, '');
  return (
    <div className="dock-logs">
      {names.length > 1 && (
        <div className="subtabs">
          <button className={current === 'all' ? 'subtab active' : 'subtab'} onClick={() => setTab('all')}>all <em>{all.length}</em></button>
          {names.map((n) => (
            <button key={n} className={current === n ? 'subtab active' : 'subtab'} onClick={() => setTab(n)} title={n}>{n === 'pytest' ? 'pytest' : short(n)} <em>{sources[n].length}</em></button>
          ))}
        </div>
      )}
      {current === 'all' ? <LogPanel title="all" entries={all} /> : <LogPanel key={current} title={current} entries={sources[current] || []} />}
    </div>
  );
}

function TestRunPanel({ onPopout, run, flow, sources, tab, setTab, traces, traceFocus, height, maximized, onSize, onReset, onStop, onToggleMax, onCollapse, onClose, collapsed }) {
  const running = run.status === 'running' || run.status === 'starting';
  return (
    <div className={`dock ${collapsed ? 'collapsed' : ''}`} style={collapsed ? undefined : { height }}>
      {!collapsed && <Sash orientation="horizontal" edge="start" size={height} onSize={onSize} onReset={onReset} />}
      <div className="dock-head" onDoubleClick={onCollapse}>
        <span className="panel-title">Test run</span>
        <span className={`run-pill s-${run.status}`}>
          <StatusDot status={run.status} />
          <span>
            {run.status}
            {run.exitCode !== null && run.exitCode !== undefined ? ` (exit ${run.exitCode})` : ''}
          </span>
        </span>
        {!collapsed && (
          <Segmented
            size="sm"
            block={false}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'flow', label: 'Scenario flow' },
              { value: 'logs', label: Object.keys(sources).length > 1 ? 'Logs' : 'pytest logs', count: Object.keys(sources).length > 1 ? Object.keys(sources).length : undefined },
              { value: 'traces', label: 'Traces', count: traces.traces.length || undefined },
              { value: 'output', label: 'Output' },
            ]}
          />
        )}
        <span className="spacer" />
        {running && (
          <button type="button" className="btn sm danger" onClick={onStop}>
            <LuX size={13} /> Stop
          </button>
        )}
        {onPopout && <IconButton size="sm" icon={<LuSquareArrowOutUpRight size={14} />} title={`Open the run output in a separate window (${shortcutLabel('L')})`} onClick={onPopout} />}
        <IconButton size="sm" icon={maximized ? <LuMinimize2 size={14} /> : <LuMaximize2 size={14} />} title={maximized ? 'Restore panel size' : 'Maximize panel'} onClick={onToggleMax} />
        <IconButton size="sm" icon={collapsed ? <LuChevronRight size={15} style={{ transform: 'rotate(-90deg)' }} /> : <LuChevronDown size={15} />} title={collapsed ? 'Expand panel' : 'Collapse panel'} onClick={onCollapse} />
        <IconButton size="sm" icon={<LuX size={15} />} title="Close panel" onClick={onClose} />
      </div>
      {!collapsed && (
        <div className="dock-body">
          {tab === 'flow' ? (
            <ScenarioFlow tests={flow} pytestEntries={sources.pytest || []} />
          ) : tab === 'traces' ? (
            <TracesPanel runTraces={traces} focus={traceFocus} />
          ) : tab === 'output' ? (
            <OutputFiles runId={run.id} since={run.createdAt} />
          ) : (
            <DockLogs sources={sources} />
          )}
        </div>
      )}
    </div>
  );
}

// what a scenario still needs before it can be written to a file
const missingDetails = (s) => {
  const out = [];
  if (!s.name.trim()) out.push('name');
  if ((s.origIndex === undefined || s.origIndex === null) && !s.namespaces.length) out.push('namespaces');
  return out;
};

const toScenarioPayload = (s) => {
  const sq = computeSequence(s);
  const byId = Object.fromEntries(s.nodes.map((n) => [n.id, n]));
  return {
    name: s.name.trim(),
    description: s.description.trim(),
    labels: parseList(s.labelsText),
    supportedNamespaces: s.namespaces,
    clearOutput: typeof s.clearOutput === 'boolean' ? s.clearOutput : undefined,
    sequence: sq.order.map((id) => ({ kind: byId[id].kind, def: byId[id].def })),
  };
};

// Testing only needs a valid chain; saving additionally needs a name + namespaces.
const chainProblems = (s) => computeSequence(s).problems;
const scenarioProblems = (s) => {
  const missing = [];
  if (!s.name.trim()) missing.push('scenario name');
  if (!s.namespaces.length) missing.push('supported namespaces');
  return [...chainProblems(s), ...(missing.length ? [`Fill in: ${missing.join(', ')}.`] : [])];
};

// Callback-ref based so it attaches whenever the element actually mounts (the board
// only exists once the schema has loaded) and re-measures when the pane is un-hidden.
function useElementSize() {
  const [el, setEl] = useState(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size];
}

export default function CreateTestView({ active, mode = 'create' }) {
  const explore = mode === 'explore';
  const toast = useToast();
  const [schema, setSchema] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [labelCatalog, setLabelCatalog] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [scenarios, setScenarios] = useState([newScenario(1)]);
  const [file, setFile] = useState(null); // explore mode: { relPath, snapshot, unresolved }
  const [treeFiles, setTreeFiles] = useState([]);
  const [treeDirs, setTreeDirs] = useState([]);
  const [treeUnscanned, setTreeUnscanned] = useState([]);
  const [deleteAsk, setDeleteAsk] = useState(null); // { path, kind }
  const [filesOpen, setFilesOpen] = useLocalState('bld.filesOpen', true);
  const [filesW, setFilesW, resetFilesW] = usePanelSize('bld.files', 270, 200, () => Math.min(520, window.innerWidth * 0.35));
  // Unsaved edits per file (relPath -> { scenarios, activeIdx }): kept when another file is opened and across page reloads.
  const drafts = useRef(null);
  if (drafts.current === null) {
    drafts.current = new Map();
    try {
      for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem('nevis.explorer.drafts') || '{}'))) drafts.current.set(k, v);
    } catch (_) { /* no stored drafts */ }
  }
  const [draftPaths, setDraftPaths] = useState(() => new Set(drafts.current.keys()));
  const syncDrafts = () => {
    setDraftPaths((prev) => (prev.size === drafts.current.size && [...drafts.current.keys()].every((k) => prev.has(k)) ? prev : new Set(drafts.current.keys())));
    try { localStorage.setItem('nevis.explorer.drafts', JSON.stringify(Object.fromEntries(drafts.current))); } catch (_) { /* storage full or blocked */ }
  };
  const [treeQ, setTreeQ] = useState('');
  const [treeLoading, setTreeLoading] = useState(false);
  const [dirtyMap, setDirtyMap] = useState(new Map());
  const [confirmOpen, setConfirmOpen] = useState(null); // { relPath, pick } | { discard: true }
  const [saveChangesOpen, setSaveChangesOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [multiSelected, setMultiSelected] = useState(new Set()); // block ids picked with a drag-select rectangle, for copy/delete as a group
  const [marquee, setMarquee] = useState(null); // { x, y, w, h } in canvas coords, while a drag-select rectangle is being drawn
  const didMarqueeRef = useRef(false); // suppresses the plain "click empty canvas -> open add-block picker" behavior right after a drag-select
  const clipboardRef = useRef(null); // { nodes: [{kind, def, dx, dy}], edges: [[i, j]] } - a relative copy, pasted into whichever scenario is active
  const [view, setView] = useState('board'); // 'board' | 'yaml'
  const [yamlFocus, setYamlFocus] = useState(null);
  const [yamlError, setYamlError] = useState('');
  const [connecting, setConnecting] = useState(null); // { from, x, y }
  const [saveOpen, setSaveOpen] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [testModal, setTestModal] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState('');
  const [testRun, setTestRun] = useState(null);
  const [testRunOf, setTestRunOf] = useState(null); // tab id of the scenario that started the run
  const testRunning = !!testRun && ['starting', 'running'].includes(testRun.status);
  // Editor tabs (like VS Code): the scenarios opened so far, across files. Each keeps its own draft; one test runs at a time.
  const [tabs, setTabs] = useState(() => {
    try { return JSON.parse(localStorage.getItem('nevis.explorer.tabs') || '[]'); } catch (_) { return []; }
  });
  const [testFlow, setTestFlow] = useState([]);
  const [testSources, setTestSources] = useState({});
  const [testOpen, setTestOpen] = useState(false);
  const [dockTab, setDockTab] = useState('flow');
  const [dockTraceFocus, setDockTraceFocus] = useState(null);
  const [dockSheet, setDockSheet] = useState(null);
  const testTraces = useRunTraces(testRun?.id, testRun?.status);
  useEffect(() => {
    if (testRun?.id) setActiveRun(testRun.id);
  }, [testRun?.id]);
  const traceLinks = useMemo(() => {
    const known = new Set();
    const byStep = {};
    for (const t of testTraces.traces) {
      known.add(t.traceId);
      if (t.stepId && !byStep[t.stepId]) byStep[t.stepId] = t.traceId;
    }
    return { known, byStep, open: (traceId, spanId) => setDockSheet({ traceId, spanId, nonce: Date.now() }) };
  }, [testTraces.traces]);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [dockMax, setDockMax] = useState(false);
  const [lastTestNs, setLastTestNs] = useLocalState('bld.testNs', '');
  const [picker, setPicker] = useState(null); // the add-block menu: { anchor: 'pill' } | { x, y, at } where it was opened on the canvas
  const colRef = useRef(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsPrompt, setDetailsPrompt] = useState(false); // opened because saving needs details: show what is missing
  const [detailsHint, setDetailsHint] = useState(false); // short-lived pointer at the Details button after a file opens
  useEffect(() => {
    if (!detailsOpen) return undefined;
    const k = (e) => e.key === 'Escape' && (setDetailsOpen(false), setDetailsPrompt(false));
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [detailsOpen]);
  const [dockH, setDockH, resetDockH] = usePanelSize('bld.dock', 320, 140, () => Math.max(160, window.innerHeight - 260));
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const [scrollRef, viewport] = useElementSize();

  // Re-read the repo (config yaml + the pytest code) so properties/blocks added
  // since the tab was opened show up without a manual step.
  const loadAll = useCallback(async (initial) => {
    setReloading(true);
    try {
      const [s, c, l] = await Promise.all([api.builder.schema(), api.builder.catalog(), api.scenarios.labels().catch(() => ({ labels: [] }))]);
      setSchema(s);
      setCatalog(c);
      // every scenario gets its own uuid-shaped label automatically - not useful as a suggestion here
      setLabelCatalog((l.labels || []).filter((x) => !/^[0-9a-z]+-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+-[0-9a-z]{6,}$/i.test(x)));
    } catch (e) {
      if (initial) setLoadError(e.message);
    } finally {
      setReloading(false);
    }
  }, []);

  useEffect(() => {
    if (active) loadAll(!schema);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /* ---------- explorer mode: existing files ---------- */
  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    try {
      const [t, g] = await Promise.all([api.explorer.tree(), api.git.status().catch(() => null)]);
      setTreeFiles(t.files);
      setTreeDirs(t.dirs || []);
      setTreeUnscanned(t.unscanned || []);
      setDirtyMap(new Map((g?.files || []).map((f) => [f.path, f.status])));
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setTreeLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (explore && active) loadTree();
  }, [explore, active, loadTree]);

  const buildFromFile = (parsed, width) => {
    const colW = NODE_W + 60;
    const perRow = Math.max(2, Math.floor((Math.max(width, 720) - 60) / colW));
    return parsed.scenarios.map((sc0) => {
      const nodes = sc0.sequence.map((st, i) => ({
        id: uid(), kind: st.kind, def: clone(st.def), origin: null, origName: st.def.name, unresolved: !!st.unresolved,
        x: 60 + (i % perRow) * colW, y: 60 + Math.floor(i / perRow) * (NODE_H + 60),
      }));
      const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));
      return { id: uid(), name: sc0.name || '', description: sc0.description || '', labelsText: sc0.labels.join(' '), namespaces: sc0.supportedNamespaces, clearOutput: typeof sc0.clearOutput === 'boolean' ? sc0.clearOutput : null, nodes, edges, origIndex: sc0.index, origName: sc0.name };
    });
  };

  const openFile = useCallback(
    async (relPath, pick, { fresh = false } = {}) => {
      try {
        const parsed = await api.explorer.file(relPath);
        const built = buildFromFile(parsed, viewport.w);
        const base = built.length ? built : [newScenario(1)]; // an empty file starts with one blank scenario
        if (fresh) drafts.current.delete(relPath);
        const draft = drafts.current.get(relPath);
        const start = draft ? draft.scenarios : base;
        setScenarios(start);
        const at = pick !== undefined && pick !== null ? start.findIndex((b) => b.origIndex === pick) : -1;
        setActiveIdx(at >= 0 ? at : draft ? Math.min(draft.activeIdx || 0, start.length - 1) : 0);
        setSelectedId(null);
        setFile({ relPath: parsed.relPath, snapshot: sig(base), unresolved: parsed.unresolved });
      } catch (e) {
        toast(e.message, 'error');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewport.w, toast]
  );

  const dirty = explore && !!file && sig(scenarios) !== file.snapshot;
  const activeScenario = scenarios[activeIdx];
  const tabId = (relPath, key) => `${relPath}#${key ?? 'new'}`;
  const activeTabId = explore && file && activeScenario ? tabId(file.relPath, activeScenario.origIndex) : null;
  useEffect(() => {
    if (!activeTabId) return;
    const label = (activeScenario.name || '').trim() || `Scenario ${activeIdx + 1}`;
    setTabs((t) => {
      const at = t.findIndex((x) => x.id === activeTabId);
      const entry = { id: activeTabId, relPath: file.relPath, key: activeScenario.origIndex ?? null, label };
      if (at < 0) return [...t, entry];
      return t[at].label === label && t[at].relPath === file.relPath ? t : t.map((x, i) => (i === at ? entry : x));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, activeScenario?.name]);
  useEffect(() => {
    try { localStorage.setItem('nevis.explorer.tabs', JSON.stringify(tabs)); localStorage.setItem('nevis.explorer.activeTab', activeTabId || ''); } catch (_) { /* storage blocked */ }
  }, [tabs, activeTabId]);
  // after a page reload, reopen the tab that was active
  const restoredTabs = useRef(false);
  useEffect(() => {
    if (!explore || !active || restoredTabs.current || file) return;
    restoredTabs.current = true;
    let id = '';
    try { id = localStorage.getItem('nevis.explorer.activeTab') || ''; } catch (_) { /* storage blocked */ }
    const t = tabs.find((x) => x.id === id);
    if (t) api.explorer.file(t.relPath).then(() => openFile(t.relPath, t.key === null ? undefined : t.key)).catch(() => setTabs((all) => all.filter((x) => x.relPath !== t.relPath)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explore, active]);
  const openTab = (t) => {
    if (file && t.relPath === file.relPath) {
      const at = scenarios.findIndex((x) => (x.origIndex ?? null) === t.key);
      if (at >= 0) { setActiveIdx(at); setSelectedId(null); return; }
    }
    openFile(t.relPath, t.key === null ? undefined : t.key);
  };
  const closeTab = (id) => {
    const at = tabs.findIndex((x) => x.id === id);
    const rest = tabs.filter((x) => x.id !== id);
    setTabs(rest);
    if (id !== activeTabId) return;
    const next = rest[at] || rest[at - 1];
    if (next) openTab(next);
    else { setFile(null); setScenarios([newScenario(1)]); setActiveIdx(0); setSelectedId(null); }
  };
  const retarget = (from, to) => setTabs((t) => t.flatMap((x) => (x.relPath !== from ? [x] : to ? [{ ...x, relPath: to, id: tabId(to, x.key) }] : [])));
  // The open file's unsaved edits are mirrored into the draft store, so opening another file loses nothing.
  useEffect(() => {
    if (!explore || !file) return;
    if (dirty) drafts.current.set(file.relPath, { scenarios, activeIdx });
    else drafts.current.delete(file.relPath);
    syncDrafts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explore, file, dirty, scenarios, activeIdx]);

  const requestOpen = (relPath, pick) => openFile(relPath, pick);
  // a pointer at the Details button for a few seconds after a file opens (when it has something to fill in, or the first couple of times)
  useEffect(() => {
    if (!explore || !file) return undefined;
    let seenTimes = 0;
    try { seenTimes = Number(localStorage.getItem('nevis.hint.details') || 0); } catch (_) { /* storage blocked */ }
    const incomplete = scenarios.some((x) => missingDetails(x).length);
    if (!incomplete && seenTimes >= 2) return undefined;
    try { localStorage.setItem('nevis.hint.details', String(seenTimes + 1)); } catch (_) { /* storage blocked */ }
    setDetailsHint(true);
    const t = setTimeout(() => setDetailsHint(false), 5200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explore, file?.relPath]);
  // global search results: open a file / scenario, filter the tree by a label, or search the block library
  useEffect(() => {
    if (!explore) return undefined;
    const onNav = (e) => {
      const n = e.detail || {};
      if (n.section !== 'explorer') return;
      if (n.file) { setFilesOpen(true); openFile(n.file, n.scenario); }
      if (n.treeQuery !== undefined) { setFilesOpen(true); setTreeQ(n.treeQuery); }
      if (n.library) {
        setPicker({});
        window.__pendingLibrary = n.library;
        setTimeout(() => window.dispatchEvent(new Event('nevis-library')), 60);
      }
    };
    window.addEventListener('nevis-nav', onNav);
    return () => window.removeEventListener('nevis-nav', onNav);
  }, [explore, openFile, setFilesOpen]);
  const rekeyDraft = (from, to) => {
    const d = drafts.current.get(from);
    if (d) { drafts.current.delete(from); drafts.current.set(to, d); }
    syncDrafts();
  };
  const fail = (e) => toast(e.message, 'error');
  const createFile = async (dir, name) => {
    try {
      const r = await api.explorer.create(dir, name);
      await loadTree();
      toast(`Created ${r.relPath}. Name the scenario and add blocks, then save.`);
      openFile(r.relPath);
      setDetailsOpen(true);
    } catch (e) { fail(e); }
  };
  const createFolder = async (parent, name) => {
    try {
      const r = await api.explorer.folder(parent, name);
      await loadTree();
      toast(r.scanned ? `Created ${r.path}` : `Created ${r.path}. pytest only runs files in its own folders (features, tickets, ...): move files there to run them.`);
    } catch (e) { fail(e); }
  };
  const moveFile = async (from, toDir) => {
    try {
      const r = await api.explorer.move(from, toDir);
      if (r.moved) {
        rekeyDraft(from, r.relPath);
        retarget(from, r.relPath);
        toast(`Moved to ${r.relPath}`);
        await loadTree();
        if (file?.relPath === from) openFile(r.relPath);
      }
    } catch (e) { fail(e); }
  };
  const renameFile = async (from, name) => {
    try {
      const r = await api.explorer.rename(from, name);
      if (r.renamed) {
        rekeyDraft(from, r.relPath);
        retarget(from, r.relPath);
        await loadTree();
        if (file?.relPath === from) openFile(r.relPath);
      }
    } catch (e) { fail(e); }
  };
  const copyFile = async (from) => {
    try {
      const r = await api.explorer.copy(from);
      await loadTree();
      toast(`Copied to ${r.relPath}${r.newLabels ? ' (new uuid labels)' : ''}`);
      openFile(r.relPath);
    } catch (e) { fail(e); }
  };
  const deleteEntry = async ({ path, kind }) => {
    try {
      await api.explorer.remove(path, kind);
      drafts.current.delete(path);
      syncDrafts();
      retarget(path, null);
      if (file?.relPath === path) {
        setFile(null);
        setScenarios([newScenario(1)]);
        setActiveIdx(0);
        setSelectedId(null);
      }
      toast(`Deleted ${path}`);
      loadTree();
    } catch (e) { fail(e); }
  };

  useEffect(() => {
    if (!active) return undefined;
    const onFocus = () => loadAll(false);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [active, loadAll]);

  const connectTestWs = (runId) => {
    wsRef.current?.close();
    const ws = new WebSocket(wsUrl());
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', runId }));
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'backlog') {
        setTestSources(msg.sources || {});
        setTestFlow(msg.flow || []);
        setTestRun((r) => (r ? { ...r, status: msg.status, exitCode: msg.exitCode } : r));
      } else if (msg.type === 'log') {
        setTestSources((prev) => ({ ...prev, [msg.entry.source]: [...(prev[msg.entry.source] || []), msg.entry] }));
      } else if (msg.type === 'flow') {
        setTestFlow(msg.tests || []);
      } else if (msg.type === 'status') {
        setTestRun((r) => (r ? { ...r, status: msg.status, exitCode: msg.exitCode } : r));
      }
    };
  };

  const startTest = async (namespace, pods = [], exclusionLabels = ['eid']) => {
    setTestBusy(true);
    setTestError('');
    try {
      let scenario = toScenarioPayload(scenarios[activeIdx]);
      // an existing scenario's uuid label must not be reused by the throw-away draft (it would run both)
      if (explore) scenario = { ...scenario, name: '', labels: scenario.labels.filter((l) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(l)) };
      const { run } = await api.builder.test({ scenario, namespace, pods, exclusionLabels });
      setLastTestNs(namespace);
      setTestRun({ id: run.id, status: run.status, exitCode: run.exitCode, createdAt: run.createdAt });
      setTestRunOf(activeTabId);
      setTestFlow([]);
      setTestSources({});
      connectTestWs(run.id);
      setTestModal(false);
      setTestOpen(true);
      setDockCollapsed(false);
    } catch (e) {
      setTestError(e.message);
    } finally {
      setTestBusy(false);
    }
  };

  const sc = scenarios[activeIdx];
  const updateActive = useCallback(
    (fn) => setScenarios((all) => all.map((s, i) => (i === activeIdx ? fn(s) : s))),
    [activeIdx]
  );
  const selected = sc.nodes.find((n) => n.id === selectedId) || null;
  const seq = useMemo(() => computeSequence(sc), [sc]);

  const canvasPoint = (clientX, clientY) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  const uniqueName = (base, nodes, def) => {
    const clash = (n) => nodes.some((x) => x.def.name === n && JSON.stringify({ ...x.def, name: '' }) !== JSON.stringify({ ...def, name: '' }));
    if (!clash(base)) return base;
    let i = 2;
    while (nodes.some((x) => x.def.name === `${base}-${i}`)) i += 1;
    return `${base}-${i}`;
  };

  // Next free slot: left-to-right, wrapping to a new row once the visible board is full.
  const nextSlot = (nodes) => {
    const colW = NODE_W + 60;
    const perRow = Math.max(1, Math.floor((Math.max(viewport.w, 720) - 60) / colW));
    const i = nodes.length;
    return { x: 60 + (i % perRow) * colW, y: 60 + Math.floor(i / perRow) * (NODE_H + 60) };
  };

  const addBlock = useCallback(
    ({ kind, def, origin }, at, { select = true } = {}) => {
      updateActive((s) => {
        const d = clone(def);
        d.name = uniqueName(d.name, s.nodes, d);
        const pos = at || nextSlot(s.nodes);
        const node = { id: uid(), kind, def: d, origin, x: snap(pos.x), y: snap(pos.y) };
        if (select) setSelectedId(node.id);
        return { ...s, nodes: [...s.nodes, node] };
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updateActive, viewport.w]
  );

  // ---- add-block menu (canvas style): click the board or "+", pick a block, it joins the sequence
  const tailId = () => {
    const q = computeSequence(sc);
    return q.problems.length === 0 && q.order.length ? q.order[q.order.length - 1] : null;
  };
  useEffect(() => {
    if (selectedId) setPicker(null); // Properties takes the right side: the add menu has no use then
  }, [selectedId]);
  const openPicker = (p) => {
    setSelectedId(null);
    setDetailsOpen(false);
    setPicker(p);
  };
  const pickBlock = ({ kind, def, origin }) => {
    const at = picker && picker.at;
    updateActive((s) => {
      const d = clone(def);
      d.name = uniqueName(d.name, s.nodes, d);
      const q = computeSequence(s);
      const tail = q.problems.length === 0 && q.order.length ? q.order[q.order.length - 1] : null;
      const pos = at || nextSlot(s.nodes);
      const node = { id: uid(), kind, def: d, origin, x: snap(pos.x), y: snap(pos.y) };
      return { ...s, nodes: [...s.nodes, node], edges: tail ? [...s.edges, { from: tail, to: node.id }] : s.edges };
    });
    setPicker(null);
  };
  const renderDetails = () => (
    <div className="scen-pop-body">
      {detailsPrompt && (
        <div className="notice info small">
          <LuInfo size={14} />
          <div>{missingDetails(sc).length ? <>To save, this scenario still needs {missingDetails(sc).map((m) => (m === 'name' ? 'a name' : 'at least one supported namespace')).join(' and ')}. Fill it in, then press <b>Save changes…</b> again.</> : 'All set. Press Save changes… to review and write the file.'}</div>
        </div>
      )}
      <Field label="Scenario name" hint="Needed to save, not to test">
        <input className={`input ${detailsPrompt && !sc.name.trim() ? 'invalid' : ''}`} autoFocus={!sc.name.trim()} value={sc.name} onChange={(e) => updateActive((x) => ({ ...x, name: e.target.value }))} placeholder="register-then-login" spellCheck={false} />
      </Field>
      <Field label="Description">
        <input className="input" value={sc.description} onChange={(e) => updateActive((x) => ({ ...x, description: e.target.value }))} placeholder="What this scenario proves" />
      </Field>
      <Field label="Labels" hint="A uuid label is added automatically">
        <ChipsInput value={parseList(sc.labelsText)} onChange={(v) => updateActive((x) => ({ ...x, labelsText: v.join(' ') }))} suggestions={labelCatalog} placeholder="SEK-200300 regression-test" />
      </Field>
      <Field label="Supported namespaces" hint="Needed to save, not to test">
        <ChipsInput invalid={detailsPrompt && missingDetails(sc).includes('namespaces')} value={sc.namespaces} onChange={(v) => updateActive((x) => ({ ...x, namespaces: v }))} suggestions={schema.namespaces} placeholder="Add namespace…" />
      </Field>
      <Field label="Clear output folder" hint="clear_output: wipe output/ before this scenario runs. On leaves the key out (the suite clears by default); off writes clear_output: false.">
        <Switch
          checked={sc.clearOutput !== false}
          onChange={(on) => updateActive((x) => ({ ...x, clearOutput: on ? (x.clearOutput === true ? true : null) : false }))}
          label={sc.clearOutput === false ? 'Off: output/ is kept' : 'On: output/ is wiped first'}
        />
      </Field>
    </div>
  );

  const autoArrange = () =>
    updateActive((s) => {
      const order = computeSequence(s).order;
      const ids = order.length ? order : s.nodes.map((n) => n.id);
      const byId = Object.fromEntries(s.nodes.map((n) => [n.id, n]));
      const placed = ids.map((id, i) => ({ ...byId[id], ...nextSlot(new Array(i)) }));
      const rest = s.nodes.filter((n) => !ids.includes(n.id));
      return { ...s, nodes: [...placed, ...rest] };
    });

  const onDrop = (e) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/x-bld');
    if (!raw) return;
    const p = canvasPoint(e.clientX, e.clientY);
    addBlock(JSON.parse(raw), { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
  };

  const setNode = (node) => {
    if (explore && node.origName) {
      // a definition is shared by every scenario of the file that uses it: edit them together
      setScenarios((all) =>
        all.map((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === node.id ? node : n.origName === node.origName && n.kind === node.kind ? { ...n, def: node.def } : n)) }))
      );
      return;
    }
    updateActive((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === node.id ? node : n)) }));
  };

  // Turns edited YAML back into board state. Returns an error message, or null when applied.
  const applyYaml = (doc) => {
    const scs = Array.isArray(doc.scenarios) ? doc.scenarios : [];
    if (scs.length !== 1) return 'The YAML must contain exactly one entry under scenarios.';
    const s0 = scs[0] || {};
    const defsOf = (key) => {
      const list = Array.isArray(doc[key]) ? doc[key] : [];
      const bad = list.find((d) => !d || typeof d !== 'object' || Array.isArray(d) || !d.name);
      if (list.length && bad !== undefined) return { error: `Every entry under ${key} needs a name.` };
      return { map: new Map(list.map((d) => [String(d.name), d])) };
    };
    const wf = defsOf('workflows');
    const ep = defsOf('endpoint_interactions');
    if (wf.error || ep.error) return wf.error || ep.error;
    const names = Array.isArray(s0.sequence) ? s0.sequence.map(String) : [];
    const missing = names.find((n) => !wf.map.has(n) && !ep.map.has(n));
    if (missing) return `sequence entry "${missing}" is not defined under workflows or endpoint_interactions.`;
    const cur = scenarios[activeIdx];
    const oldOrder = computeSequence(cur).order.map((id) => cur.nodes.find((n) => n.id === id));
    const used = new Set();
    const nodes = names.map((name, i) => {
      const kind = wf.map.has(name) ? 'workflow' : 'endpoint';
      const def = clone(kind === 'workflow' ? wf.map.get(name) : ep.map.get(name));
      const prior = cur.nodes.find((n) => !used.has(n.id) && n.kind === kind && n.def.name === name) || (oldOrder[i] && !used.has(oldOrder[i].id) && oldOrder[i].kind === kind ? oldOrder[i] : null);
      if (prior) {
        used.add(prior.id);
        return { ...prior, def };
      }
      return { id: uid(), kind, def, origin: null, ...nextSlot(new Array(i)) };
    });
    const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));
    const rebuilt = {
      ...cur,
      name: s0.name == null ? '' : String(s0.name),
      description: s0.description == null ? '' : String(s0.description),
      labelsText: (Array.isArray(s0.labels) ? s0.labels : []).map(String).join(' '),
      namespaces: (Array.isArray(s0.supported_namespaces) ? s0.supported_namespaces : []).map(String),
      clearOutput: typeof s0.clear_output === 'boolean' ? s0.clear_output : null,
      nodes,
      edges,
    };
    const changed = nodes.filter((n) => n.origName && JSON.stringify(cur.nodes.find((o) => o.id === n.id)?.def) !== JSON.stringify(n.def));
    setScenarios((all) =>
      all.map((x, i) => {
        if (i === activeIdx) return rebuilt;
        if (!explore || !changed.length) return x;
        return { ...x, nodes: x.nodes.map((n) => { const c = changed.find((k) => k.origName === n.origName && k.kind === n.kind); return c ? { ...n, def: c.def } : n; }) };
      })
    );
    return null;
  };

  const explorePayload = () => {
    const problems = [];
    const out = scenarios.map((s, i) => {
      const q = computeSequence(s);
      const untouchedEmpty = s.nodes.length === 0 && s.origIndex !== undefined;
      if (q.problems.length && !untouchedEmpty) problems.push(`${s.name || `Scenario ${i + 1}`}: ${q.problems[0]}`);
      const byId = Object.fromEntries(s.nodes.map((n) => [n.id, n]));
      return {
        origIndex: s.origIndex ?? null,
        origName: s.origName || null,
        name: s.name.trim(),
        description: s.description.trim(),
        labels: parseList(s.labelsText),
        supportedNamespaces: s.namespaces,
        clearOutput: typeof s.clearOutput === 'boolean' ? s.clearOutput : undefined,
        sequence: q.order.map((id) => ({ kind: byId[id].kind, def: byId[id].def, origName: byId[id].origName || null, unresolved: byId[id].unresolved })),
      };
    });
    return { relPath: file.relPath, scenarios: out, problems };
  };
  const deleteNode = (id) => {
    updateActive((s) => ({ ...s, nodes: s.nodes.filter((n) => n.id !== id), edges: s.edges.filter((e) => e.from !== id && e.to !== id) }));
    setSelectedId(null);
  };
  const deleteNodes = (ids) => {
    updateActive((s) => ({ ...s, nodes: s.nodes.filter((n) => !ids.has(n.id)), edges: s.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to)) }));
    setSelectedId(null);
    setMultiSelected(new Set());
  };

  // Cmd/Ctrl+C on whatever's selected (a drag-selected group, or the single Properties-panel
  // node) stores a relative copy - positions offset from the group's own top-left corner, and
  // only the edges that run between two copied blocks - so it can be dropped into any scenario,
  // including one on a different tab, at whatever position it lands.
  const copySelection = () => {
    const ids = multiSelected.size ? multiSelected : selectedId ? new Set([selectedId]) : null;
    if (!ids || !ids.size) return;
    const nodes = sc.nodes.filter((n) => ids.has(n.id));
    if (!nodes.length) return;
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const indexById = new Map(nodes.map((n, i) => [n.id, i]));
    const edges = sc.edges.filter((e) => indexById.has(e.from) && indexById.has(e.to)).map((e) => [indexById.get(e.from), indexById.get(e.to)]);
    clipboardRef.current = {
      nodes: nodes.map((n) => ({ kind: n.kind, def: clone(n.def), dx: n.x - minX, dy: n.y - minY })),
      edges,
    };
    toast(`Copied ${nodes.length} block${nodes.length === 1 ? '' : 's'} — switch scenario and press ⌘/Ctrl+V to paste`);
  };
  const pasteSelection = () => {
    const clip = clipboardRef.current;
    if (!clip || !clip.nodes.length) return;
    updateActive((s) => {
      const base = nextSlot(s.nodes);
      const created = clip.nodes.map((c) => {
        const d = clone(c.def);
        d.name = uniqueName(d.name, s.nodes, d);
        const node = { id: uid(), kind: c.kind, def: d, origin: null, x: snap(base.x + c.dx), y: snap(base.y + c.dy) };
        s = { ...s, nodes: [...s.nodes, node] }; // so uniqueName sees names already claimed by this same paste
        return node;
      });
      const edges = clip.edges.map(([i, j]) => ({ from: created[i].id, to: created[j].id }));
      setMultiSelected(new Set(created.map((n) => n.id)));
      setSelectedId(null);
      toast(`Pasted ${created.length} block${created.length === 1 ? '' : 's'}`);
      return { ...s, edges: [...s.edges, ...edges] };
    });
  };

  // A plain click on empty canvas opens the add-block picker (see the board's onClick below); a
  // click-and-drag instead rubber-bands a selection rectangle over whatever blocks it covers, so
  // several blocks can be copied or deleted together instead of one at a time.
  const startMarquee = (e) => {
    if (e.button !== 0) return;
    const startPt = canvasPoint(e.clientX, e.clientY);
    let active = false;
    const move = (ev) => {
      const pt = canvasPoint(ev.clientX, ev.clientY);
      const dx = pt.x - startPt.x;
      const dy = pt.y - startPt.y;
      if (!active && Math.hypot(dx, dy) < 4) return;
      active = true;
      setMarquee({ x: Math.min(startPt.x, pt.x), y: Math.min(startPt.y, pt.y), w: Math.abs(dx), h: Math.abs(dy) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!active) return;
      didMarqueeRef.current = true;
      setMarquee((rect) => {
        const hit = sc.nodes.filter((n) => n.x < rect.x + rect.w && n.x + NODE_W > rect.x && n.y < rect.y + rect.h && n.y + NODE_H > rect.y);
        setMultiSelected(new Set(hit.map((n) => n.id)));
        setSelectedId(null);
        return null;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startDrag = (e, node) => {
    if (e.button !== 0) return;
    setSelectedId(node.id);
    setMultiSelected(new Set());
    const start = { mx: e.clientX, my: e.clientY, x: node.x, y: node.y };
    const move = (ev) =>
      updateActive((s) => ({
        ...s,
        nodes: s.nodes.map((n) => (n.id === node.id ? { ...n, x: snap(start.x + ev.clientX - start.mx), y: snap(start.y + ev.clientY - start.my) } : n)),
      }));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const canConnect = (s, from, to) => {
    if (from === to) return false;
    if (s.edges.some((e) => e.from === from || e.to === to)) return false; // linear chain: one out, one in
    let cur = to; // reject cycles
    const out = new Map(s.edges.map((e) => [e.from, e.to]));
    while (cur) {
      if (cur === from) return false;
      cur = out.get(cur);
    }
    return true;
  };

  const startConnect = (e, node) => {
    e.stopPropagation();
    e.preventDefault();
    const move = (ev) => setConnecting({ from: node.id, ...canvasPoint(ev.clientX, ev.clientY) });
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setConnecting(null);
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-in-port]');
      if (target) {
        const to = target.getAttribute('data-in-port');
        updateActive((s) => (canConnect(s, node.id, to) ? { ...s, edges: [...s.edges, { from: node.id, to }] } : s));
      }
    };
    setConnecting({ from: node.id, ...canvasPoint(e.clientX, e.clientY) });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (multiSelected.size) deleteNodes(multiSelected);
        else if (selectedId) deleteNode(selectedId);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'c' || e.key === 'C') {
        copySelection();
      } else if (e.key === 'v' || e.key === 'V') {
        e.preventDefault(); // don't also let a stray paste land in whatever's focused
        pasteSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, multiSelected, activeIdx]);

  // Selecting is per-scenario, but the clipboard (a ref) deliberately survives switching tabs -
  // that's what makes "copy in scenario A, paste into scenario B" work.
  useEffect(() => {
    setMultiSelected(new Set());
  }, [activeIdx]);

  if (loadError) return <EmptyState icon={<LuCircleAlert size={26} />} title="Could not load building blocks">{loadError}</EmptyState>;
  if (!schema || !catalog) return <EmptyState icon={<LuLoader size={24} className="spin" />} title="Loading building blocks…" />;

  const nodeById = Object.fromEntries(sc.nodes.map((n) => [n.id, n]));
  const orderIndex = Object.fromEntries(seq.order.map((id, i) => [id, i + 1]));

  const payload = { scenarios: scenarios.map(toScenarioPayload) };
  const allProblems = scenarios.flatMap((s, i) => scenarioProblems(s).map((m) => (scenarios.length > 1 ? `Scenario ${i + 1}: ${m}` : m)));

  // The board is only as big as what is on it (plus breathing room) and at least as
  // big as the visible area, so it never scrolls until the flow itself outgrows it.
  const contentW = sc.nodes.reduce((m, n) => Math.max(m, n.x + NODE_W), 0) + CANVAS_PAD;
  const contentH = sc.nodes.reduce((m, n) => Math.max(m, n.y + NODE_H), 0) + CANVAS_PAD;
  // The board pans with the wheel / trackpad, but only as far as keeps the blocks in view: at the far end of the scroll, the last
  // block's edge is still 40% of the window in. (With no blocks there is nothing to pan to.)
  const canvasW = viewport.w + (sc.nodes.length ? Math.max(140, contentW - viewport.w * 0.4) : 0);
  const canvasH = viewport.h + (sc.nodes.length ? Math.max(140, contentH - viewport.h * 0.4) : 0);

  const testProblems = chainProblems(sc);
  const testNamespaces = schema.namespaces;
  const defaultTestNs = [sc.namespaces[0], lastTestNs, testNamespaces.includes('dev-main') ? 'dev-main' : testNamespaces[0]].find((n) => n && testNamespaces.includes(n)) || '';
  const dockHeight = dockMax ? Math.max(160, window.innerHeight - 260) : dockH;

  return (
    <div className={explore ? 'view' : 'view col'}>
        {explore && (filesOpen ? (
          <aside className="panel side" style={{ width: filesW }}>
            <FileTree
              files={treeFiles}
              dirs={treeDirs}
              unscanned={treeUnscanned}
              query={treeQ}
              onQuery={setTreeQ}
              openPath={file?.relPath}
              activeScenario={scenarios[activeIdx]?.origIndex}
              dirty={dirtyMap}
              drafts={draftPaths}
              onOpen={requestOpen}
              onRefresh={loadTree}
              loading={treeLoading}
              onCreateFile={createFile}
              onCreateFolder={createFolder}
              onMove={moveFile}
              onCopy={copyFile}
              onRename={renameFile}
              onDelete={(path, kind) => setDeleteAsk({ path, kind })}
              onCollapsePanel={() => setFilesOpen(false)}
            />
            <Sash edge="end" size={filesW} onSize={setFilesW} onReset={resetFilesW} />
          </aside>
        ) : (
          <div className="rail left">
            <IconButton size="md" icon={<LuPanelLeftOpen size={16} />} title="Show files" onClick={() => setFilesOpen(true)} />
            <span className="rail-label">Files</span>
          </div>
        ))}

      <div className="view col">
      {explore && tabs.length > 0 && (
        <div className="editor-tabs" role="tablist">
          {tabs.map((t) => {
            const on = t.id === activeTabId;
            const isRunning = testRunning && testRunOf === t.id;
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={on}
                className={`editor-tab ${on ? 'active' : ''}`}
                onClick={() => !on && openTab(t)}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}
                title={`${t.relPath}${t.key === null ? '' : ` · scenario ${t.key + 1}`}`}
              >
                {isRunning ? <LuLoader size={13} className="spin" /> : <LuWorkflow size={13} className="muted" />}
                <span className="editor-tab-name">{t.label}</span>
                <span className="editor-tab-file">{t.relPath.split('/').pop().replace(/\.yaml$/, '')}</span>
                {draftPaths.has(t.relPath) && <span className="dirty-dot" title="Unsaved changes are kept in the app" />}
                <button type="button" className="editor-tab-x" aria-label="Close tab" title="Close" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}><LuX size={12} /></button>
              </div>
            );
          })}
        </div>
      )}
      <div className="tabstrip">
        {explore && file && (
          <div className="file-crumb" title={file.relPath}>
            <LuFolderTree size={14} className="muted" />
            <span className="mono ellipsis">{file.relPath.replace(/^config\//, '')}</span>
            {dirty && <span className="dirty-dot" title="Unsaved changes" />}
          </div>
        )}
        {explore ? (
          <div className="scen-switch">
            <IconButton size="sm" icon={<LuChevronLeft size={15} />} title="Previous scenario" disabled={activeIdx <= 0} onClick={() => { setActiveIdx(activeIdx - 1); setSelectedId(null); }} />
            <Select
              size="sm"
              searchable
              className="w-scen"
              icon={<LuWorkflow size={13} />}
              title="Scenario in this file"
              value={String(activeIdx)}
              options={scenarios.map((s, i) => ({ value: String(i), label: `${i + 1} · ${s.name.trim() || `Scenario ${i + 1}`}` }))}
              onChange={(v) => { setActiveIdx(Number(v)); setSelectedId(null); }}
            />
            <IconButton size="sm" icon={<LuChevronRight size={15} />} title="Next scenario" disabled={activeIdx >= scenarios.length - 1} onClick={() => { setActiveIdx(activeIdx + 1); setSelectedId(null); }} />
            <span className="scen-count">{scenarios.length ? `${activeIdx + 1} of ${scenarios.length}` : ''}</span>
            <IconButton
              size="sm"
              icon={<LuPlus size={15} />}
              title="Add another scenario to this file"
              onClick={() => { setScenarios((a) => [...a, newScenario(a.length + 1)]); setActiveIdx(scenarios.length); setSelectedId(null); }}
            />
            {scenarios.length > 1 && activeScenario?.origIndex == null && (
              <IconButton
                size="sm"
                icon={<LuTrash2 size={13} />}
                title="Remove this (not-yet-saved) scenario"
                onClick={() => { setScenarios((a) => a.filter((_, k) => k !== activeIdx)); setActiveIdx((i) => Math.max(0, i - 1)); setSelectedId(null); }}
              />
            )}
          </div>
        ) : (
        <div className="doc-tabs">
          {scenarios.map((s, i) => (
            <div key={s.id} className={`doc-tab ${i === activeIdx ? 'active' : ''}`}>
              <button type="button" className="doc-tab-main" onClick={() => { setActiveIdx(i); setSelectedId(null); }}>
                <LuWorkflow size={13} />
                <span>{s.name.trim() || `Scenario ${i + 1}`}</span>
              </button>
              {scenarios.length > 1 && !explore && (
                <button
                  type="button"
                  className="doc-tab-close"
                  aria-label="Remove scenario"
                  title="Remove scenario"
                  onClick={() => { setScenarios((a) => a.filter((_, k) => k !== i)); setActiveIdx(0); setSelectedId(null); }}
                >
                  <LuX size={13} />
                </button>
              )}
            </div>
          ))}
          <IconButton size="sm" icon={<LuPlus size={15} />} title="Add scenario" onClick={() => { setScenarios((a) => [...a, newScenario(a.length + 1)]); setActiveIdx(scenarios.length); setSelectedId(null); }} />
        </div>
        )}
        <span className="spacer" />
        <Segmented
          size="sm"
          block={false}
          value={view}
          onChange={(v) => { setView(v); if (v === 'board') setYamlError(''); setYamlFocus(null); }}
          options={[{ value: 'board', label: 'Board' }, { value: 'yaml', label: 'YAML' }]}
        />
        <IconButton size="md" icon={<LuLayoutGrid size={15} />} title="Auto-arrange blocks" onClick={autoArrange} disabled={sc.nodes.length < 2 || view === 'yaml'} />
        <button
          type="button"
          className="btn"
          disabled={testProblems.length > 0 || (explore && !file) || !!yamlError || testRunning}
          title={testRunning ? 'A test is running: only one scenario runs at a time. Wait for it or stop it in the run panel.' : yamlError || testProblems[0] || 'Run this flow through real pytest before saving'}
          onClick={() => { setTestError(''); setTestModal(true); }}
        >
          <LuPlay size={14} /> Test scenario
        </button>
        {explore ? (
          <>
            <button type="button" className="btn" disabled={!dirty} onClick={() => setConfirmOpen({ discard: true })} title="Reload the file and drop unsaved edits">
              <LuUndo2 size={14} /> Discard
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!dirty || !!yamlError}
              title={yamlError || undefined}
              onClick={() => {
                // details first: a scenario without a name (or a new one without a namespace) cannot be saved, so ask for them
                const lacking = scenarios.findIndex((x) => missingDetails(x).length);
                if (lacking >= 0) {
                  setActiveIdx(lacking);
                  setSelectedId(null);
                  setDetailsPrompt(true);
                  setDetailsOpen(true);
                  return;
                }
                const pl = explorePayload();
                if (pl.problems.length) toast(pl.problems[0], 'error');
                else setSaveChangesOpen(pl);
              }}
            >
              <LuSave size={14} /> Save changes…
            </button>
          </>
        ) : (
          <button type="button" className="btn primary" disabled={!!yamlError} title={yamlError || undefined} onClick={() => setSaveOpen(true)}>
            <LuSave size={14} /> Save…
          </button>
        )}
      </div>

      {explore && file && file.unresolved.length > 0 && (
        <div className="notice warn banner"><LuCircleAlert size={15} /><div>{file.unresolved.length} sequence entr{file.unresolved.length === 1 ? 'y is' : 'ies are'} not defined in this file ({file.unresolved.slice(0, 3).join('; ')}). Saving is blocked until they resolve.</div></div>
      )}


      <div className="view-main">
        <div className="board-col" ref={colRef}>
          {view === 'board' && (!explore || file) && (
            <div className="canvas-chips">
              <button type="button" className={`canvas-chip scen ${detailsOpen ? 'open' : ''}`} onClick={() => { setDetailsOpen((o) => !o); setDetailsPrompt(false); setDetailsHint(false); setSelectedId(null); setPicker(null); }} title="Name, description, labels, namespaces and options of this scenario" aria-expanded={detailsOpen}>
                <LuSlidersHorizontal size={14} />
                <span className="canvas-chip-name">{sc.name.trim() || 'Unnamed scenario'}</span>
                <span className="muted">{sc.namespaces.length ? `${sc.namespaces.length} ns` : 'no namespace'}</span>
                {(!sc.name.trim() || !sc.namespaces.length) && <span className="need-dot" title="Needed to save" />}
              </button>
              <button type="button" className={`canvas-chip add ${picker ? 'open' : ''}`} onClick={() => (picker ? setPicker(null) : openPicker({}))} title="Add a workflow or an endpoint interaction">
                <LuPlus size={14} /> Add block
              </button>
              {detailsHint && !detailsOpen && (
                <div className="scen-hint" role="status" onClick={() => setDetailsHint(false)}>
                  <b>Scenario details</b>
                  <span>Name it, add labels and namespaces here.</span>
                </div>
              )}
            </div>
          )}
          {view === 'board' && (selected || detailsOpen) && (
            <div className="float-panel right">
              <div className="panel-head slim">
                <span className="panel-title">{selected ? 'Properties' : 'Scenario details'}</span>
                <IconButton size="sm" icon={<LuX size={15} />} title="Close" onClick={() => { setSelectedId(null); setDetailsOpen(false); setDetailsPrompt(false); }} />
              </div>
              <div className="panel-scroll">
                {selected ? <Inspector node={selected} schema={schema} onChange={setNode} onDelete={() => selected && deleteNode(selected.id)} onCopy={copySelection} /> : renderDetails()}
              </div>
            </div>
          )}
          {picker && view === 'board' && (
            <div className="add-pop" role="dialog" aria-label="Add a block">
              <Palette catalog={catalog} onAdd={pickBlock} onReload={() => loadAll(false)} reloading={reloading} onCollapse={() => setPicker(null)} />
            </div>
          )}
          {view === 'yaml' && <YamlEditor key={sc.id} scenario={sc} focusName={yamlFocus} onApply={applyYaml} onError={setYamlError} />}
          <div className="board-scroll" ref={scrollRef} hidden={view === 'yaml'}>
            <div
              ref={canvasRef}
              className="board"
              style={{ width: canvasW, height: canvasH }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              onPointerDown={(e) => { if (e.target === canvasRef.current) startMarquee(e); }}
              onClick={(e) => {
                if (didMarqueeRef.current) { didMarqueeRef.current = false; return; } // just finished drag-selecting - not a click
                if (e.target !== canvasRef.current) return;
                if (picker) { setPicker(null); return; }
                if (selectedId || detailsOpen || multiSelected.size) { setSelectedId(null); setDetailsOpen(false); setDetailsPrompt(false); setMultiSelected(new Set()); return; }
                if (explore && !file) return;
                const pt = canvasPoint(e.clientX, e.clientY);
                openPicker({ at: { x: pt.x - NODE_W / 2, y: pt.y - NODE_H / 2 } });
              }}
            >
              <svg width={canvasW} height={canvasH} className="board-svg">
                <defs>
                  <marker id="bld-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
                    <path d="M0,0 L9,4.5 L0,9 Z" className="board-arrowhead" />
                  </marker>
                </defs>
                {sc.edges.map((e) => {
                  const a = nodeById[e.from];
                  const b = nodeById[e.to];
                  if (!a || !b) return null;
                  const { d, mx, my } = bezier(a, b);
                  return (
                    <g key={`${e.from}-${e.to}`}>
                      <path d={d} className="board-edge" markerEnd="url(#bld-arrow)" />
                      <g className="board-edge-x" transform={`translate(${mx},${my})`} onClick={() => updateActive((s) => ({ ...s, edges: s.edges.filter((x) => x !== e) }))}>
                        <title>Remove connection</title>
                        <circle r="9" />
                        <path d="M-3,-3 L3,3 M3,-3 L-3,3" />
                      </g>
                    </g>
                  );
                })}
                {connecting && nodeById[connecting.from] && (
                  <path
                    className="board-edge pending"
                    d={`M${nodeById[connecting.from].x + NODE_W},${nodeById[connecting.from].y + NODE_H / 2} L${connecting.x},${connecting.y}`}
                  />
                )}
              </svg>

              {marquee && <div className="board-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}

              {sc.nodes.map((n) => (
                <div
                  key={n.id}
                  className={`bnode kind-${n.kind} ${selectedId === n.id ? 'selected' : ''} ${multiSelected.has(n.id) ? 'multi-selected' : ''}`}
                  style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
                  onPointerDown={(e) => startDrag(e, n)}
                >
                  <div className="bport in" data-in-port={n.id} title="Input" />
                  <div className="bport out" onPointerDown={(e) => startConnect(e, n)} title="Drag to the next block" />
                  {orderIndex[n.id] && <span className="bnode-order">{orderIndex[n.id]}</span>}
                  <button
                    type="button"
                    className="bnode-yaml"
                    title="Show in the YAML editor"
                    aria-label="Show in the YAML editor"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); setSelectedId(n.id); setYamlFocus(n.def.name); setView('yaml'); }}
                  >
                    <LuCode size={13} />
                  </button>
                  <div className="bnode-kind"><KindIcon kind={n.kind} size={12} /> {n.kind === 'workflow' ? 'Workflow' : 'Endpoint'}</div>
                  <div className="bnode-name">{n.def.name || '(unnamed)'}</div>
                  <div className="bnode-sub">
                    {n.kind === 'workflow'
                      ? [n.def.flow, n.def.method_ident || n.def.method_auth].filter(Boolean).join(' · ')
                      : [n.def.method, n.def.host, n.def.endpoint].filter(Boolean).join(' ')}
                  </div>
                </div>
              ))}

              {sc.nodes.length > 0 && tailId() && (() => {
                const t = nodeById[tailId()];
                return (
                  <button
                    type="button"
                    className="board-add"
                    style={{ left: t.x + NODE_W + 34, top: t.y + NODE_H / 2 - 16 }}
                    title="Add the next step"
                    aria-label="Add the next step"
                    onClick={(e) => { e.stopPropagation(); if (picker) setPicker(null); else openPicker({ at: { x: t.x + NODE_W + 76, y: t.y } }); }}
                  >
                    <LuPlus size={16} />
                  </button>
                );
              })()}

              {!sc.nodes.length && (
                <div className="board-hint">
                  <LuBlocks size={26} />
                  <div className="board-hint-title">{explore && !file ? 'Open a test file' : 'Start building your flow'}</div>
                  {explore && !file ? (
                    <div>Pick a file in <b>Files</b> on the left, or create one with its new file button.<br />Its scenarios open here as flows you can edit and test.</div>
                  ) : (
                    <>
                      <div>Add the first step. Every block you add after it joins the sequence on its own.</div>
                      <div className="board-hint-actions">
                        <button type="button" className="btn primary" onClick={(e) => { e.stopPropagation(); openPicker({}); }}><LuPlus size={14} /> Add a block</button>
                      </div>
                      <div className="board-hint-quick">
                        {TEMPLATES.filter((t) => ['register-user', 'login', 'register-device', 'endpoint'].includes(t.id)).map((t) => (
                          <button key={t.id} type="button" className={`quick kind-${t.kind}`} onClick={(e) => { e.stopPropagation(); addBlock({ kind: t.kind, def: t.def, origin: null }, undefined, { select: false }); }}>
                            <KindIcon kind={t.kind} size={13} /> {t.title}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {testRun && testOpen && (
            <TraceLinkContext.Provider value={traceLinks}>
            <TestRunPanel
              tab={dockTab}
              setTab={setDockTab}
              traces={testTraces}
              traceFocus={dockTraceFocus}
              run={testRun}
              flow={testFlow}
              sources={testSources}
              height={dockHeight}
              maximized={dockMax}
              collapsed={dockCollapsed}
              onSize={(n) => { setDockMax(false); setDockH(n); }}
              onReset={() => { setDockMax(false); resetDockH(); }}
              onStop={() => api.stopRun(testRun.id)}
              onToggleMax={() => { setDockCollapsed(false); setDockMax((m) => !m); }}
              onCollapse={() => setDockCollapsed((c) => !c)}
              onClose={() => setTestOpen(false)}
              onPopout={() => { if (!openPopout(`run-${testRun.id}-all`, { kind: 'run', run: testRun.id, view: 'logs' })) toast('The browser blocked the new window. Allow pop-ups for this site and try again.', 'error'); }}
            />
            </TraceLinkContext.Provider>
          )}
          {dockSheet && testRun && (
            <TraceSheet
              runTraces={testTraces}
              target={dockSheet}
              onClose={() => setDockSheet(null)}
              onExpand={() => { setDockTraceFocus({ ...dockSheet, nonce: Date.now() }); setDockTab('traces'); setDockCollapsed(false); setDockSheet(null); }}
            />
          )}
          {testRun && !testOpen && (
            <button type="button" className="dock-reopen" onClick={() => { setTestOpen(true); setDockCollapsed(false); }}>
              <StatusDot status={testRun.status} /> Show test run ({testRun.status})
            </button>
          )}
        </div>

      </div>

      <div className="seqbar">
        <span className="section-caption">Sequence</span>
        {seq.order.length ? (
          seq.order.map((id, i) => (
            <React.Fragment key={id}>
              {i > 0 && <LuChevronRight size={13} className="muted" />}
              <span className="seq-chip">{nodeById[id].def.name}</span>
            </React.Fragment>
          ))
        ) : (
          <span className="text-warn">{seq.problems[0]}</span>
        )}
      </div>

      {testModal && (
        <TestModal
          scenario={toScenarioPayload(sc)}
          namespaces={testNamespaces}
          defaultNamespace={defaultTestNs}
          busy={testBusy}
          error={testError}
          onRun={startTest}
          onClose={() => setTestModal(false)}
        />
      )}
      {saveOpen && <SaveModal payload={payload} chainProblems={allProblems} onClose={() => setSaveOpen(false)} />}
      {saveChangesOpen && file && (
        <SaveChangesModal
          relPath={file.relPath}
          payload={saveChangesOpen}
          onClose={() => setSaveChangesOpen(false)}
          onSaved={async (r) => {
            setSaveChangesOpen(false);
            toast(r.changed ? `Saved ${file.relPath.split('/').pop()} — review and commit it in the Git tab` : 'No changes to write');
            await openFile(file.relPath, scenarios[activeIdx]?.origIndex, { fresh: true });
            loadTree();
          }}
        />
      )}
      {confirmOpen && (
        <ConfirmModal
          title="Discard unsaved changes?"
          confirm="Discard changes"
          danger
          onClose={() => setConfirmOpen(null)}
          onConfirm={() => {
            setConfirmOpen(null);
            openFile(file.relPath, scenarios[activeIdx]?.origIndex, { fresh: true });
          }}
        >
          The file is reloaded from disk and your edits in this view are lost.
        </ConfirmModal>
      )}
      {deleteAsk && (
        <ConfirmModal
          title={deleteAsk.kind === 'folder' ? 'Delete folder?' : 'Delete file?'}
          confirm="Delete"
          danger
          onClose={() => setDeleteAsk(null)}
          onConfirm={() => { const d = deleteAsk; setDeleteAsk(null); deleteEntry(d); }}
        >
          <span className="mono">{deleteAsk.path}</span> is removed from disk
          {deleteAsk.kind === 'folder' ? ' (only empty folders can be deleted).' : '. A file that git already tracks can be restored from the Git tab; a new, uncommitted one cannot.'}
          {draftPaths.has(deleteAsk.path) && ' Its unsaved edits are dropped too.'}
        </ConfirmModal>
      )}
      </div>
    </div>
  );
}
