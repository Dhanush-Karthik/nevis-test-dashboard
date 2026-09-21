'use strict';

// Session handling for the `oc` CLI. A cluster login expires after ~24h; instead of dropping to a
// terminal, the dashboard can log in again with the one-time passcode from the identity provider
// (IBM Cloud: https://iam.cloud.ibm.com/identity/passcode).
//
// The passcode is only ever passed to `oc login` for this one call. It is never stored, logged or echoed back
// (error output is scrubbed of it). It is single-use and short-lived, so its brief appearance in the process
// list while `oc` runs is not a lasting credential.
const { execFile } = require('child_process');

const AUTH_RE = /must be logged in|Unauthorized|token .*(expired|invalid)|provide credentials|the server has asked for the client|logged in to the server|Login failed/i;
const isAuthError = (message) => AUTH_RE.test(String(message || ''));

const SERVER_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{2,5})?$/;
const CODE_RE = /^[A-Za-z0-9_-]{4,128}$/;

function oc(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('oc', args, { timeout: timeoutMs, env: process.env, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, missing: err && err.code === 'ENOENT', stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

// { ocInstalled, loggedIn, user, server }: `server` comes from the kube config, so it is known even when the token expired.
async function session() {
  const who = await oc(['whoami'], 10000);
  if (who.missing) return { ocInstalled: false, loggedIn: false, user: null, server: null };
  const srv = await oc(['whoami', '--show-server'], 10000);
  const server = srv.code === 0 ? srv.stdout.replace(/^https?:\/\//, '') : process.env.OC_LOGIN_SERVER || null;
  return {
    ocInstalled: true,
    loggedIn: who.code === 0,
    user: who.code === 0 ? who.stdout : null,
    server,
    detail: who.code === 0 ? '' : who.stderr.split('\n')[0].slice(0, 200),
  };
}

let busy = false;

async function login({ server, code } = {}) {
  const host = String(server || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const pass = String(code || '').trim();
  if (!SERVER_RE.test(host)) throw new Error('Enter the cluster address as host:port (for example my-cluster.example.com:32087).');
  if (!CODE_RE.test(pass)) throw new Error('Enter the one-time passcode exactly as shown (letters and digits only).');
  if (busy) throw new Error('A login is already in progress.');
  busy = true;
  try {
    const r = await oc(['login', `--server=https://${host}`, '-u', 'passcode', '-p', pass, '--request-timeout=30s'], 60000);
    if (r.missing) throw new Error('The `oc` command was not found on this machine.');
    if (r.code !== 0) {
      const text = (r.stderr || r.stdout || 'oc login failed').split(pass).join('***');
      if (/invalid|incorrect|unauthorized|expired|login failed|credentials/i.test(text)) throw new Error('Login failed: the passcode was rejected. It may have expired or already been used, so request a new one.');
      throw new Error(text.split('\n').slice(0, 3).join(' '));
    }
    const s = await session();
    if (!s.loggedIn) throw new Error('oc reported success but the session is not active.');
    return { ok: true, user: s.user, server: s.server };
  } finally {
    busy = false;
  }
}

module.exports = { session, login, isAuthError };
