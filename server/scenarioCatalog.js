'use strict';

// Reads the suite's own scenario config YAML files so the dashboard can tell a dev
// which labels exist and which namespaces support them, without anyone having to
// go spelunking through config/*.yaml by hand. Mirrors the file discovery and
// label-expression parsing in integration_test.py's pytest_generate_tests, and the
// supported_namespaces gate in lib/scenario.py's load_scenarios_from_config -
// read-only, no pytest invocation involved.

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const { REPO_ROOT } = require('./paths');
const SEARCH_DIRS = [
  'config/features',
  'config/tickets',
  'config/endpoint',
  'config/crossfunctional',
  'config/performance',
  'config/BETesting_team',
  'config',
];

const DRAFT_PREFIX = 'zz_dashboard_draft_'; // short-lived test-before-save files, never part of the catalog

function findConfigFiles() {
  const files = [];
  for (const dir of SEARCH_DIRS) {
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.yaml') && !entry.name.startsWith(DRAFT_PREFIX)) files.push(path.join(abs, entry.name));
    }
  }
  return files;
}

function loadAllScenarios() {
  const scenarios = [];
  for (const file of findConfigFiles()) {
    let doc;
    try {
      doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      continue; // not every *.yaml under config/ is a scenario file - skip what doesn't parse
    }
    for (const item of (doc && doc.scenarios) || []) {
      if (!item || !item.name) continue;
      scenarios.push({
        name: item.name,
        description: item.description || '',
        labels: item.labels || [],
        supportedNamespaces: item.supported_namespaces || [],
        file: path.relative(REPO_ROOT, file),
      });
    }
  }
  return scenarios;
}

function allLabels() {
  const set = new Set();
  for (const s of loadAllScenarios()) for (const l of s.labels) set.add(l);
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Same OR/AND parsing as integration_test.py: '||' separates OR groups, whitespace
// (or '&&') within a group means AND.
function parseLabelGroups(labelsInput) {
  const expression = Array.isArray(labelsInput) ? labelsInput.join(' ') : String(labelsInput || '');
  const groups = [];
  for (const group of expression.split('||')) {
    const labels = group
      .replace(/&&/g, ' ')
      .replace(/,/g, ' ')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (labels.length) groups.push(labels);
  }
  return groups;
}

function resolve(labelsInput, exclusionLabels = []) {
  const groups = parseLabelGroups(labelsInput);
  if (!groups.length) return { scenarios: [], namespaces: [] };

  const matched = loadAllScenarios().filter((s) => {
    const labelSet = new Set(s.labels);
    const matchesAnyGroup = groups.some((group) => group.every((l) => labelSet.has(l)));
    if (!matchesAnyGroup) return false;
    if (exclusionLabels.some((l) => labelSet.has(l))) return false;
    return true;
  });

  const namespaces = [...new Set(matched.flatMap((s) => s.supportedNamespaces))].sort((a, b) => a.localeCompare(b));
  return { scenarios: matched, namespaces };
}

module.exports = { loadAllScenarios, allLabels, resolve, findConfigFiles, DRAFT_PREFIX };
