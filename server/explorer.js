'use strict';

// Explorer: read existing scenario files as structured data and write edits back with
// surgical text patches - only the definitions / scenarios that actually changed are
// re-rendered (through the yaml Document, so their own comments survive); every other byte
// of the file stays exactly as the author wrote it.

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { findConfigFiles, SEARCH_DIRS } = require('./scenarioCatalog');
const { insertIntoSection, itemsBlock } = require('./testBuilder');
const git = require('./git');

const { REPO_ROOT } = require('./paths');
const rel = (abs) => path.relative(REPO_ROOT, abs);

// Folders the explorer shows: the ones pytest reads scenario files from (it globs *.yaml directly inside each),
// plus any folder made under config/ (config/defaults and config/fixtures hold other kinds of YAML and are left out).
// Files in the second kind are editable here but pytest does not read them until they are moved into a pytest folder.
const EXCLUDED_DIRS = new Set(['config/defaults', 'config/fixtures']);
const CONFIG_ROOT = path.join(REPO_ROOT, 'config');

function allDirs() {
  const out = new Set(SEARCH_DIRS.filter((d) => fs.existsSync(path.join(REPO_ROOT, d))));
  const walk = (abs) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === '__pycache__') continue;
      const child = path.join(abs, e.name);
      const r = rel(child);
      if (EXCLUDED_DIRS.has(r)) continue;
      out.add(r);
      walk(child);
    }
  };
  if (fs.existsSync(CONFIG_ROOT)) walk(CONFIG_ROOT);
  return [...out].sort();
}
const scenarioDirs = () => ({ dirs: allDirs(), unscanned: allDirs().filter((d) => !SEARCH_DIRS.includes(d)) });

function explorerFiles() {
  const files = new Set(findConfigFiles());
  for (const d of allDirs()) {
    const abs = path.join(REPO_ROOT, d);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.yaml') && !e.name.startsWith('zz_dashboard_draft_')) files.add(path.join(abs, e.name));
    }
  }
  return [...files];
}

function resolveFile(relPath) {
  const abs = path.resolve(REPO_ROOT, relPath || '');
  return explorerFiles().includes(abs) ? abs : null;
}

const list = (v) => (Array.isArray(v) ? v : []);

function tree() {
  const files = [];
  for (const abs of explorerFiles()) {
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

const NEW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SKELETON = 'workflows: []\n\nendpoint_interactions: []\n\nscenarios: []\n';

function checkDir(dir) {
  const clean = String(dir || '').replace(/\/+$/, '');
  if (!allDirs().includes(clean)) throw new Error(`"${clean}" is not a folder of the explorer (it must be under config/).`);
  return { clean, abs: path.join(REPO_ROOT, clean) };
}

const baseName = (name) => String(name || '').trim().replace(/\.ya?ml$/i, '');
function checkName(base) {
  if (!NEW_NAME_RE.test(base) || base.length > 80) throw new Error('Name: letters, digits, "-", "_" and "." only, starting with a letter or digit.');
}

// New, empty test file (the explorer's "New file"): never overwrites.
function createFile({ dir, name }) {
  const { clean, abs } = checkDir(dir);
  const base = baseName(name);
  checkName(base);
  const target = path.join(abs, `${base}.yaml`);
  if (fs.existsSync(target)) throw new Error(`${clean}/${base}.yaml already exists.`);
  fs.writeFileSync(target, SKELETON, { flag: 'wx' });
  return { relPath: rel(target) };
}

// New folder under config/. pytest only reads the folders it lists, so files in a new one are not run until moved.
function createFolder({ parent, name }) {
  const { clean, abs } = checkDir(parent);
  const n = String(name || '').trim();
  checkName(n);
  const target = path.join(abs, n);
  if (fs.existsSync(target)) throw new Error(`${clean}/${n} already exists.`);
  fs.mkdirSync(target);
  return { path: rel(target), scanned: SEARCH_DIRS.includes(rel(target)) };
}

// Duplicate a file next to the original as "<name>-copy.yaml" (then "-copy-2", ...). Scenario uuid labels are
// regenerated, because a label picks tests by uuid and two files sharing one would both run.
function copyFile({ from }) {
  const src = resolveFile(from);
  if (!src) throw new Error('not a scenario file');
  const dir = path.dirname(src);
  const stem = path.basename(src, '.yaml');
  let target;
  for (let n = 1; ; n += 1) {
    target = path.join(dir, `${stem}-copy${n > 1 ? `-${n}` : ''}.yaml`);
    if (!fs.existsSync(target)) break;
  }
  const uuids = new Map();
  const text = fs.readFileSync(src, 'utf8').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (u) => {
    if (!uuids.has(u.toLowerCase())) uuids.set(u.toLowerCase(), require('crypto').randomUUID());
    return uuids.get(u.toLowerCase());
  });
  fs.writeFileSync(target, text, { flag: 'wx' });
  return { relPath: rel(target), newLabels: uuids.size };
}

function renameFile({ from, name }) {
  const src = resolveFile(from);
  if (!src) throw new Error('not a scenario file');
  const base = baseName(name);
  checkName(base);
  const target = path.join(path.dirname(src), `${base}.yaml`);
  if (target === src) return { relPath: rel(src), renamed: false };
  if (fs.existsSync(target)) throw new Error(`${base}.yaml already exists in that folder.`);
  fs.renameSync(src, target);
  return { relPath: rel(target), renamed: true };
}

// Deletes a scenario file, or an EMPTY folder that is not one pytest itself reads. Nothing recursive.
function deleteEntry({ path: p, kind }) {
  if (kind === 'folder') {
    const { clean, abs } = checkDir(p);
    if (SEARCH_DIRS.includes(clean)) throw new Error(`${clean} is a folder pytest reads from and cannot be deleted here.`);
    if (fs.readdirSync(abs).length) throw new Error(`${clean} is not empty.`);
    fs.rmdirSync(abs);
    return { deleted: clean };
  }
  const src = resolveFile(p);
  if (!src) throw new Error('not a scenario file');
  fs.unlinkSync(src);
  return { deleted: rel(src) };
}

// Drag & drop in the explorer: move a scenario file to another folder.
function moveFile({ from, toDir }) {
  const src = resolveFile(from);
  if (!src) throw new Error('not a scenario file');
  const { clean, abs } = checkDir(toDir);
  if (path.dirname(src) === abs) return { relPath: rel(src), moved: false };
  const target = path.join(abs, path.basename(src));
  if (fs.existsSync(target)) throw new Error(`${clean} already has a file named ${path.basename(src)}.`);
  fs.renameSync(src, target);
  return { relPath: rel(target), moved: true };
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
    clearOutput: typeof s.clear_output === 'boolean' ? s.clear_output : undefined,
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
    if (typeof sc.clearOutput === 'boolean') obj.clear_output = sc.clearOutput;
    scs.push({ origIndex: isNew ? null : sc.origIndex, obj });
  }
  if (errors.length) return { ok: false, errors };

  const edits = [];
  const added = { workflows: [], endpoint_interactions: [], scenarios: [] };
  planSection(doc, text, 'workflows', [...wfs.values()], edits, added.workflows);
  planSection(doc, text, 'endpoint_interactions', [...eps.values()], edits, added.endpoint_interactions);
  planSection(doc, text, 'scenarios', scs, edits, added.scenarios, ['name', 'description', 'supported_namespaces', 'labels', 'clear_output', 'sequence']);

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

module.exports = { tree, scenarioDirs, createFile, createFolder, copyFile, renameFile, deleteEntry, moveFile, readFile, preview, save };
