'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tailPodLogs } = require('./oc');
const { ScenarioFlowTracker } = require('./flowTracker');

const MAX_LINES_PER_SOURCE = 20000;
const { REPO_ROOT, PYTEST_BIN } = require('./paths');

class RunManager {
  constructor(broadcast) {
    this.runs = new Map(); // runId -> run
    this.broadcast = broadcast; // (runId, message) => void
  }

  list() {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => this._summary(r));
  }

  // Trace ids the run has sent so far (from the plugin's marker lines) + its time window.
  traces(runId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      status: run.status,
      startedAt: run.createdAt,
      endedAt: run.endedAt || null,
      tracingSupported: fs.existsSync(path.join(REPO_ROOT, 'lib', 'tracing.py')),
      traces: run.flowTracker.tracesSnapshot(),
    };
  }

  get(runId) {
    const run = this.runs.get(runId);
    return run ? this._summary(run, true) : null;
  }

  _summary(run, withBacklog = false) {
    const sources = {};
    for (const [name, buf] of run.buffers.entries()) {
      sources[name] = withBacklog ? buf : { count: buf.length };
    }
    return {
      id: run.id,
      createdAt: run.createdAt,
      status: run.status,
      exitCode: run.exitCode,
      config: run.publicConfig,
      sources: withBacklog ? sources : Object.keys(sources),
      ...(withBacklog ? { flow: run.flowTracker.snapshot() } : {}),
    };
  }

  _appendLine(run, source, stream, text) {
    const seq = run.seqs.get(source) || 0;
    run.seqs.set(source, seq + 1);
    const entry = { ts: Date.now(), seq, source, stream, line: text };
    let buf = run.buffers.get(source);
    if (!buf) {
      buf = [];
      run.buffers.set(source, buf);
    }
    buf.push(entry);
    if (buf.length > MAX_LINES_PER_SOURCE) buf.shift();
    this.broadcast(run.id, { type: 'log', runId: run.id, entry });
  }

  _setStatus(run, status, exitCode) {
    run.status = status;
    if (!['starting', 'running'].includes(status)) run.endedAt = Date.now();
    if (exitCode !== undefined) run.exitCode = exitCode;
    this.broadcast(run.id, { type: 'status', runId: run.id, status, exitCode: run.exitCode });
  }

  start(config) {
    const id = crypto.randomUUID();
    const { env, namespace, labels, exclusionLabels, pods, ssh, onFinish } = config;

    const run = {
      id,
      createdAt: Date.now(),
      status: 'starting',
      exitCode: null,
      buffers: new Map(),
      seqs: new Map(),
      podTailers: [],
      pytestProc: null,
      flowTracker: new ScenarioFlowTracker(),
      publicConfig: {
        env,
        namespace,
        labels,
        exclusionLabels,
        pods, // [{ name, namespace }]
        ssh: ssh ? { host: ssh.host, user: ssh.user, keyPath: ssh.keyPath } : undefined, // never store/echo passphrase
      },
    };
    this.runs.set(id, run);

    // Kick off pod log tailers, one per selected pod in its own oc namespace/project.
    for (const pod of pods || []) {
      const source = `pod:${pod.namespace}/${pod.name}`;
      run.buffers.set(source, []);
      const tailer = tailPodLogs(
        { env, ssh },
        pod.namespace,
        pod.name,
        (line) => this._appendLine(run, source, 'log', line),
        (err) => this._appendLine(run, source, 'stderr', `[dashboard] failed to tail pod: ${err.message}`)
      );
      run.podTailers.push(tailer);
    }

    // Kick off pytest.
    const pytestSource = 'pytest';
    run.buffers.set(pytestSource, []);
    const args = ['--labels', ...labels, '--namespaces', namespace];
    if (exclusionLabels && exclusionLabels.length) {
      args.push('--exclusion-labels', ...exclusionLabels);
    }
    const pytestBin = PYTEST_BIN;
    const proc = spawn(pytestBin, args, { cwd: REPO_ROOT, env: process.env });
    run.pytestProc = proc;
    run.status = 'running';
    this.broadcast(id, { type: 'status', runId: id, status: 'running', exitCode: null });

    let buf = '';
    const handleLine = (line) => {
      const seq = run.seqs.get(pytestSource) || 0; // seq _appendLine is about to assign
      this._appendLine(run, pytestSource, 'log', line);
      if (run.flowTracker.ingest(line, seq)) {
        this.broadcast(id, { type: 'flow', runId: id, tests: run.flowTracker.snapshot() });
      }
    };
    const handle = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) handleLine(line);
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', handle);
    proc.on('error', (err) => {
      this._appendLine(run, pytestSource, 'stderr', `[dashboard] failed to start pytest: ${err.message}`);
      this._setStatus(run, 'error', -1);
      this._stopTailers(run);
      if (onFinish) onFinish();
    });
    proc.on('close', (code) => {
      if (buf) handleLine(buf);
      this._setStatus(run, code === 0 ? 'passed' : 'failed', code);
      if (onFinish) onFinish();
      // Give pod logs a moment to flush, mirroring run.sh's 10s grace period.
      setTimeout(() => this._stopTailers(run), 10000);
    });

    return this._summary(run, true);
  }

  _stopTailers(run) {
    for (const t of run.podTailers) t.stop();
  }

  stop(runId) {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (run.pytestProc) {
      try {
        run.pytestProc.kill('SIGTERM');
      } catch (_) {
        /* already dead */
      }
    }
    this._stopTailers(run);
    this._setStatus(run, 'stopped', run.exitCode);
    return true;
  }
}

module.exports = { RunManager };
