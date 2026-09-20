'use strict';

// Where the integration-test project lives. The dashboard only ever reads/writes files inside this
// directory (config/**/*.yaml, lib/*.py for property discovery) and spawns its pytest - it never
// changes the project's Python code. Resolution order:
//   1. NEVIS_TESTS_ROOT (set by `nevis-dashboard --root <dir>`)
//   2. the folder that contains this dashboard (when it is dropped inside the project)
//   3. the current working directory (when started from inside the project)
const fs = require('fs');
const path = require('path');

const looksLikeSuite = (dir) => {
  try {
    return fs.existsSync(path.join(dir, 'integration_test.py')) && fs.statSync(path.join(dir, 'config')).isDirectory();
  } catch (_) {
    return false;
  }
};

function resolveRoot() {
  const explicit = process.env.NEVIS_TESTS_ROOT;
  if (explicit) {
    const abs = path.resolve(explicit);
    if (looksLikeSuite(abs)) return abs;
    return { error: `NEVIS_TESTS_ROOT / --root points at ${abs}, which has no integration_test.py and config/ folder.` };
  }
  for (const dir of [path.resolve(__dirname, '..', '..'), process.cwd()]) if (looksLikeSuite(dir)) return dir;
  return { error: 'Could not find the integration-test project (a folder with integration_test.py and config/).\nRun the dashboard from inside that folder, or pass --root <path> (or set NEVIS_TESTS_ROOT).' };
}

const found = resolveRoot();
if (typeof found !== 'string') {
  console.error(`[dashboard] ${found.error}`);
  process.exit(1);
}

const REPO_ROOT = found;
const venvPytest = path.join(REPO_ROOT, '.venv', 'bin', 'pytest');
// NEVIS_PYTEST overrides; otherwise the project's own venv, otherwise whatever `pytest` is on PATH.
const PYTEST_BIN = process.env.NEVIS_PYTEST || (fs.existsSync(venvPytest) ? venvPytest : 'pytest');

module.exports = { REPO_ROOT, PYTEST_BIN };
