'use strict';

// Start/stop control for the local AusweisApp2 eID simulator, exactly the container the suite
// itself starts for an eid-labelled run (see lib/eid_helper.py: start_ausweis_app / stop_ausweis_app).
// Scoped to this one container only - not a general "run a podman command" facility.
//
// On macOS/Windows, podman itself runs inside a small VM ("podman machine") that has to be
// booted before any `podman run` works - that boot is what start() does automatically below,
// so a dev never has to run `podman machine start` (or anything else) by hand.

const { execFile } = require('child_process');

const CONTAINER = 'ausweisapp2';
const IMAGE = 'governikus/ausweisapp2';
const PORT = 24727;
const TIMEOUT_MS = 20000;
const MACHINE_TIMEOUT_MS = 120000; // first boot of the VM can take a while

function podman(args, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('podman', args, { timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr || stdout || err.message || '').toString().trim() || `podman ${args[0]} failed`);
        e.notFound = err.code === 'ENOENT';
        return reject(e);
      }
      resolve(stdout.toString().trim());
    });
  });
}

const looksLikeMachineDown = (message) => /connect: connection refused|unable to connect to podman socket|cannot connect to podman/i.test(message || '');

// null = `podman machine` isn't a thing here (native/rootless podman, e.g. Linux) - nothing to boot.
async function listMachines() {
  try {
    const out = await podman(['machine', 'list', '--format', 'json']);
    return JSON.parse(out || '[]');
  } catch (_) {
    return null;
  }
}

// Boots the podman machine VM if one exists and isn't running (creating one as a last resort).
// Only called after we've actually seen a "can't reach the socket" error, never speculatively.
async function ensureMachineRunning() {
  const machines = await listMachines();
  if (!machines) return; // no `podman machine` support here - the connection error is something else
  const running = machines.find((m) => m.Running);
  if (running) return;
  const target = machines.find((m) => m.Default) || machines[0];
  if (target) {
    await podman(['machine', 'start', target.Name], MACHINE_TIMEOUT_MS);
    return;
  }
  await podman(['machine', 'init'], MACHINE_TIMEOUT_MS);
  await podman(['machine', 'start'], MACHINE_TIMEOUT_MS);
}

// 'running' | 'stopped' | 'unavailable' (no podman binary, or a connection problem start() can't fix)
async function status() {
  try {
    const out = await podman(['ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{.State}}']);
    if (!out) return { status: 'stopped' };
    return { status: out.toLowerCase().startsWith('running') ? 'running' : 'stopped' };
  } catch (e) {
    if (e.notFound) return { status: 'unavailable', error: 'podman is not installed (or not on PATH) where the dashboard runs' };
    if (looksLikeMachineDown(e.message)) return { status: 'stopped', machineDown: true, error: e.message };
    return { status: 'unavailable', error: e.message };
  }
}

async function start() {
  let cur = await status();
  if (cur.status === 'running') return { status: 'running' };
  if (cur.machineDown) {
    try {
      await ensureMachineRunning();
    } catch (e) {
      return { status: 'unavailable', error: `Couldn't start the podman machine: ${e.message}` };
    }
    cur = await status();
  }
  if (cur.status === 'unavailable') return cur;
  try {
    await podman(['run', '-d', '--rm', '--name', CONTAINER, '-p', `${PORT}:${PORT}`, IMAGE]);
    return { status: 'running' };
  } catch (e) {
    // lost a race with the suite's own fixture starting it at the same moment
    if (/already in use|already exists/i.test(e.message)) return { status: 'running' };
    return { status: 'unavailable', error: e.message };
  }
}

async function stop() {
  try {
    await podman(['stop', CONTAINER]);
    return { status: 'stopped' };
  } catch (e) {
    if (/no such container/i.test(e.message)) return { status: 'stopped' };
    if (e.notFound) return { status: 'unavailable', error: 'podman is not installed (or not on PATH) where the dashboard runs' };
    if (looksLikeMachineDown(e.message)) return { status: 'stopped' }; // nothing running to stop
    return { status: 'unavailable', error: e.message };
  }
}

module.exports = { status, start, stop, CONTAINER, PORT };
