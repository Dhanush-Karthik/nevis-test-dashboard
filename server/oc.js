'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Escape a value for safe embedding inside a single-quoted remote shell string. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run `ssh-add` for a passphrase-protected key via a throwaway SSH_ASKPASS
 * script, mirroring run.sh, so the passphrase never appears in `ps` output.
 * Returns the spawned ssh-agent's env vars and a cleanup() to kill it.
 */
function startSshAgent(keyPath, passphrase) {
  return new Promise((resolve, reject) => {
    const agent = spawn('ssh-agent', ['-s']);
    let out = '';
    agent.stdout.on('data', (d) => (out += d.toString()));
    agent.on('error', reject);
    agent.on('close', () => {
      const authSockMatch = out.match(/SSH_AUTH_SOCK=([^;]+);/);
      const agentPidMatch = out.match(/SSH_AGENT_PID=(\d+);/);
      if (!authSockMatch || !agentPidMatch) {
        reject(new Error('Failed to start ssh-agent'));
        return;
      }
      const env = {
        ...process.env,
        SSH_AUTH_SOCK: authSockMatch[1],
        SSH_AGENT_PID: agentPidMatch[1],
      };
      const cleanup = () => {
        try {
          process.kill(Number(agentPidMatch[1]));
        } catch (_) {
          /* already gone */
        }
      };

      const addArgs = ['ssh-add', keyPath];
      let addEnv = env;
      let askpassScript = null;

      const finishAdd = (code) => {
        if (askpassScript) fs.rm(askpassScript, () => {});
        if (code !== 0) {
          cleanup();
          reject(new Error('ssh-add failed (bad passphrase or key path?)'));
          return;
        }
        resolve({ env, cleanup });
      };

      if (passphrase) {
        askpassScript = path.join(os.tmpdir(), `askpass-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
        fs.writeFileSync(askpassScript, `#!/bin/sh\nprintf '%s' "$SSH_KEY_PASSPHRASE"\n`, { mode: 0o700 });
        addEnv = { ...env, SSH_ASKPASS: askpassScript, SSH_ASKPASS_REQUIRE: 'force', SSH_KEY_PASSPHRASE: passphrase, DISPLAY: env.DISPLAY || ':0' };
      }

      const adder = spawn(addArgs[0], addArgs.slice(1), { env: addEnv, stdio: ['ignore', 'ignore', 'ignore'] });
      adder.on('error', (err) => {
        if (askpassScript) fs.rm(askpassScript, () => {});
        cleanup();
        reject(err);
      });
      adder.on('close', finishAdd);
    });
  });
}

/**
 * Build the argv (and optional env) needed to run an `oc` command, either
 * directly (env: 'dev') or over ssh to the devtest bastion (env: 'devtest'),
 * matching run.sh's two code paths.
 */
async function ocExecTarget(cfg) {
  if (cfg.env !== 'devtest') {
    return { command: 'oc', prefixArgs: [], env: process.env, cleanup: () => {} };
  }
  const { host, user, keyPath, passphrase } = cfg.ssh || {};
  if (!host || !user || !keyPath) {
    throw new Error('devtest requires ssh host, user, and keyPath');
  }
  let sshEnv = process.env;
  let cleanup = () => {};
  if (passphrase) {
    const agent = await startSshAgent(keyPath, passphrase);
    sshEnv = agent.env;
    cleanup = agent.cleanup;
  }
  return {
    command: 'ssh',
    prefixArgs: ['-i', keyPath, `${user}@${host}`],
    env: sshEnv,
    cleanup,
    isRemote: true,
  };
}

/** Run a short-lived oc command (direct or over ssh) and return trimmed stdout. */
async function runOcCommand(cfg, ocArgs) {
  const target = await ocExecTarget(cfg);
  try {
    const argv = target.isRemote
      ? [...target.prefixArgs, `oc ${ocArgs.map(shQuote).join(' ')}`]
      : ocArgs;
    return await new Promise((resolve, reject) => {
      const proc = spawn(target.command, argv, { env: target.env });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `command exited ${code}`));
          return;
        }
        resolve(stdout.trim());
      });
    });
  } finally {
    target.cleanup();
  }
}

