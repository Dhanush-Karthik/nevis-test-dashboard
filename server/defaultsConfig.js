'use strict';

// The suite's default configuration (config/defaults/*.yaml): per-namespace values, and the defaults every
// workflow / endpoint interaction starts from. Edits are patched into the file text, so comments, blank
// lines, ordering and quoting of everything that is not touched stay byte-for-byte as they were.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');
const { REPO_ROOT } = require('./paths');

const DIR = path.join('config', 'defaults');
const SECTIONS = {
  namespaces: { file: path.join(DIR, 'namespace_defaults_config.yaml'), title: 'Namespaces', root: null },
  workflows: { file: path.join(DIR, 'workflow_defaults_config.yaml'), title: 'Workflows', root: 'workflows' },
  endpoints: { file: path.join(DIR, 'endpoint_interaction_defaults_config.yaml'), title: 'Endpoint interactions', root: 'endpoint_interactions' },
};

const KEY_RE = /^[A-Za-z0-9_.-]+$/;
const abs = (id) => path.join(REPO_ROOT, SECTIONS[id].file);
const hashOf = (text) => crypto.createHash('sha1').update(text).digest('hex');
const lineStartOf = (text, pos) => text.lastIndexOf('\n', pos - 1) + 1;
const lineEndOf = (text, pos) => {
  const i = text.indexOf('\n', pos);
  return i < 0 ? text.length : i;
};

function section(id) {
  if (!SECTIONS[id]) throw new Error('unknown section');
  return SECTIONS[id];
}

function load(id) {
  section(id);
  const file = abs(id);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`${SECTIONS[id].file} does not parse: ${doc.errors[0].message.split('\n')[0]}`);
  return { text, doc, file };
}

