'use strict';

// Lists and serves files under the integration-test project's output/ directory - flows write
// artifacts there while they run (downloaded PDFs, exported tokens/certs, screenshots, ...).
// Read-only: the dashboard never writes into it, only lists/downloads what pytest already left.

const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('./paths');

const OUTPUT_ROOT = path.join(REPO_ROOT, 'output');

function walk(dir, base) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    const relPath = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(abs, relPath));
    else if (e.isFile()) {
      const st = fs.statSync(abs);
      out.push({ relPath, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

// Only files touched at or after `since` (a run's own createdAt) - output/ is shared across runs,
// but only one run is ever active at a time, so this is exactly what the given run wrote to it.
function list(since) {
  const all = walk(OUTPUT_ROOT, '').sort((a, b) => a.relPath.localeCompare(b.relPath));
  return since ? all.filter((f) => f.mtimeMs >= since) : all;
}

// Resolves a relative path strictly inside output/ - refuses anything that escapes it via `..`
// or a symlink, and anything that isn't a plain file.
function resolve(relPath) {
  if (!relPath) return null;
  const abs = path.resolve(OUTPUT_ROOT, relPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  const real = fs.realpathSync(abs);
  const rootReal = fs.existsSync(OUTPUT_ROOT) ? fs.realpathSync(OUTPUT_ROOT) : OUTPUT_ROOT;
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
  return real;
}

module.exports = { list, resolve };
