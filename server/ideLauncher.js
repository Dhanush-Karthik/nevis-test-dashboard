'use strict';

// Opens a log snapshot in a locally installed IDE/editor. The dashboard server runs
// on the developer's machine, so it can hand a temp file straight to the editor.
// Only a fixed allow-list of launchers is ever spawned (no user-supplied commands).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const LOG_DIR = path.join(__dirname, '..', '.run', 'logs');

// mac: app bundle name for `open -a`; cli: binary on PATH (any platform).
const IDES = [
  { id: 'vscode', label: 'VS Code', mac: 'Visual Studio Code', cli: 'code' },
  { id: 'cursor', label: 'Cursor', mac: 'Cursor', cli: 'cursor' },
  { id: 'windsurf', label: 'Windsurf', mac: 'Windsurf', cli: 'windsurf' },
  { id: 'idea', label: 'IntelliJ IDEA', mac: 'IntelliJ IDEA', macAlt: ['IntelliJ IDEA CE', 'IntelliJ IDEA Ultimate'], cli: 'idea' },
  { id: 'pycharm', label: 'PyCharm', mac: 'PyCharm', macAlt: ['PyCharm CE', 'PyCharm Professional'], cli: 'pycharm' },
  { id: 'webstorm', label: 'WebStorm', mac: 'WebStorm', cli: 'webstorm' },
  { id: 'sublime', label: 'Sublime Text', mac: 'Sublime Text', cli: 'subl' },
  { id: 'zed', label: 'Zed', mac: 'Zed', cli: 'zed' },
];

const isMac = process.platform === 'darwin';

function macAppPath(name) {
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    if (fs.existsSync(path.join(dir, `${name}.app`))) return name;
  }
  return null;
}

function hasCli(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
  return r.status === 0;
}

function resolve(ide) {
  if (isMac) {
    for (const n of [ide.mac, ...(ide.macAlt || [])]) {
      const app = macAppPath(n);
      if (app) return { kind: 'mac', app };
    }
  }
  if (hasCli(ide.cli)) return { kind: 'cli', bin: ide.cli };
  return null;
}

function available() {
  const list = IDES.filter((i) => resolve(i)).map((i) => ({ id: i.id, label: i.label }));
  list.push({ id: 'default', label: 'System default editor' });
  return list;
}

function open({ ide, name, content }) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  // keep the folder from growing forever: drop snapshots older than a day
  for (const f of fs.readdirSync(LOG_DIR)) {
    const p = path.join(LOG_DIR, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.rmSync(p, { force: true });
  }
  const safe = String(name || 'logs').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60);
  const file = path.join(LOG_DIR, `${safe}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  fs.writeFileSync(file, content, 'utf8');

  let cmd;
  let args;
  if (!ide || ide === 'default') {
    if (isMac) [cmd, args] = ['open', ['-t', file]]; // -t: default *text* editor
    else if (process.platform === 'win32') [cmd, args] = ['cmd', ['/c', 'start', '', file]];
    else [cmd, args] = ['xdg-open', [file]];
  } else {
    const def = IDES.find((i) => i.id === ide);
    const r = def && resolve(def);
    if (!r) throw new Error(`${def ? def.label : ide} is not installed on this machine`);
    if (r.kind === 'mac') [cmd, args] = ['open', ['-a', r.app, file]];
    else [cmd, args] = [r.bin, [file]];
  }
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
  return { ok: true, file };
}

module.exports = { available, open };