async function listProjects(cfg) {
  const out = await runOcCommand(cfg, ['get', 'projects', '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}']);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** Run `oc get <kind> -o json` and parse it; returns `{ items: [] }` for empty output. */
async function runOcJson(cfg, ocArgs) {
  const out = await runOcCommand(cfg, ocArgs);
  return out ? JSON.parse(out) : { items: [] };
}

/** Secret names a pod spec actually references, via envFrom/env/volumes - used to draw
 * a real "this deployment depends on this secret" edge in the resource tree. */
function extractSecretRefs(podSpec) {
  const names = new Set();
  for (const c of [...(podSpec.containers || []), ...(podSpec.initContainers || [])]) {
    for (const ef of c.envFrom || []) if (ef.secretRef?.name) names.add(ef.secretRef.name);
    for (const e of c.env || []) if (e.valueFrom?.secretKeyRef?.name) names.add(e.valueFrom.secretKeyRef.name);
  }
  for (const v of podSpec.volumes || []) if (v.secret?.secretName) names.add(v.secret.secretName);
  return [...names];
}

async function listDeployments(cfg, namespace) {
  const data = await runOcJson(cfg, ['get', 'deployments', '-n', namespace, '-o', 'json']);
  return (data.items || []).map((item) => {
    const podSpec = item.spec.template?.spec || {};
    return {
      name: item.metadata.name,
      namespace,
      replicas: {
        desired: item.spec.replicas ?? 0,
        ready: item.status.readyReplicas ?? 0,
        updated: item.status.updatedReplicas ?? 0,
        available: item.status.availableReplicas ?? 0,
      },
      images: (podSpec.containers || []).map((c) => c.image),
      createdAt: item.metadata.creationTimestamp,
      conditions: (item.status.conditions || []).map((c) => ({ type: c.type, status: c.status, reason: c.reason })),
      // Used client-side to draw the resource tree: which pods/services belong to
      // this deployment (label-selector match), and which secrets it depends on.
      selectorLabels: item.spec.selector?.matchLabels || {},
      secretRefs: extractSecretRefs(podSpec),
    };
  });
}

async function listServices(cfg, namespace) {
  const data = await runOcJson(cfg, ['get', 'services', '-n', namespace, '-o', 'json']);
  return (data.items || []).map((item) => ({
    name: item.metadata.name,
    namespace,
    type: item.spec.type,
    clusterIP: item.spec.clusterIP,
    ports: (item.spec.ports || []).map((p) => ({ port: p.port, targetPort: p.targetPort, protocol: p.protocol, name: p.name })),
    selector: item.spec.selector || {},
    createdAt: item.metadata.creationTimestamp,
  }));
}

// Metadata only, per this workspace's PKI/OpenShift safety rules: key NAMES are
// fine to surface (so a dev can see what a secret is supposed to contain), but
// `.data`/`.stringData` VALUES must never be printed, logged, or sent to the
// client. The full object is fetched (oc gives no "metadata-only" secret view),
// but only `Object.keys(...)` of the data ever leaves this function - the actual
// values are discarded here and never referenced again.
async function listSecretsMeta(cfg, namespace) {
  const data = await runOcJson(cfg, ['get', 'secrets', '-n', namespace, '-o', 'json']);
  return (data.items || []).map((item) => ({
    name: item.metadata.name,
    namespace,
    type: item.type,
    keys: Object.keys(item.data || item.stringData || {}),
    createdAt: item.metadata.creationTimestamp,
  }));
}

function formatAge(iso) {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return '0m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Approximates the "STATUS" column `oc get pods` computes - phase alone (e.g.
 * always "Running") hides a stuck/crashing container, which is the whole point
 * of glancing at this column. */
function computePodStatus(item) {
  for (const c of item.status.containerStatuses || []) {
    if (c.state?.waiting?.reason) return c.state.waiting.reason;
    if (c.state?.terminated?.reason && c.state.terminated.reason !== 'Completed') return c.state.terminated.reason;
  }
  if (item.status.phase === 'Succeeded') return 'Completed';
  return item.status.phase || 'Unknown';
}

async function listPods(cfg, project) {
  const data = await runOcJson(cfg, ['get', 'pods', '-n', project, '-o', 'json']);
  return (data.items || []).map((item) => {
    const statuses = item.status.containerStatuses || [];
    const total = statuses.length || (item.spec.containers || []).length;
    const readyCount = statuses.filter((c) => c.ready).length;
    const restarts = statuses.reduce((sum, c) => sum + (c.restartCount || 0), 0);
    return {
      name: item.metadata.name,
      labels: item.metadata.labels || {},
      ready: `${readyCount}/${total}`,
      status: computePodStatus(item),
      restarts: String(restarts),
      age: formatAge(item.metadata.creationTimestamp),
    };
  });
}

/**
 * Start `oc logs -f <pod>` (direct or via ssh), invoking onLine(text) for
 * every line of stdout/stderr. Returns { proc, stop, ready } where `ready`
 * resolves once the ssh-agent/ssh-add setup (if any) has completed.
 */
function tailPodLogs(cfg, project, podName, onLine, onError) {
  let stopped = false;
  let proc = null;
  let cleanupTarget = () => {};

  const ready = (async () => {
    const target = await ocExecTarget(cfg);
    cleanupTarget = target.cleanup;
    if (stopped) {
      target.cleanup();
      return;
    }
    const ocArgs = ['logs', '-f', podName, '-n', project, '--since=1s'];
    const argv = target.isRemote ? [...target.prefixArgs, `oc ${ocArgs.map(shQuote).join(' ')}`] : ocArgs;
    proc = spawn(target.command, argv, { env: target.env });

    let buf = '';
    const handle = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) onLine(line);
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', handle);
    proc.on('error', (err) => onError && onError(err));
    proc.on('close', () => {
      if (buf) onLine(buf);
    });
  })();

  return {
    ready,
    stop: () => {
      stopped = true;
      if (proc) {
        try {
          proc.kill('SIGTERM');
        } catch (_) {
          /* already dead */
        }
      }
      cleanupTarget();
    },
  };
}

module.exports = { listProjects, listPods, tailPodLogs, ocExecTarget, listDeployments, listServices, listSecretsMeta };
