'use strict';

// Reads and edits the project's .env in place: comments, blank lines, ordering and quoting of everything
// that is not changed stay exactly as they are. Values are only ever sent to the browser on this machine;
// nothing here logs them.
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('./paths');

const ENV_PATH = path.join(REPO_ROOT, '.env');
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const LINE_RE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/;

function unquote(raw) {
  const t = raw.trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') return { value: t.slice(1, -1).replace(/\\(["\\nrt])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] || c)), quote: '"' };
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return { value: t.slice(1, -1), quote: "'" };
  return { value: t.replace(/\s+#.*$/, '').trim(), quote: '' };
}

function render(value, quote) {
  const v = String(value);
  if (/[\r\n]/.test(v) && quote !== "'") return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
  if (quote === "'" && !v.includes("'")) return `'${v}'`;
  if (quote === '"' || /[\s#"'$`\\]/.test(v) || v === '') return v === '' && !quote ? '' : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return v;
}

function parse(text) {
  const lines = text.split('\n');
  const entries = [];
  lines.forEach((line, i) => {
    const m = line.replace(/\r$/, '').match(LINE_RE);
    if (!m || m[3].startsWith('#')) return;
    const { value, quote } = unquote(m[5]);
    let c = i - 1;
    const notes = [];
    while (c >= 0 && /^\s*#/.test(lines[c])) notes.unshift(lines[c].replace(/^\s*#\s?/, '')), (c -= 1);
    entries.push({ key: m[3], value, quote, exported: !!m[2], comment: notes.join(' ').trim(), line: i + 1 });
  });
  return entries;
}

function read() {
  const exists = fs.existsSync(ENV_PATH);
  const text = exists ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  return { exists, text, entries: parse(text) };
}

function applyOps(text, ops) {
  let lines = text.split('\n');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const op of ops) {
    if (!KEY_RE.test(op.key || '')) throw new Error(`"${op.key}" is not a valid variable name (letters, digits and _ only).`);
    const idx = [];
    lines.forEach((l, i) => { const m = l.replace(/\r$/, '').match(LINE_RE); if (m && m[3] === op.key) idx.push(i); });
    if (op.op === 'add') {
      if (idx.length) throw new Error(`${op.key} is already defined.`);
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      const add = [];
      if (lines.length) add.push('');
      if (op.comment) add.push(`# ${String(op.comment).replace(/\r?\n/g, ' ')}`);
      add.push(`${op.key}=${render(op.value ?? '', '')}`);
      lines = [...lines, ...add, ''];
    } else if (op.op === 'set') {
      if (!idx.length) throw new Error(`${op.key} is not in the file.`);
      const i = idx[idx.length - 1];
      const m = lines[i].replace(/\r$/, '').match(LINE_RE);
      const { quote } = unquote(m[5]);
      lines[i] = `${m[1]}${m[2] || ''}${m[3]}${m[4]}${render(op.value ?? '', quote)}`;
    } else if (op.op === 'delete') {
      if (!idx.length) throw new Error(`${op.key} is not in the file.`);
      lines = lines.filter((_, i) => !idx.includes(i));
    } else throw new Error('unknown operation');
  }
  return lines.join(eol);
}

function write(text) {
  if (text.includes('\0') || text.length > 256 * 1024) throw new Error('That does not look like a .env file.');
  const existed = fs.existsSync(ENV_PATH);
  fs.writeFileSync(ENV_PATH, text, existed ? {} : { mode: 0o600 });
  if (!existed) fs.chmodSync(ENV_PATH, 0o600);
}

// Variable names the project's own code reads from the environment: offered as suggestions when adding one.
const SKIP = new Set(['.venv', 'venv', 'node_modules', '.git', '__pycache__', 'test-dashboard', 'output', 'logs', 'images']);
function scanUsedKeys() {
  const found = new Map();
  const re = /os\.(?:environ\.get\(|getenv\(|environ\[)\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.py')) {
        let src;
        try { src = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(src))) if (!found.has(m[1])) found.set(m[1], path.relative(REPO_ROOT, p));
      }
    }
  };
  walk(REPO_ROOT, 0);
  // secret-manager API key variable names are referenced from the defaults (api_key_name: "API_KEY_X")
  const defaultsDir = path.join(REPO_ROOT, 'config', 'defaults');
  try {
    for (const f of fs.readdirSync(defaultsDir)) {
      if (!f.endsWith('.yaml')) continue;
      const src = fs.readFileSync(path.join(defaultsDir, f), 'utf8');
      for (const m of src.matchAll(/api_key_name:\s*["']?([A-Za-z_][A-Za-z0-9_]*)/g)) if (!found.has(m[1])) found.set(m[1], `config/defaults/${f} (api_key_name)`);
    }
  } catch (_) { /* no defaults folder */ }
  return [...found.entries()].map(([key, file]) => ({ key, file })).sort((a, b) => a.key.localeCompare(b.key));
}

module.exports = { ENV_PATH, read, parse, applyOps, write, scanUsedKeys };
