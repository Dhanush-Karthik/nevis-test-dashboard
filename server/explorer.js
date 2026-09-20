'use strict';

// Explorer: read existing scenario files as structured data and write edits back with
// surgical text patches - only the definitions / scenarios that actually changed are
// re-rendered (through the yaml Document, so their own comments survive); every other byte
// of the file stays exactly as the author wrote it.

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { findConfigFiles } = require('./scenarioCatalog');
const { insertIntoSection, itemsBlock } = require('./testBuilder');
const git = require('./git');

const { REPO_ROOT } = require('./paths');
const rel = (abs) => path.relative(REPO_ROOT, abs);

function resolveFile(relPath) {
  const abs = path.resolve(REPO_ROOT, relPath || '');
  return findConfigFiles().includes(abs) ? abs : null;
}

const list = (v) => (Array.isArray(v) ? v : []);

function tree() {
  const files = [];
  for (const abs of findConfigFiles()) {
    let doc;
    try {
      doc = YAML.parse(fs.readFileSync(abs, 'utf8'));
    } catch (_) {
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    files.push({
      relPath: rel(abs),
      scenarios: list(doc.scenarios).map((s, index) => ({ index, name: s.name, labels: list(s.labels).filter((l) => !/^[0-9a-f]{8}-/.test(l)) })),
      workflows: list(doc.workflows).map((w) => w.name),
      endpoints: list(doc.endpoint_interactions).map((e) => e.name),
    });
  }
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function readFile(relPath) {
  const abs = resolveFile(relPath);
  if (!abs) throw new Error('not a scenario file');
  const text = fs.readFileSync(abs, 'utf8');
  const doc = YAML.parse(text) || {};
  const wf = new Map(list(doc.workflows).map((w) => [w.name, w]));
  const ep = new Map(list(doc.endpoint_interactions).map((e) => [e.name, e]));
  const unresolved = [];
  const scenarios = list(doc.scenarios).map((s, index) => ({
    index,
    name: s.name,
    description: s.description || '',
    labels: list(s.labels),
    supportedNamespaces: list(s.supported_namespaces),
    sequence: list(s.sequence).map((n) => {
      if (wf.has(n)) return { kind: 'workflow', def: wf.get(n) };
      if (ep.has(n)) return { kind: 'endpoint', def: ep.get(n) };
      unresolved.push(`${s.name}: "${n}"`);
      return { kind: 'workflow', def: { name: n }, unresolved: true };
    }),
  }));
  return { relPath: rel(abs), scenarios, unresolved, mtime: fs.statSync(abs).mtimeMs, text };
}

/* ---------- patching ---------- */

const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const norm = (v) => {
  if (Array.isArray(v)) return v.map(norm);
  if (isPlain(v)) {
    return Object.fromEntries(
      Object.keys(v)
        .filter((k) => v[k] !== undefined && v[k] !== '' && !(Array.isArray(v[k]) && v[k].length === 0))
        .sort()
        .map((k) => [k, norm(v[k])])
    );
  }
  return v;
};
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

function styled(value, like) {
  if (Array.isArray(value)) {
    const seq = new YAML.YAMLSeq();
    value.forEach((v) => seq.items.push(styled(v)));
    seq.flow = like instanceof YAML.YAMLSeq ? like.flow : value.every(isScalar);
    return seq;
  }
  if (isPlain(value)) {
    const map = new YAML.YAMLMap();
    for (const [k, v] of Object.entries(value)) map.set(k, styled(v));
    return map;
  }
  const sc = new YAML.Scalar(value);
  if (typeof value === 'string') sc.type = 'QUOTE_DOUBLE';
  return sc;
}

function updateMap(doc, map, obj, known) {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val === undefined) continue;
    const existing = map.get(key, true);
    if (existing === undefined) {
      if (val === '' || (Array.isArray(val) && !val.length)) continue; // don't materialise empty keys the file never had
      map.set(key, styled(val));
    } else if (existing instanceof YAML.Scalar && isScalar(val) && (val === null || existing.value === null || typeof existing.value === typeof val)) {
      if (existing.value !== val) existing.value = val; // keeps the scalar's own quoting style
    } else if (existing instanceof YAML.YAMLMap && isPlain(val)) {
      updateMap(doc, existing, val);
    } else if (!same(existing.toJS(doc), val)) {
      map.set(key, styled(val, existing));
    }
  }
  for (const pair of [...map.items]) {
    const k = pair.key && pair.key.value !== undefined ? pair.key.value : pair.key;
    if (known && !known.includes(k)) continue; // keys the editor does not model are never touched
    if (!(k in obj) || obj[k] === undefined) map.delete(k);
  }
}

// Renders one (edited) seq item on its own, indented to sit where the original did.
function renderItem(item, base) {
  const holder = new YAML.Document();
  const seq = new YAML.YAMLSeq();
  item.commentBefore = null; // stays in the untouched text above the replaced range
  item.spaceBefore = false; // and so does the blank line separating it from the previous item
  seq.items.push(item);
  holder.contents = seq;
  const out = holder.toString({ lineWidth: 0, indentSeq: true }).replace(/\n+$/, '');
  return out.split('\n').map((l) => (l ? ' '.repeat(base) + l : l)).join('\n');
}

