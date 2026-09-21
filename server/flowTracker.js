'use strict';

// Parses live pytest stdout for this test suite (integration_test.py / lib/scenario.py /
// lib/workflow.py / lib/endpoint_interaction.py) into a per-test sequence of
// workflow/endpoint-interaction steps, for the "Scenario Flow" visualization.
//
// There is no per-step pass/fail log line emitted by the suite itself - only a final
// PASSED/FAILED per test and a [SCENARIO-CONFIGURATION] dump on completion (see
// conftest.py's log_on_completion). So step status is a heuristic: a step is "running"
// until the next step starts (then it's "done"), and on FAILED the still-running step
// (or the last one, if none is running) is the one marked "failed".

const TEST_NODE_RE = /^(\S+\.py)::(.+)$/;
const SCENARIO_RE = /Running scenario:\s*(.+)$/;
const WORKFLOW_RE = /Running workflow:\s*(.+)$/;
const ENDPOINT_RE = /Running Endpoint Interaction:\s*(.+)$/i;
const ACTION_RE = /Handling action:\s*(.+)$/;
const OUTCOME_RE = /^(PASSED|FAILED|ERROR)$/;
const CONFIG_MARKER = '[SCENARIO-CONFIGURATION]';
const BRACE_RE = /\{([^{}]*)\}/g;
const KV_RE = /(\w+):\s*'([^']*)'/g;

function parseConfigItems(line) {
  const items = [];
  let m;
  BRACE_RE.lastIndex = 0;
  while ((m = BRACE_RE.exec(line))) {
    const kv = {};
    let km;
    KV_RE.lastIndex = 0;
    while ((km = KV_RE.exec(m[1]))) kv[km[1]] = km[2];
    if (Object.keys(kv).length) items.push(kv);
  }
  return items;
}

class ScenarioFlowTracker {
  constructor() {
    this.tests = [];
    this.currentTest = null;
    this.openAction = null;
  }

  // Trace ids come from the suite itself (branch SEK-200299-traceparent-headers): each workflow /
  // endpoint interaction runs as one W3C trace and conftest.py logs `trace_id: '<32 hex>'` per step in
  // the [SCENARIO-CONFIGURATION] line when the test ends (pass or fail). Older checkouts log a plain
  // uuid there, which is not a real trace id, so it is ignored.
  tracesSnapshot() {
    const out = [];
    for (const test of this.tests) {
      for (const step of test.steps) {
        const id = step.config && step.config.trace_id;
        if (!id || !/^[0-9a-f]{32}$/i.test(id)) continue;
        out.push({
          traceId: id.toLowerCase(),
          testId: test.id,
          scenarioName: test.scenarioName || test.nodeId,
          stepId: step.id,
          stepName: step.name,
          stepType: step.type,
          startedAt: step.startedAt,
        });
      }
    }
    return out;
  }

  // Trace ids found in the components' own logs (pod tails), which need no help from the suite:
  // each log line carries the W3C trace id of the request it handled, and the suite's requests
  // carry its traceparent. A trace is attributed to the step whose time window its first line
  // falls in, so failed flows are covered even when the suite never logged its own ids.
  // `logTraces`: Map(traceId -> {firstTs, lastTs, errors, warns, count, source, sample}).
  traceRefsFromLogs(logTraces, known = new Set()) {
    const GRACE = 6000;
    const now = Date.now();
    const out = [];
    for (const test of this.tests) {
      const testEnd = (test.endedAt || now) + GRACE;
      for (let i = 0; i < test.steps.length; i += 1) {
        const step = test.steps[i];
        const from = step.startedAt - 1500;
        const to = i < test.steps.length - 1 ? test.steps[i + 1].startedAt - 1500 : testEnd;
        for (const t of logTraces.values()) {
          if (known.has(t.traceId) || t.firstTs < from || t.firstTs >= to) continue;
          out.push({
            traceId: t.traceId,
            testId: test.id,
            scenarioName: test.scenarioName || test.nodeId,
            stepId: step.id,
            stepName: step.name,
            stepType: step.type,
            startedAt: t.firstTs,
            origin: 'logs',
            source: t.source,
            errors: t.errors,
            warns: t.warns,
            lines: t.count,
            sample: t.sample,
          });
        }
      }
    }
    return out;
  }