// contiguous "# ..." lines directly above a key's line
function commentAbove(text, keyStart) {
  const lines = [];
  let pos = lineStartOf(text, keyStart);
  while (pos > 0) {
    const prevStart = lineStartOf(text, pos - 1);
    const line = text.slice(prevStart, pos - 1);
    if (!/^\s*#/.test(line)) break;
    lines.unshift(line.replace(/^\s*#\s?/, ''));
    pos = prevStart;
  }
  return lines.join(' ').trim();
}

function nodeValue(node, doc) {
  if (node === null || node === undefined) return null;
  return YAML.isScalar(node) ? node.value : node.toJS(doc);
}

function entriesOf(map, text, doc) {
  if (!YAML.isMap(map)) return [];
  return map.items.map((pair) => ({
    key: String(pair.key && pair.key.value !== undefined ? pair.key.value : pair.key),
    value: nodeValue(pair.value, doc),
    raw: pair.value && pair.value.range ? text.slice(pair.value.range[0], pair.value.range[1]) : 'null',
    comment: pair.key && pair.key.range ? commentAbove(text, pair.key.range[0]) : '',
  }));
}

function mapFor(doc, id, ns) {
  if (id === 'namespaces') {
    if (!ns) return doc.contents;
    const pair = doc.contents && doc.contents.items.find((p) => String(p.key.value) === ns);
    return pair ? pair.value : undefined;
  }
  return doc.get(SECTIONS[id].root, true);
}

function read(id) {
  const { text, doc } = load(id);
  const base = { id, title: SECTIONS[id].title, file: SECTIONS[id].file, hash: hashOf(text) };
  if (id === 'namespaces') {
    const items = doc.contents && YAML.isMap(doc.contents) ? doc.contents.items : [];
    return { ...base, namespaces: items.map((p) => ({ name: String(p.key.value), entries: entriesOf(p.value, text, doc) })) };
  }
  return { ...base, entries: entriesOf(mapFor(doc, id), text, doc) };
}

/* ---------- rendering ---------- */

const plainSafe = (s) => /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(s) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(s) && Number.isNaN(Number(s));
function renderValue(v, origType) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return origType === 'PLAIN' && plainSafe(v) ? v : JSON.stringify(v);
  if (Array.isArray(v)) return v.length ? `[ ${v.map((i) => renderValue(i, '')).join(', ')} ]` : '[ ]';
  const keys = Object.keys(v);
  return keys.length ? `{ ${keys.map((k) => `${plainSafe(k) ? k : JSON.stringify(k)}: ${renderValue(v[k], '')}`).join(', ')} }` : '{ }';
}

/* ---------- patching ---------- */

function pairOf(map, key) {
  return YAML.isMap(map) ? map.items.find((p) => String(p.key.value) === key) : undefined;
}
function pairEnd(pair) {
  return pair.value && pair.value.range ? pair.value.range[1] : pair.key.range[1] + 1;
}

function opSet(text, doc, id, op) {
  const map = mapFor(doc, id, op.ns);
  const pair = pairOf(map, op.key);
  if (!pair) throw new Error(`${op.key} is not defined${op.ns ? ` in ${op.ns}` : ''}.`);
  const orig = YAML.isScalar(pair.value) ? pair.value.type : '';
  const rendered = renderValue(op.value, orig);
  if (!pair.value || !pair.value.range) {
    const colon = text.indexOf(':', pair.key.range[1]);
    return `${text.slice(0, colon + 1)} ${rendered}${text.slice(colon + 1)}`;
  }
  const [s, e] = pair.value.range;
  return `${text.slice(0, s)}${rendered}${text.slice(e)}`;
}

function opAdd(text, doc, id, op) {
  const map = mapFor(doc, id, op.ns);
  if (pairOf(map, op.key)) throw new Error(`${op.key} already exists${op.ns ? ` in ${op.ns}` : ''}.`);
  const value = renderValue(op.value, '');
  const comment = String(op.comment || '').trim();
  if (YAML.isMap(map) && map.items.length) {
    const first = map.items[0];
    const last = map.items[map.items.length - 1];
    const indent = ' '.repeat(first.key.range[0] - lineStartOf(text, first.key.range[0]));
    const spaced = map.items.length > 1 && /\n[ \t]*\n/.test(text.slice(pairEnd(first), map.items[1].key.range[0])) || !!comment;
    const at = lineEndOf(text, pairEnd(last));
    const lead = spaced ? '\n' : '';
    const note = comment ? comment.split('\n').map((l) => `\n${indent}# ${l}`).join('') : '';
    return `${text.slice(0, at)}${lead}${note}\n${indent}${op.key}: ${value}${text.slice(at)}`;
  }
  // empty section / namespace: put the first entry right under its header line
  const header = id === 'namespaces' ? op.ns : SECTIONS[id].root;
  const m = new RegExp(`^${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[^\\n]*$`, 'm').exec(text);
  if (!m) throw new Error(`Could not find "${header}:" in ${SECTIONS[id].file}.`);
  if (/\{\s*\}/.test(m[0])) throw new Error(`${header} is written as an empty { } block; add a first entry by hand.`);
  const at = m.index + m[0].length;
  return `${text.slice(0, at)}${comment ? comment.split('\n').map((l) => `\n  # ${l}`).join('') : ''}\n  ${op.key}: ${value}${text.slice(at)}`;
}

// Removes [start of the entry's comment block, end of its last line]; tidies one doubled blank line.
function cutLines(text, fromPos, toPos) {
  let start = lineStartOf(text, fromPos);
  while (start > 0) {
    const prevStart = lineStartOf(text, start - 1);
    if (!/^\s*#/.test(text.slice(prevStart, start - 1))) break;
    start = prevStart;
  }
  let end = lineEndOf(text, toPos);
  end = end < text.length ? end + 1 : end;
  let before = text.slice(0, start);
  let after = text.slice(end);
  if (before.endsWith('\n\n') && after.startsWith('\n')) after = after.slice(1);
  else if (before.endsWith('\n\n') && after === '') before = before.slice(0, -1);
  return before + after;
}

function opDelete(text, doc, id, op) {
  const map = mapFor(doc, id, op.ns);
  const pair = pairOf(map, op.key);
  if (!pair) throw new Error(`${op.key} is not defined${op.ns ? ` in ${op.ns}` : ''}.`);
  return cutLines(text, pair.key.range[0], pairEnd(pair));
}

function opAddNamespace(text, doc, op) {
  if (!KEY_RE.test(op.name || '')) throw new Error('A namespace name may contain letters, digits, . _ and - only.');
  if (mapFor(doc, 'namespaces', op.name)) throw new Error(`Namespace ${op.name} already exists.`);
  const trimmed = text.replace(/\s+$/, '');
  if (op.copyFrom) {
    const src = mapFor(doc, 'namespaces', op.copyFrom);
    if (!YAML.isMap(src) || !src.items.length) throw new Error(`${op.copyFrom} has nothing to copy.`);
    const first = src.items[0];
    const last = src.items[src.items.length - 1];
    const body = text.slice(lineStartOf(text, first.key.range[0]), lineEndOf(text, pairEnd(last)));
    return `${trimmed}\n\n${op.name}:\n${body}\n`;
  }
  return `${trimmed}\n\n${op.name}: { }\n`;
}

function opDeleteNamespace(text, doc, op) {
  const pair = doc.contents && doc.contents.items.find((p) => String(p.key.value) === op.name);
  if (!pair) throw new Error(`Namespace ${op.name} does not exist.`);
  return cutLines(text, pair.key.range[0], pairEnd(pair));
}

function applyOps(id, text, ops) {
  let out = text;
  for (const op of ops) {
    if (op.key !== undefined && !KEY_RE.test(op.key)) throw new Error(`"${op.key}" is not a valid key (letters, digits, . _ and - only).`);
    const doc = YAML.parseDocument(out);
    if (doc.errors.length) throw new Error('the file stopped parsing while applying changes');
    if (op.op === 'set') out = opSet(out, doc, id, op);
    else if (op.op === 'add') out = opAdd(out, doc, id, op);
    else if (op.op === 'delete') out = opDelete(out, doc, id, op);
    else if (op.op === 'addNamespace' && id === 'namespaces') out = opAddNamespace(out, doc, op);
    else if (op.op === 'deleteNamespace' && id === 'namespaces') out = opDeleteNamespace(out, doc, op);
    else throw new Error('unknown operation');
    const check = YAML.parseDocument(out);
    if (check.errors.length) throw new Error(`that change would break the file (${check.errors[0].message.split('\n')[0]})`);
  }
  return out;
}

// Value-level sanity check: apply, then confirm the result reads back as intended.
function plan(id, ops, baseHash) {
  const { text } = load(id);
  if (baseHash && baseHash !== hashOf(text)) throw new Error('The file changed on disk since you opened it. Reload and redo your changes.');
  const next = applyOps(id, text, Array.isArray(ops) ? ops : []);
  return { relPath: SECTIONS[id].file, oldText: text, newText: next, changed: next !== text };
}

function save(id, ops, baseHash) {
  const p = plan(id, ops, baseHash);
  if (p.changed) fs.writeFileSync(abs(id), p.newText);
  return { ok: true, changed: p.changed, hash: hashOf(p.newText) };
}

module.exports = { SECTIONS, read, plan, save, applyOps, hashOf };
