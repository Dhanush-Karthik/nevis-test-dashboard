'use strict';

// Manages read-only `oc port-forward` tunnels (Tempo API, Grafana UI) on fixed local
// ports. If something already answers on the local port (e.g. the developer's own
// manual port-forward) it is reused instead of starting a second tunnel.

const net = require('net');
const { spawn } = require('child_process');

const tunnels = new Map(); // key -> { proc, port, starting }

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(800, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

function start({ key, namespace, target, remotePort, localPort }) {
  return new Promise((resolve, reject) => {
    const proc = spawn('oc', ['port-forward', '-n', namespace, target, `${localPort}:${remotePort}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`port-forward to ${target} timed out: ${out.trim() || 'no output'}`));
    }, 10000);
    const onData = (d) => {
      out += d.toString();
      if (out.includes('Forwarding from')) {
        clearTimeout(timer);
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(err.code === 'ENOENT' ? '`oc` is not installed or not on PATH' : err.message));
    });
    proc.on('close', () => {
      clearTimeout(timer);
      if (tunnels.get(key)?.proc === proc) tunnels.delete(key);
      reject(new Error(out.trim() || `port-forward to ${target} exited`));
    });
  });
}

/** Ensures a tunnel for `key` is up; resolves to the local port. */
async function ensure(spec) {
  const existing = tunnels.get(spec.key);
  if (existing && existing.proc && existing.proc.exitCode === null && (await portOpen(spec.localPort))) return spec.localPort;
  if (await portOpen(spec.localPort)) return spec.localPort; // someone else's tunnel: reuse
  if (existing?.starting) return existing.starting;
  const starting = start(spec).then((proc) => {
    tunnels.set(spec.key, { proc, port: spec.localPort });
    return spec.localPort;
  });
  tunnels.set(spec.key, { starting, port: spec.localPort });
  try {
    return await starting;
  } catch (err) {
    tunnels.delete(spec.key);
    throw err;
  }
}

/** Drops our tunnel for `key` (a dead `oc port-forward` keeps its local port open but stops relaying). */
function restart(key) {
  const t = tunnels.get(key);
  if (t?.proc) t.proc.kill('SIGTERM');
  tunnels.delete(key);
}

function stopAll() {
  for (const t of tunnels.values()) if (t.proc) t.proc.kill('SIGTERM');
  tunnels.clear();
}
process.on('exit', stopAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopAll(); process.exit(0); });

module.exports = { ensure, restart, stopAll, portOpen };
