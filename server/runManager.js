'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tailPodLogs } = require('./oc');
const { ScenarioFlowTracker } = require('./flowTracker');

const MAX_LINES_PER_SOURCE = 20000;
const { REPO_ROOT, PYTEST_BIN } = require('./paths');

// Trace ids as the components print them: `<timestamp> <32-hex trace> <16-hex span> ...` (also inside
// printed traceparent headers). Level words mark lines worth a closer look on a failed flow.
const LOG_TRACE_RE = /(?:^|[\s\[])([0-9a-f]{32})\s+([0-9a-f]{16})(?=\s)|traceparent\W{1,6}00-([0-9a-f]{32})-([0-9a-f]{16})/i;
const ERROR_RE = /\b(ERROR|SEVERE|FATAL|Exception)\b/;
const WARN_RE = /\bWARN(?:ING)?\b/;
const MAX_LOG_TRACES = 6000;
const MAX_RUNS = 30; // finished runs kept in memory (until the server restarts)
const MAX_LOG_TRACES_PER_STEP = 8;

class RunManager {
  constructor(broadcast) {
    this.runs = new Map(); // runId -> run
    this.broadcast = broadcast; // (runId, message) => void
  }

  list() {
    // A scenario re-run (kind: 'scenario-rerun') targets one scenario out of an already-listed
    // run and is meant to replace its result in place there - not to show up as its own entry.
    return [...this.runs.values()]
      .filter((r) => r.kind !== 'scenario-rerun')
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
      traces: this._mergedTraces(run),
    };
  }

  // Ids the suite reported, plus ids harvested from component logs for the same steps. Within a step,
  // traces with errors come first, so a failed step's "View trace" opens the failing request.
  _mergedTraces(run) {
    const reported = run.flowTracker.tracesSnapshot();
    const known = new Set(reported.map((t) => t.traceId));
    const fromLogs = run.flowTracker.traceRefsFromLogs(run.logTraces, known);
    const failedSteps = new Set();
    for (const test of run.flowTracker.snapshot()) for (const s of test.steps) if (s.status === 'failed') failedSteps.add(s.id);
    // suite traces first (reported ids, and log traces whose inbound request carried a traceparent), then anything else seen in the logs
    const rank = (t) => (t.relation === 'other' ? 3 : t.errors ? 0 : t.origin === 'logs' ? 2 : 1);
    const groups = new Map();
    for (const t of [...reported, ...fromLogs]) {
      const g = groups.get(t.stepId) || groups.set(t.stepId, []).get(t.stepId);
      g.push(t.origin === 'logs' ? { ...t, onFailedStep: failedSteps.has(t.stepId), relation: t.inbound ? 'suite' : 'other' } : { ...t, relation: 'suite' });
    }
    const out = [];
    for (const g of groups.values()) {
      g.sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt);
      let fromLogsSeen = 0;
      for (const t of g) if (t.origin !== 'logs' || (fromLogsSeen += 1) <= MAX_LOG_TRACES_PER_STEP) out.push(t);
    }
    return out;
  }

  // Span ids seen next to trace ids in a run's component logs.
  spanRefs(runId) {
    const run = this.runs.get(runId);
    if (!run) return [];
    const out = [];
    for (const t of run.logTraces.values()) for (const spanId of t.spans) out.push({ traceId: t.traceId, spanId, source: t.source });
    return out;
  }

  // Removes a finished run. null = unknown id, false = still running.
  remove(runId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (['starting', 'running'].includes(run.status)) return false;
    this.runs.delete(runId);
    return true;
  }

  clearFinished() {
    let n = 0;
    for (const [id, run] of this.runs) {
      if (!['starting', 'running'].includes(run.status)) {
        this.runs.delete(id);
        n += 1;
      }
    }
    return n;
  }

  _evictOld() {
    const finished = [...this.runs.values()].filter((r) => !['starting', 'running'].includes(r.status)).sort((a, b) => a.createdAt - b.createdAt);
    while (finished.length > MAX_RUNS) this.runs.delete(finished.shift().id);
  }

  get(runId) {
    const run = this.runs.get(runId);
    return run ? this._summary(run, true) : null;
  }

  // Points `scenarioName` in `runId`'s flow at another run's result (a scenario re-run) -
  // persisted on the run itself (not just held in a browser tab), so it survives a page refresh
  // and shows the same way in every view (Run tests, History, a popped-out window). Broadcasts
  // the merged flow right away so anyone currently watching `runId` updates immediately too.
  setOverride(runId, scenarioName, rerunRunId) {
    const run = this.runs.get(runId);
    if (!run) return;
    run.overrides.set(scenarioName, rerunRunId);
    this._broadcastFlow(run);
  }

  _broadcastFlow(run) {
    this.broadcast(run.id, { type: 'flow', runId: run.id, tests: this._mergedFlow(run) });
  }

  // `run.flowTracker.snapshot()`, with any scenario re-runs swapped in for the scenario they
  // replace - same test id/position, so client-side selection stays stable, tagged `_rerun` and
  // carrying `_ownLogs` (that re-run's OWN pytest lines - seq numbers are zero-based per run, so
  // this must never be read against the original run's buffer). A re-run that's registered but
  // hasn't produced a parsed test yet (just started) shows as cleared/running rather than
  // falling back to the stale original result.
  _mergedFlow(run) {
    const base = run.flowTracker.snapshot();
    if (!run.overrides.size) return base;
    return base.map((t) => {
      const rerunId = t.scenarioName && run.overrides.get(t.scenarioName);
      const rr = rerunId && this.runs.get(rerunId);
      if (!rr) return t;
      const rt = rr.flowTracker.snapshot()[0];
      if (!rt) return { ...t, _rerun: true, outcome: null, steps: [], startedAt: rr.createdAt, endedAt: null };
      return { ...rt, id: t.id, _rerun: true, _ownLogs: rr.buffers.get('pytest') || [] };
    });
  }

  _summary(run, withBacklog = false) {
    const sources = {};
    for (const [name, buf] of run.buffers.entries()) {
      sources[name] = withBacklog ? buf : { count: buf.length };
    }
    const tests = this._mergedFlow(run);
    const count = (o) => tests.filter((t) => t.outcome === o).length;
    return {
      id: run.id,
      createdAt: run.createdAt,
      endedAt: run.endedAt || null,
      kind: run.kind,
      title: run.title || null,
      counts: { total: tests.length, passed: count('passed'), failed: count('failed') + count('error'), running: tests.filter((t) => t.outcome === null).length },
      scenarios: tests.map((t) => t.scenarioName || t.nodeId).slice(0, 8),
      status: run.status,
      exitCode: run.exitCode,
      config: run.publicConfig,
      sources: withBacklog ? sources : Object.keys(sources),
      ...(withBacklog ? { flow: tests } : {}),
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
    if (stream === 'log') this._noteLogTrace(run, source, entry);
    this.broadcast(run.id, { type: 'log', runId: run.id, entry });
    // This run is standing in for a scenario in another (the original) run: every pytest line it
    // gets - not just ones that change the parsed step structure - re-broadcasts that original
    // run's merged flow, since `_ownLogs` (embedded in the merged test) needs to grow live too,
    // e.g. the failure-report trailer that streams in after the PASSED/FAILED line.
    if (run.replaces && source === 'pytest') {
      const original = this.runs.get(run.replaces.runId);
      if (original) this._broadcastFlow(original);
    }
  }

  _noteLogTrace(run, source, entry) {
    const m = entry.line.match(LOG_TRACE_RE);
    const id = m && (m[1] || m[3]);
    const spanId = m && (m[2] || m[4]);
    if (!id) return;
    const traceId = id.toLowerCase();
    if (/^0+$/.test(traceId)) return;
    let t = run.logTraces.get(traceId);
    if (!t) {
      if (run.logTraces.size >= MAX_LOG_TRACES) return;
      t = { traceId, firstTs: entry.ts, lastTs: entry.ts, errors: 0, warns: 0, count: 0, source, sample: '', spans: new Set() };
      run.logTraces.set(traceId, t);
    }
    if (m[3]) t.inbound = true; // an inbound request carried a traceparent header: the caller (the suite) started this trace
    t.lastTs = entry.ts;
    t.count += 1;
    if (spanId && t.spans.size < 60) t.spans.add(spanId.toLowerCase());
    const bad = ERROR_RE.test(entry.line);
    if (bad) t.errors += 1;
    else if (WARN_RE.test(entry.line)) t.warns += 1;
    if (bad && !t.sampleIsError) {
      t.sample = entry.line.slice(0, 300);
      t.sampleIsError = true;
    } else if (!t.sample) t.sample = entry.line.slice(0, 300);
  }

  _setStatus(run, status, exitCode) {
    run.status = status;
    if (!['starting', 'running'].includes(status)) run.endedAt = Date.now();
    if (exitCode !== undefined) run.exitCode = exitCode;
    this.broadcast(run.id, { type: 'status', runId: run.id, status, exitCode: run.exitCode });
  }

  start(config) {
    const id = crypto.randomUUID();
    const { env, namespace, labels, exclusionLabels, pods, ssh, onFinish, kind, title, keyword, replaces } = config;

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
      logTraces: new Map(),
      kind: kind || 'tests',
      title: title || null,
      overrides: new Map(), // scenarioName -> rerunRunId: another run's result stands in for this scenario here
      replaces: replaces || null, // { runId, scenarioName }: this run IS such a stand-in, for that other run
      publicConfig: {
        env,
        namespace,
        labels,
        exclusionLabels,
        pods, // [{ name, namespace }]
        ssh: ssh ? { host: ssh.host, user: ssh.user, keyPath: ssh.keyPath } : undefined, // never store/echo passphrase
        keyword: keyword || undefined, // set when this run re-targets a single scenario (see -k below)
      },
    };
    this._evictOld();
    this.runs.set(id, run);

    // Register the override right away, before pytest has even started, so every view of the
    // original run (Run tests, History, a page refresh) shows this scenario cleared and "running"
    // immediately - not the previous (possibly failed) result sitting stale until this run's first
    // line comes back. Persisted here server-side (not just in the browser) so it survives a
    // refresh and shows up the same way in History, per the run it replaces.
    if (replaces && replaces.runId && replaces.scenarioName) {
      this.setOverride(replaces.runId, replaces.scenarioName, id);
    }

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
    // Re-running a single scenario out of a labelled run: pytest's own -k keyword filter, matched
    // against the parametrized test id (which embeds "name: <scenario name>"), so it works even for
    // scenarios that have no unique uuid label of their own.
    if (keyword) args.push('-k', keyword);
    const pytestBin = PYTEST_BIN;
    const proc = spawn(pytestBin, args, { cwd: REPO_ROOT, env: process.env });
    run.pytestProc = proc;
    run.status = 'running';
    this.broadcast(id, { type: 'status', runId: id, status: 'running', exitCode: null });

    let buf = '';
    const handleLine = (line) => {
      const seq = run.seqs.get(pytestSource) || 0; // seq _appendLine is about to assign
      // Ingest before appending: _appendLine (below) also re-broadcasts this run's own flow to
      // whatever original run it replaces (see `run.replaces`), and that must see this line's
      // effect on the flow tracker's state - not lag it by one line - or a re-run whose last
      // pytest line IS the outcome (the common, no-failure-report case) would broadcast one
      // update behind and never show as finished until something else happened to trigger another.
      const changed = run.flowTracker.ingest(line, seq);
      this._appendLine(run, pytestSource, 'log', line);
      if (changed) this.broadcast(id, { type: 'flow', runId: id, tests: run.flowTracker.snapshot() });
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
