#!/usr/bin/env node
'use strict';

// Stand-in for the test project's pytest, used only by the demo recording. It understands the same
// flags the dashboard passes (--labels, --namespaces, --exclusion-labels, --dry-run) and prints log
// lines in the same shape as the real suite, without sending a single request anywhere.
const fs = require('fs');
const path = require('path');
const YAML = require('../node_modules/yaml');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j += 1) out.push(argv[j]);
  return out;
};
const labels = flag('--labels');
const namespaces = flag('--namespaces');
const exclusion = flag('--exclusion-labels');
const dry = argv.includes('--dry-run');
const speed = Number(process.env.DEMO_PYTEST_DELAY_MS || 650);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ACTIONS = { 'register-user': ['ask-consent', 'ask-identification', 'ask-pin'], 'register-device': ['ask-device-information'], login: ['ask-pin'], 'login-wrong-pin': ['ask-pin'] };
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 23);

function collect() {
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.yaml') && !e.name.includes('defaults')) {
        const doc = YAML.parse(fs.readFileSync(p, 'utf8')) || {};
        const defs = new Map([...(doc.workflows || []), ...(doc.endpoint_interactions || [])].map((d) => [d.name, d]));
        for (const s of doc.scenarios || []) found.push({ ...s, defs, workflows: new Set((doc.workflows || []).map((w) => w.name)) });
      }
    }
  };
  walk(path.join(process.cwd(), 'config'));
  return found.filter(
    (s) =>
      (!labels.length || (s.labels || []).some((l) => labels.includes(l))) &&
      !(s.labels || []).some((l) => exclusion.includes(l)) &&
      (!namespaces.length || (s.supported_namespaces || []).some((n) => namespaces.includes(n)))
  );
}

async function main() {
  const picked = collect();
  if (dry) {
    console.log(`Total number of scenarios: ${picked.length}`);
    picked.forEach((s) => {
      console.log(`Scenario Name: ${s.name}`);
      console.log(`Sequence: ${(s.sequence || []).join(', ')}`);
    });
    return 0;
  }
  console.log('============================= test session starts ==============================');
  console.log(`collected ${picked.length} items\n`);
  let failed = 0;
  for (const s of picked) {
    const node = `integration_test.py::test_scenario[ name: ${s.name}, labels: [${(s.labels || []).join(', ')}] ]`;
    console.log(node);
    const log = [];
    const emit = (line) => { log.push(line); console.log(line); };
    emit(`${stamp()} INFO     lib.scenario:scenario.py:52 Running scenario: ${s.name} - ${s.description || ''}`);
    let broke = false;
    for (const step of s.sequence || []) {
      if (broke) break;
      const isWf = s.workflows.has(step);
      await sleep(speed / 2);
      emit(`${stamp()} INFO     lib.scenario:scenario.py:88 ${isWf ? 'Running workflow' : 'Running Endpoint Interaction'}: ${step}`);
      for (const action of isWf ? ACTIONS[step] || [] : []) {
        await sleep(speed);
        emit(`${stamp()} INFO     lib.workflow_client:workflow_client.py:193 Handling action: ${action}`);
        if (step === 'login-wrong-pin') {
          await sleep(speed);
          emit(`${stamp()} WARNING  lib.workflow_client:workflow_client.py:90 Found error_description in response: Invalid PIN. Terminating flow`);
          broke = true;
        }
      }
    }
    await sleep(speed / 2);
    emit(`${stamp()} INFO     conftest:conftest.py:210 [SCENARIO-CONFIGURATION] [${(s.sequence || []).map((n) => `{name: '${n}', type: '${s.workflows.has(n) ? 'workflow' : 'endpoint'}'}`).join(', ')}]`);
    if (broke) {
      failed += 1;
      console.log('FAILED');
      console.log('\n=================================== FAILURES ===================================');
      console.log(`_______ test_scenario[ name: ${s.name} ] _______`);
      console.log('------------------------------ Captured log call -------------------------------');
      log.forEach((l) => console.log(l));
      console.log('E   AssertionError: flow ended with error "Invalid PIN"');
    } else {
      console.log('PASSED');
    }
    console.log('');
  }
  console.log(`========================= ${failed} failed, ${picked.length - failed} passed in ${(picked.length * 3.2).toFixed(2)}s =========================`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code));