function planSection(doc, text, key, wanted, edits, additions, known) {
  const seq = doc.get(key, true);
  for (const w of wanted) {
    const item =
      seq instanceof YAML.YAMLSeq
        ? w.origIndex !== undefined
          ? w.origIndex !== null ? seq.items[w.origIndex] : null
          : w.origName ? seq.items.find((i) => i && i.get && i.get('name') === w.origName) : null
        : null;
    if (!item) {
      additions.push(w.obj);
      continue;
    }
    const before = item.toJS(doc);
    if (same(known ? Object.fromEntries(known.filter((k) => k in before).map((k) => [k, before[k]])) : before, w.obj)) continue;
    const [start, valueEnd] = item.range;
    const lineStart = text.lastIndexOf('\n', start) + 1;
    const dash = text.indexOf('-', lineStart);
    const base = dash >= 0 && dash < start ? dash - lineStart : 0;
    let end = valueEnd;
    if (text[end - 1] === '\n') end -= 1;
    const eol = text.indexOf('\n', end);
    const stop = eol === -1 ? text.length : eol;
    updateMap(doc, item, w.obj, known);
    // a comment hanging off the item's last line is still in the untouched text after the range
    const after = text.slice(stop + 1).split('\n');
    const lines = renderItem(item, base).split('\n');
    let k = 0;
    while (lines.length > 1 && lines[lines.length - 1].trim().startsWith('#') && lines[lines.length - 1].trim() === (after[k] || '').trim()) {
      lines.pop();
      k += 1;
    }
    edits.push({ start: lineStart, end: stop, text: lines.join('\n') });
  }
}

const defOf = (d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));

function plan({ relPath, scenarios }) {
  const abs = resolveFile(relPath);
  if (!abs) return { ok: false, errors: ['Not a scenario file.'] };
  const text = fs.readFileSync(abs, 'utf8');
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) return { ok: false, errors: [`The file has YAML errors: ${doc.errors[0].message}`] };
  const errors = [];

  const wfs = new Map();
  const eps = new Map();
  const scs = [];
  const names = new Set();
  for (const [i, sc] of (scenarios || []).entries()) {
    const label = `Scenario ${sc.name || i + 1}`;
    const isNew = sc.origIndex === undefined || sc.origIndex === null;
    // Existing files may predate today's conventions: only what is new or renamed is validated.
    if ((isNew || sc.name !== sc.origName) && (!sc.name || !/^[A-Za-z0-9._-]+$/.test(sc.name))) errors.push(`${label}: name is required (letters/digits/-/_/.).`);
    if ((isNew || sc.name !== sc.origName) && names.has(sc.name)) errors.push(`${label}: duplicate scenario name.`);
    names.add(sc.name);
    if (isNew && !list(sc.supportedNamespaces).length) errors.push(`${label}: pick at least one supported namespace.`);
    if (isNew && !list(sc.sequence).length) errors.push(`${label}: the sequence is empty.`);
    const seqNames = [];
    for (const step of list(sc.sequence)) {
      const def = defOf(step.def || {});
      if (step.unresolved) errors.push(`${label}: "${def.name}" is not defined in this file.`);
      if (!def.name || ((!step.origName || step.origName !== def.name) && !/^[A-Za-z0-9._-]+$/.test(def.name))) {
        errors.push(`${label}: every block needs a valid name.`);
        continue;
      }
      const map = step.kind === 'workflow' ? wfs : eps;
      const prev = map.get(def.name);
      if (prev && !same(prev.obj, def)) errors.push(`${label}: "${def.name}" is used with different settings in two scenarios - give one a different name.`);
      else if (!prev) map.set(def.name, { origName: step.origName || null, obj: def });
      seqNames.push(def.name);
    }
    const obj = { name: sc.name, supported_namespaces: list(sc.supportedNamespaces), labels: list(sc.labels), sequence: seqNames };
    if (sc.description) obj.description = sc.description;
    scs.push({ origIndex: isNew ? null : sc.origIndex, obj });
  }
  if (errors.length) return { ok: false, errors };

  const edits = [];
  const added = { workflows: [], endpoint_interactions: [], scenarios: [] };
  planSection(doc, text, 'workflows', [...wfs.values()], edits, added.workflows);
  planSection(doc, text, 'endpoint_interactions', [...eps.values()], edits, added.endpoint_interactions);
  planSection(doc, text, 'scenarios', scs, edits, added.scenarios, ['name', 'description', 'supported_namespaces', 'labels', 'sequence']);

  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  try {
    for (const [key, items] of Object.entries(added)) if (items.length) out = insertIntoSection(out, key, itemsBlock(key, items));
    const check = YAML.parse(out);
    if (!check || list(check.scenarios).length < scs.length) throw new Error('scenario count mismatch after patching');
  } catch (e) {
    return { ok: false, errors: [`Could not apply the change safely: ${e.message}`] };
  }
  return {
    ok: true,
    absPath: abs,
    relPath: rel(abs),
    oldText: text,
    newText: out,
    changed: out !== text,
    counts: { edited: edits.length, added: added.workflows.length + added.endpoint_interactions.length + added.scenarios.length },
  };
}

async function preview(payload) {
  const p = plan(payload);
  if (!p.ok) return p;
  return { ok: true, relPath: p.relPath, changed: p.changed, counts: p.counts, diff: p.changed ? await git.diffTexts(p.oldText, p.newText, p.relPath) : '' };
}

function save(payload) {
  const p = plan(payload);
  if (!p.ok) return p;
  if (p.changed) fs.writeFileSync(p.absPath, p.newText, 'utf8');
  return { ok: true, relPath: p.relPath, changed: p.changed, counts: p.counts };
}

module.exports = { tree, readFile, preview, save };