  _finishRunningStep(test, status) {
    const last = test.steps[test.steps.length - 1];
    if (last && last.status === 'running') {
      last.status = status;
      last.endedAt = Date.now();
    }
  }

  // Closes the currently open action's log range (an action owns every pytest
  // line from its "Handling action" line up to the next boundary).
  _closeAction(endSeq) {
    if (this.openAction && this.openAction.endSeq === null) this.openAction.endSeq = endSeq;
    this.openAction = null;
  }

  ingest(line, seq) {
    const testMatch = line.match(TEST_NODE_RE);
    if (testMatch) {
      this._closeAction(seq - 1);
      this.currentTest = {
        id: `t${this.tests.length}`,
        file: testMatch[1],
        nodeId: testMatch[2],
        scenarioName: null,
        description: null,
        steps: [],
        outcome: null,
        startedAt: Date.now(),
      };
      this.tests.push(this.currentTest);
      return true;
    }

    if (!this.currentTest) return false;

    // Once a test has its verdict its steps are final. pytest then replays the captured log in the
    // failure report, which repeats every "Running workflow/..." line - those must not become new steps.
    if (this.currentTest.outcome && (SCENARIO_RE.test(line) || WORKFLOW_RE.test(line) || ENDPOINT_RE.test(line) || ACTION_RE.test(line))) return false;

    const scenarioMatch = line.match(SCENARIO_RE);
    if (scenarioMatch) {
      this._closeAction(seq - 1);
      const rest = scenarioMatch[1].trim();
      const sep = rest.indexOf(' - ');
      this.currentTest.scenarioName = sep >= 0 ? rest.slice(0, sep).trim() : rest;
      this.currentTest.description = sep >= 0 ? rest.slice(sep + 3).trim() : '';
      return true;
    }

    const workflowMatch = line.match(WORKFLOW_RE);
    const endpointMatch = line.match(ENDPOINT_RE);
    if (workflowMatch || endpointMatch) {
      this._closeAction(seq - 1);
      this._finishRunningStep(this.currentTest, 'done');
      this.currentTest.steps.push({
        id: `${this.currentTest.id}-s${this.currentTest.steps.length}`,
        type: workflowMatch ? 'workflow' : 'endpoint',
        name: (workflowMatch ? workflowMatch[1] : endpointMatch[1]).trim(),
        status: 'running',
        actions: [],
        config: null,
        startedAt: Date.now(),
      });
      return true;
    }

    const actionMatch = line.match(ACTION_RE);
    if (actionMatch && this.currentTest.steps.length) {
      this._closeAction(seq - 1);
      const action = { name: actionMatch[1].trim(), ts: Date.now(), startSeq: seq, endSeq: null };
      this.currentTest.steps[this.currentTest.steps.length - 1].actions.push(action);
      this.openAction = action;
      return true;
    }

    const outcomeMatch = line.trim().match(OUTCOME_RE);
    if (outcomeMatch) {
      const outcome = outcomeMatch[1].toLowerCase();
      this._closeAction(seq - 1);
      this.currentTest.outcome = outcome;
      this.currentTest.endedAt = Date.now();
      this._finishRunningStep(this.currentTest, outcome === 'passed' ? 'done' : 'failed');
      return true;
    }

    if (line.includes(CONFIG_MARKER)) {
      for (const kv of parseConfigItems(line)) {
        const step = this.currentTest.steps.find((s) => s.name === kv.name && !s.config);
        if (step) step.config = kv;
      }
      return true;
    }

    return false;
  }

  snapshot() {
    return this.tests;
  }
}

module.exports = { ScenarioFlowTracker };
