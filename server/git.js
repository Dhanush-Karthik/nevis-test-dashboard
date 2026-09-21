'use strict';

// Thin wrapper around the git CLI for the integration-tests repo (the dashboard's parent
// directory). execFile only - no shell - and every ref/path argument is validated.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = process.env.DASHBOARD_GIT_ROOT || require('./paths').REPO_ROOT; // env override is for tests
const MAX_BUFFER = 32 * 1024 * 1024;

function run(args, { input, okCodes = [0], env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd: REPO_ROOT, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env } }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      if (err && !okCodes.includes(code)) {
        const e = new Error((stderr || stdout || err.message).toString().trim() || `git ${args[0]} failed`);
        e.code = code;
        return reject(e);
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

const REF_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
function assertRef(name) {
  if (!REF_RE.test(name || '') || name.endsWith('.lock')) throw new Error(`"${name}" is not a valid branch name`);
  return name;
}
function assertPaths(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('no files given');
  for (const p of paths) {
    const abs = path.resolve(REPO_ROOT, p);
    if (typeof p !== 'string' || p.startsWith('-') || p.includes('\0') || (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + path.sep))) throw new Error(`invalid path: ${p}`);
  }
  return paths;
}

const STATUS_LABEL = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', '?': 'untracked' };

async function status() {
  const { stdout } = await run(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
  const parts = stdout.split('\0');
  const head = parts.shift() || '';
  const m = head.match(/^## (?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
  let branch = m ? m[1] : '';
  const detached = branch.startsWith('HEAD (no branch)');
  const upstream = m && m[2] ? m[2] : null;
  const track = (m && m[3]) || '';
  const ahead = Number((track.match(/ahead (\d+)/) || [])[1] || 0);
  const behind = Number((track.match(/behind (\d+)/) || [])[1] || 0);
  const files = [];
  for (let i = 0; i < parts.length; i += 1) {
    const e = parts[i];
    if (!e) continue;
    const x = e[0];
    const y = e[1];
    const p = e.slice(3);
    let from = null;
    if (x === 'R' || x === 'C') from = parts[(i += 1)];
    const untracked = x === '?';
    files.push({
      path: p,
      from,
      x,
      y,
      staged: !untracked && x !== ' ',
      unstaged: untracked || y !== ' ',
      untracked,
      status: STATUS_LABEL[untracked ? '?' : x !== ' ' ? x : y] || 'changed',
    });
  }
  if (detached) branch = 'HEAD (detached)';
  return { branch, detached, upstream, ahead, behind, files, clean: files.length === 0 };
}

async function branches() {
  const { stdout } = await run(['for-each-ref', '--sort=-committerdate', '--format=%(refname)\t%(refname:short)\t%(upstream:short)\t%(committerdate:relative)\t%(objectname:short)\t%(HEAD)', 'refs/heads', 'refs/remotes']);
  const local = [];
  const remote = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [ref, short, upstream, when, sha, head] = line.split('\t');
    if (ref.startsWith('refs/remotes/')) {
      if (ref.endsWith('/HEAD')) continue;
      remote.push({ name: short, when, sha });
    } else {
      local.push({ name: short, upstream: upstream || null, when, sha, current: head === '*' });
    }
  }
  return { local, remote };
}

async function log(limit = 25) {
  const { stdout } = await run(['log', `-n${Math.min(100, Number(limit) || 25)}`, '--pretty=format:%h%x09%an%x09%ar%x09%s']);
  return stdout.split('\n').filter(Boolean).map((l) => {
    const [sha, author, when, ...subject] = l.split('\t');
    return { sha, author, when, subject: subject.join('\t') };
  });
}

async function checkout(name) {
  assertRef(name);
  const { local, remote } = await branches();
  if (local.some((b) => b.name === name)) await run(['checkout', name]);
  else if (remote.some((b) => b.name === `origin/${name}`)) await run(['checkout', '-b', name, '--track', `origin/${name}`]);
  else throw new Error(`branch "${name}" not found`);
  return status();
}

async function createBranch(name, from) {
  assertRef(name);
  const args = ['checkout', '-b', name];
  if (from) args.push(assertRef(from));
  await run(args);
  return status();
}

async function fetchRemote() {
  const r = await run(['fetch', '--prune', 'origin']);
  return (r.stderr + r.stdout).trim();
}

async function pull(strategy = 'ff-only') {
  const flag = { 'ff-only': '--ff-only', rebase: '--rebase', merge: '--no-rebase' }[strategy];
  if (!flag) throw new Error('unknown pull strategy');
  const r = await run(['pull', flag, '--no-edit']);
  return (r.stdout + r.stderr).trim();
}

// Unified diff of one file against HEAD, or (untracked) the whole file as additions.
async function diff(p, { untracked = false, staged = false } = {}) {
  assertPaths([p]);
  if (untracked) {
    const r = await run(['diff', '--no-color', '--no-index', '--', os.devNull, p], { okCodes: [0, 1] });
    return r.stdout;
  }
  // staged: what would be committed (index vs HEAD); otherwise the working copy against the index
  const r = await run(staged ? ['diff', '--no-color', '--cached', '--', p] : ['diff', '--no-color', '--', p]);
  return r.stdout;
}

// Diff between two texts, labelled with the file's repo path (used for the "save" preview).
async function diffTexts(oldText, newText, relPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nevis-diff-'));
  try {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    fs.writeFileSync(a, oldText);
    fs.writeFileSync(b, newText);
    const r = await run(['diff', '--no-color', '--no-index', '--', a, b], { okCodes: [0, 1] });
    return r.stdout
      .replace(/^diff --git .*$/m, `diff --git a/${relPath} b/${relPath}`)
      .replace(/^--- .*$/m, `--- a/${relPath}`)
      .replace(/^\+\+\+ .*$/m, `+++ b/${relPath}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function stage(paths) {
  await run(['add', '--', ...assertPaths(paths)]);
}
async function unstage(paths) {
  await run(['restore', '--staged', '--', ...assertPaths(paths)]);
}

// Commits what is staged, and nothing else: the developer chooses the files by staging them.
async function commit(message) {
  if (!message || !message.trim()) throw new Error('commit message is required');
  const staged = await run(['diff', '--cached', '--quiet'], { okCodes: [0, 1] });
  if (staged.code === 0) throw new Error('Nothing is staged. Stage the files you want to commit first.');
  const r = await run(['commit', '-F', '-'], { input: `${message.trim()}\n` });
  return r.stdout.trim();
}

// Pushes the current branch to origin (first push of a new branch sets its upstream). Never forces.
async function push() {
  const st = await status();
  if (st.detached) throw new Error('You are on a detached HEAD; switch to a branch before pushing.');
  const args = st.upstream ? ['push'] : ['push', '--set-upstream', 'origin', st.branch];
  const r = await run(args);
  return (r.stdout + r.stderr).trim() || 'Pushed';
}

async function isIgnored(p) {
  assertPaths([p]);
  const r = await run(['check-ignore', '-q', '--', p], { okCodes: [0, 1] });
  return r.code === 0;
}

module.exports = { status, branches, log, checkout, createBranch, fetchRemote, pull, push, diff, diffTexts, stage, unstage, commit, isIgnored, REPO_ROOT };
