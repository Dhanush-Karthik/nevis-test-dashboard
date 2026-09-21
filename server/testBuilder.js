'use strict';

// Backs the "Create test case" tab. Everything here is additive: it reads the
// suite's existing config/**/*.yaml to offer predefined workflows/endpoint
// interactions, and writes exactly one NEW file under config/tickets/. The
// pytest side is untouched - pytest_generate_tests already globs
// config/tickets/*.yaml, so a generated file is picked up with no code changes.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const YAML = require('yaml');
const { findConfigFiles, DRAFT_PREFIX } = require('./scenarioCatalog');

const { REPO_ROOT, PYTEST_BIN } = require('./paths');
const TICKETS_DIR = path.join(REPO_ROOT, 'config', 'tickets');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATIC_FLOW_OPTIONS = ['register-user', 'login', 'register-device'];
const FLOW_OPTIONS = STATIC_FLOW_OPTIONS; // used for the schema's static defaults; validation uses getOptions()
const METHOD_IDENT_OPTIONS = ['four-fields', 'otp', 'eid', 'fake-auth', 'egk', 'tan', 'idnow-online', 'idnow-offline', 'nect-epass'];
const METHOD_AUTH_OPTIONS = ['fido-pin', 'egk', 'fake-auth', 'idnow-online', 'eid', 'fido-biometrics', 'fido-device-passcode', 'idnow-offline'];

// Workflow properties that scenarios use but that aren't documented in
// workflow_defaults_config.yaml (the defaults file only lists the ones with a
// default value). Types/descriptions inferred from usage across the repo.
const EXTRA_WORKFLOW_PROPS = [
  { key: 'flow', type: 'string', options: FLOW_OPTIONS, description: 'Which flow to run.' },
  { key: 'method_ident', type: 'string', options: METHOD_IDENT_OPTIONS, description: 'Identification method (register-user / register-device).' },
  { key: 'method_auth', type: 'string', options: METHOD_AUTH_OPTIONS, description: 'Authentication method (login).' },
  { key: 'expected_actions', type: 'list', description: 'Actions the IDP is expected to return, in order.' },
  { key: 'ignored_actions', type: 'list', description: 'Actions the workflow skips instead of handling.' },
  { key: 'expected_tokens', type: 'list', description: 'Tokens expected at the end of the flow, e.g. access-token.' },
  { key: 'expected_at_claims', type: 'object', description: 'Claims expected in the access token (JSON).' },
  { key: 'expected_idt_claims', type: 'object', description: 'Claims expected in the ID token (JSON).' },
  { key: 'claims', type: 'string', description: 'JSON string sent as the PAR `claims` parameter.' },
  { key: 'abort_action', type: 'string', description: 'Action at which the workflow aborts on purpose.' },
  { key: 'abort_action_counter', type: 'number', description: 'How many times the abort action is seen before aborting.' },
  { key: 'expected_error_description', type: 'string', description: 'Expected error_description when the workflow is meant to fail.' },
  { key: 'error_description', type: 'string', description: 'Error description to send/expect.' },
  { key: 'expected_json_responses', type: 'object', description: 'Expected JSON bodies per action (JSON).' },
  { key: 'expected_json_fields', type: 'object', description: 'Expected JSON fields in a response (JSON).' },
  { key: 'reset_email', type: 'boolean', description: 'Reset the test user email before the workflow.' },
  { key: 'reset_online_id', type: 'boolean', description: 'Reset the online id before the workflow.' },
  { key: 'reset_online_id_only', type: 'boolean', description: 'Reset only the online id.' },
  { key: 'reset_kvnr', type: 'boolean', description: 'Reset the KVNR before the workflow.' },
  { key: 'kvnr', type: 'string', description: 'KVNR of the test user.' },
  { key: 'vsnr', type: 'string', description: 'VSNR for four-fields identification.' },
  { key: 'first_name', type: 'string', description: 'First name for four-fields identification.' },
  { key: 'last_name', type: 'string', description: 'Last name for four-fields identification.' },
  { key: 'online_id', type: 'string', description: 'Online id of the test user.' },
  { key: 'another_email', type: 'string', description: 'Second email used in change-email style flows.' },
  { key: 'otp', type: 'string', description: 'OTP to submit instead of the fetched one.' },
  { key: 'tan_code', type: 'string', description: 'TAN code to submit.' },
  { key: 'tan_retry', type: 'number', description: 'TAN retry count.' },
  { key: 'resend_otp', type: 'boolean', description: 'Trigger an OTP resend.' },
  { key: 'accept_preview', type: 'boolean', description: 'Accept the identification preview.' },
  { key: 'authorization_details', type: 'string', description: 'JSON string sent as the PAR authorization_details parameter.' },
  { key: 'id_token_version', type: 'string', description: 'ID token version requested via PAR, e.g. 1.0.0 / 2.0.0.' },
  { key: 'repetitions', type: 'number', description: 'Run this workflow N times.' },
  { key: 'clear_output', type: 'boolean', description: 'Clear the output/ folder before the scenario.' },
  { key: 'sleep_before_start', type: 'number', description: 'Seconds to sleep before the workflow starts.' },
  { key: 'set_invalid_cert', type: 'boolean', description: 'Send an invalid client certificate.' },
  { key: 'skip_identifier_check', type: 'boolean', description: 'Skip the identifier check.' },
  { key: 'biometric_enable', type: 'boolean', description: 'Enable biometrics during FIDO registration.' },
  { key: 'fidouaf_device_id', type: 'string', description: 'FIDO UAF device id.' },
  { key: 'persist_tokens_as', type: 'string', description: 'Persist the tokens under this name.' },
  { key: 'expected_status_code', type: 'number', description: 'Expected HTTP status code.' },
  { key: 'scope_consents', type: 'list', description: 'Consents tied to the requested scope.' },
];

const ENDPOINT_PROPS = [
  { key: 'host', type: 'string', options: ['idp', 'idbroker', 'adm', 'history'], description: 'Which component to call.' },
  { key: 'endpoint', type: 'string', description: 'Path on the host, e.g. /.well-known/jwks.json.' },
  { key: 'method', type: 'string', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method.' },
  { key: 'auth_config', type: 'object', description: 'Auth for the request (JSON), e.g. {"type":"none"} | {"type":"token"} | {"type":"basic"}.' },
  { key: 'headers', type: 'object', description: 'Request headers (JSON).' },
  { key: 'query_params', type: 'object', description: 'Query parameters (JSON).' },
  { key: 'body', type: 'object', description: 'Request body (JSON).' },
  { key: 'expected_status_code', type: 'number', description: 'Expected HTTP status code.' },
  { key: 'expected_json_fields', type: 'object', description: 'JSON fields expected in the response (JSON).' },
  { key: 'expected_headers', type: 'object', description: 'Response headers expected (JSON).' },
  { key: 'expected_text', type: 'list', description: 'Substrings expected in the response text.' },
  { key: 'expected_at_claims', type: 'object', description: 'Claims expected in the access token (JSON).' },
  { key: 'expected_claims', type: 'object', description: 'Claims expected in the response token (JSON).' },
  { key: 'load_session', type: 'boolean', description: 'Load the stored session before the request.' },
  { key: 'store_session', type: 'boolean', description: 'Store the session after the request.' },
  { key: 'cert_config', type: 'object', description: 'Client certificate config (JSON), e.g. {"user":"adapter"}.' },
  { key: 'base_url', type: 'string', description: 'Override the base URL.' },
  { key: 'repetitions', type: 'number', description: 'Repeat the request N times.' },
  { key: 'allow_redirects', type: 'boolean', description: 'Follow redirects automatically.' },
  { key: 'persist_response', type: 'boolean', description: 'Write the JSON response to output/<name> for later steps.' },
  { key: 'persist_tokens', type: 'boolean', description: 'Persist access/refresh/id tokens from the response.' },
];

function typeOfValue(v) {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (Array.isArray(v)) return 'list';
  if (v && typeof v === 'object') return 'object';
  return 'string';
}

// The defaults files document each key with a comment block right above it
// ("# Description; options: a, b, c"). Reuse that as the property help text so
// the builder stays in sync with the repo without a second source of truth.
function parseDefaultsFile(relPath, rootKey) {
  const abs = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(abs)) return [];
  const text = fs.readFileSync(abs, 'utf8');
  let values = {};
  try {
    values = (YAML.parse(text) || {})[rootKey] || {};
  } catch (_) {
    /* fall back to comment-only parsing */
  }
  const props = [];
  let comments = [];
  for (const line of text.split('\n')) {
    const comment = line.match(/^\s*#\s?(.*)$/);
    if (comment) {
      comments.push(comment[1]);
      continue;
    }
    const keyMatch = line.match(/^ {2}([A-Za-z0-9_-]+):/);
    if (keyMatch) {
      const key = keyMatch[1];
      const description = comments.filter((c) => c && !c.startsWith('http')).join(' ');
      let options;
      const optMatch = description.match(/options?:\s*(.+)$/i);
      if (optMatch && !/etc/i.test(optMatch[1])) {
        options = optMatch[1].split(/,\s*/).map((s) => s.replace(/[.;]+$/, '').trim()).filter((s) => /^[\w.-]+$/.test(s));
        if (options.length < 2) options = undefined;
      }
      const dv = values[key];
      props.push({
        key,
        description: description.replace(/;?\s*options?:.*$/i, '').trim(),
        options,
        type: typeOfValue(dv),
        defaultValue: dv === undefined ? null : dv,
      });
    }
    if (line.trim() !== '') comments = [];
  }
  return props;
}

function mergeProps(defaultsProps, extras) {
  const byKey = new Map();
  for (const p of extras) byKey.set(p.key, p);
  for (const p of defaultsProps) byKey.set(p.key, { ...(byKey.get(p.key) || {}), ...p, options: p.options || byKey.get(p.key)?.options });
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function loadAllDefinitions() {
  const workflows = new Map();
  const endpoints = new Map();
  for (const file of findConfigFiles()) {
    let doc;
    try {
      doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      continue;
    }
    if (!doc) continue;
    const rel = path.relative(REPO_ROOT, file);
    // labels of the scenarios (in this file) that use a block: lets the library be searched by label
    const usage = new Map();
    for (const sc of Array.isArray(doc.scenarios) ? doc.scenarios : []) {
      const lbls = (Array.isArray(sc && sc.labels) ? sc.labels : []).map(String).filter((l) => !UUID_RE.test(l));
      for (const n of Array.isArray(sc && sc.sequence) ? sc.sequence : []) {
        const set = usage.get(n) || usage.set(n, new Set()).get(n);
        lbls.forEach((l) => set.add(l));
      }
    }
    for (const [list, map, kind] of [[doc.workflows, workflows, 'workflow'], [doc.endpoint_interactions, endpoints, 'endpoint']]) {
      for (const def of Array.isArray(list) ? list : []) {
        if (!def || typeof def !== 'object' || typeof def.name !== 'string') continue;
        const sig = JSON.stringify(def);
        const key = `${def.name} ${sig}`;
        const existing = map.get(key);
        const lbls = usage.get(def.name) || new Set();
        if (existing) {
          existing.count += 1;
          lbls.forEach((l) => existing.labels.add(l));
        } else map.set(key, { kind, name: def.name, source: rel, count: 1, def, labels: new Set(lbls) });
      }
    }
  }
  return { workflows: [...workflows.values()], endpoints: [...endpoints.values()] };
}

let catalogCache = null;
function getCatalog() {
  if (!catalogCache || Date.now() - catalogCache.at > 30000) {
    catalogCache = { at: Date.now(), data: loadAllDefinitions() };
  }
  return catalogCache.data;
}

function suggestionsFor(defs) {
  const listKeys = ['expected_actions', 'ignored_actions', 'expected_tokens', 'accept_consents', 'fido_authenticators', 'interactive_actions', 'abort_action'];
  const counts = {};
  for (const { def } of defs) {
    for (const k of listKeys) {
      const v = def[k];
      for (const item of Array.isArray(v) ? v : v === undefined ? [] : [v]) {
        if (typeof item !== 'string') continue;
        (counts[k] = counts[k] || new Map()).set(item, (counts[k].get(item) || 0) + 1);
      }
    }
  }
  const out = {};
  for (const [k, m] of Object.entries(counts)) out[k] = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([v]) => v);
  return out;
}

function getNamespaces() {
  const set = new Set();
  const nsFile = path.join(REPO_ROOT, 'config', 'defaults', 'namespace_defaults_config.yaml');
  try {
    for (const k of Object.keys(YAML.parse(fs.readFileSync(nsFile, 'utf8')) || {})) set.add(k);
  } catch (_) {
    /* ignore */
  }
  return [...set].sort();
}

// ---------- auto-discovery of properties straight from the pytest code ----------
//
// New config keys are usually introduced by reading them in lib/*.py
// (`self.config.get('some_key', default)`), often before anyone documents them in
// the defaults yaml. Scanning the code keeps the builder in sync without a
// manual list. Cached by file mtimes so it's cheap on every request.

const LIB_DIR = path.join(REPO_ROOT, 'lib');
const ENDPOINT_FILES = new Set(['endpoint_interaction.py', 'endpoint_interaction_helper.py', 'simple_client.py']);
// Files whose local variable named plain `config` is the workflow/endpoint config
// itself (elsewhere a bare `config` may be some nested dict, e.g. auth_config).
const BARE_CONFIG_FILES = new Set(['workflow.py', 'workflow_client.py', 'endpoint_interaction.py']);
const INTERNAL_KEYS = new Set(['name', 'namespace', 'performance_run']);
const BOOL_PREFIX = /^(reset_|is_|skip_|use_|enable|set_|accept_|persist_|allow_|load_|store_|append_|resend_)/;

function walkPy(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '__pycache__' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkPy(full, out);
    else if (e.name.endsWith('.py')) out.push(full);
  }
  return out;
}

function inferTypeFromDefault(text) {
  if (text === undefined) return null;
  const d = text.trim();
  if (/^(True|False)$/.test(d)) return 'boolean';
  if (/^-?\d+(\.\d+)?$/.test(d)) return 'number';
  if (d.startsWith('[')) return 'list';
  if (d.startsWith('{')) return 'object';
  if (/^['"]/.test(d)) return 'string';
  return null;
}

let codeCache = { sig: '', data: null };
function scanCode() {
  const files = walkPy(LIB_DIR);
  const sig = files.map((f) => `${f}:${fs.statSync(f).mtimeMs}`).join('|');
  if (codeCache.sig === sig && codeCache.data) return codeCache.data;

  const workflow = new Map();
  const endpoint = new Map();
  const options = { flow: new Set(), method_ident: new Set(), method_auth: new Set(), host: new Set() };

  for (const file of files) {
    const base = path.basename(file);
    const isEndpoint = ENDPOINT_FILES.has(base);
    const target = isEndpoint ? endpoint : workflow;
    const keyRe = new RegExp(
      `(?:self\\.config${BARE_CONFIG_FILES.has(base) ? '|(?<![\\w.])config' : ''})(?:\\.get\\(\\s*|\\[\\s*)['"]([A-Za-z0-9_-]+)['"]\\s*(?:,\\s*([^)\\]]*?))?\\s*[)\\]]`,
      'g'
    );
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      keyRe.lastIndex = 0;
      let m;
      while ((m = keyRe.exec(line))) {
        const key = m[1];
        if (INTERNAL_KEYS.has(key)) continue;
        const info = target.get(key) || { key, files: [], type: null, comment: '' };
        const loc = `${path.relative(REPO_ROOT, file)}:${idx + 1}`;
        if (info.files.length < 3) info.files.push(loc);
        info.type = info.type || inferTypeFromDefault(m[2]);
        if (!info.comment) {
          const prev = (lines[idx - 1] || '').trim();
          if (prev.startsWith('#')) info.comment = prev.replace(/^#+\s*/, '');
        }
        target.set(key, info);
      }
      const cmp = line.matchAll(/\b(flow|method_ident|method_auth|host)\s*(?:==|!=)\s*['"]([\w-]+)['"]/g);
      for (const c of cmp) options[c[1]].add(c[2]);
      const inList = line.match(/\b(flow|method_ident|method_auth)\s+in\s+[\[(]([^\])]*)[\])]/);
      if (inList) for (const q of inList[2].matchAll(/['"]([\w-]+)['"]/g)) options[inList[1]].add(q[1]);
    });
  }
  codeCache = { sig, data: { workflow, endpoint, options } };
  return codeCache.data;
}

function getOptions() {
  const code = scanCode().options;
  const union = (base, extra) => [...new Set([...base, ...extra])];
  return {
    flow: union(STATIC_FLOW_OPTIONS, code.flow),
    method_ident: union(METHOD_IDENT_OPTIONS, code.method_ident),
    method_auth: union(METHOD_AUTH_OPTIONS, code.method_auth),
    host: union(['idp', 'idbroker', 'adm', 'history'], code.host),
  };
}

function namespaceDefaultProps() {
  const file = path.join(REPO_ROOT, 'config', 'defaults', 'namespace_defaults_config.yaml');
  const props = new Map();
  try {
    for (const ns of Object.values(YAML.parse(fs.readFileSync(file, 'utf8')) || {})) {
      for (const [k, v] of Object.entries(ns || {})) if (!props.has(k)) props.set(k, v);
    }
  } catch (_) {
    /* ignore */
  }
  return props;
}

function withDiscovered(base, codeMap, extraDefaults) {
  const known = new Set(base.map((p) => p.key));
  const out = base.map((p) => ({ ...p, source: p.source || (p.defaultValue !== undefined ? 'defaults' : 'known') }));
  for (const [key, info] of codeMap) {
    if (known.has(key)) continue;
    known.add(key);
    const guessed = info.type || (BOOL_PREFIX.test(key) ? 'boolean' : 'auto');
    out.push({
      key,
      type: guessed,
      source: 'code',
      description: `${info.comment ? `${info.comment} - ` : ''}auto-discovered from ${info.files[0]}`,
    });
  }
  for (const [key, value] of extraDefaults || []) {
    if (known.has(key)) continue;
    known.add(key);
    out.push({ key, type: typeOfValue(value), source: 'namespace', description: 'Environment default from namespace_defaults_config.yaml - set it here to override for this workflow.', defaultValue: value });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function getSchema() {
  const catalog = getCatalog();
  const opts = getOptions();
  const code = scanCode();
  const setOptions = (props, map) => props.map((p) => (map[p.key] ? { ...p, options: map[p.key] } : p));
  const workflowBase = setOptions(mergeProps(parseDefaultsFile('config/defaults/workflow_defaults_config.yaml', 'workflows'), EXTRA_WORKFLOW_PROPS), {
    flow: opts.flow,
    method_ident: opts.method_ident,
    method_auth: opts.method_auth,
  });
  const endpointBase = setOptions(mergeProps(parseDefaultsFile('config/defaults/endpoint_interaction_defaults_config.yaml', 'endpoint_interactions'), ENDPOINT_PROPS), { host: opts.host });
  const workflowProps = withDiscovered(workflowBase, code.workflow, namespaceDefaultProps());
  const endpointProps = withDiscovered(endpointBase, code.endpoint);
  return {
    workflowProps,
    endpointProps,
    suggestions: suggestionsFor(catalog.workflows),
    namespaces: getNamespaces(),
    discovered: { workflow: workflowProps.filter((p) => p.source === 'code').length, endpoint: endpointProps.filter((p) => p.source === 'code').length },
    generatedAt: Date.now(),
  };
}

function getCatalogPayload() {
  const { workflows, endpoints } = getCatalog();
  const slim = (x) => ({ kind: x.kind, name: x.name, source: x.source, count: x.count, def: x.def, labels: [...x.labels].sort() });
  return { workflows: workflows.map(slim), endpoints: endpoints.map(slim) };
}


// ---------- generation ----------

const TICKET_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const KEY_ORDER = ['name', 'flow', 'method_ident', 'method_auth', 'host', 'endpoint', 'method'];

function cleanDef(def) {
  const out = {};
  const keys = Object.keys(def).sort((a, b) => {
    const ia = KEY_ORDER.indexOf(a);
    const ib = KEY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  for (const k of keys) {
    const v = def[k];
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function toYaml(obj) {
  const doc = new YAML.Document(obj);
  YAML.visit(doc, {
    Seq(_, node) {
      if (node.items.every((i) => YAML.isScalar(i))) node.flow = true;
    },
  });
  return doc.toString({ lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN', flowCollectionPadding: true });
}

// The list items of one top-level key, indented like the hand-written files
// (blank line between items), without the `key:` line itself.
function itemsBlock(key, items) {
  return toYaml({ [key]: items })
    .replace(/\n {2}-/g, '\n\n  -')
    .replace(/^\w+:\n\n?/, '')
    .replace(/\n+$/, '');
}

function section(title, key, items) {
  if (!items.length) return '';
  return `${key}:\n${itemsBlock(key, items)}\n`;
}

// Validates the builder payload and turns it into definitions + scenario entries.
function normalize(payload) {
  const errors = [];
  const opts = getOptions();
  const scenarios = payload.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0) errors.push('Add at least one scenario.');

  const workflows = new Map();
  const endpoints = new Map();
  const out = [];
  const scenarioNames = new Set();

  for (const [idx, sc] of (scenarios || []).entries()) {
    const label = `Scenario ${idx + 1}`;
    if (!sc.name || !NAME_RE.test(sc.name)) errors.push(`${label}: name is required (letters/digits/-/_/.).`);
    else if (scenarioNames.has(sc.name)) errors.push(`${label}: duplicate scenario name "${sc.name}".`);
    scenarioNames.add(sc.name);
    if (!Array.isArray(sc.supportedNamespaces) || !sc.supportedNamespaces.length) errors.push(`${label}: pick at least one supported namespace.`);
    if (!Array.isArray(sc.sequence) || !sc.sequence.length) errors.push(`${label}: sequence is empty - connect at least one block.`);

    const sequenceNames = [];
    for (const step of sc.sequence || []) {
      const def = cleanDef(step.def || {});
      const where = `${label}: "${def.name || '(unnamed)'}"`;
      if (!def.name || !NAME_RE.test(def.name)) {
        errors.push(`${label}: every block needs a name (letters/digits/-/_/.).`);
        continue;
      }
      if (step.kind === 'workflow') {
        if (!opts.flow.includes(def.flow)) errors.push(`${where}: flow must be one of ${opts.flow.join(', ')}.`);
      } else if (step.kind === 'endpoint') {
        for (const req of ['host', 'endpoint', 'method']) if (!def[req]) errors.push(`${where}: "${req}" is required for an endpoint interaction.`);
      } else {
        errors.push(`${where}: unknown block kind.`);
        continue;
      }
      const map = step.kind === 'workflow' ? workflows : endpoints;
      const other = step.kind === 'workflow' ? endpoints : workflows;
      if (other.has(def.name)) errors.push(`${where}: a ${step.kind === 'workflow' ? 'endpoint interaction' : 'workflow'} with this name already exists in the file - names must be unique.`);
      const prev = map.get(def.name);
      if (prev && stable(prev) !== stable(def)) errors.push(`${where}: used twice with different configuration - rename one of them.`);
      map.set(def.name, def);
      sequenceNames.push(def.name);
    }

    const labels = [...new Set((sc.labels || []).map((l) => String(l).trim()).filter(Boolean))];
    if (!labels.some((l) => UUID_RE.test(l))) labels.push(crypto.randomUUID());
    out.push({ name: sc.name, description: sc.description || '', supported_namespaces: sc.supportedNamespaces, labels, ...(typeof sc.clearOutput === 'boolean' ? { clear_output: sc.clearOutput } : {}), sequence: sequenceNames });
  }
  return { errors, workflows, endpoints, scenarios: out };
}

const summarize = (scenarios) => scenarios.map((s) => ({ name: s.name, labels: s.labels, namespaces: s.supported_namespaces }));

function buildNewFile(payload) {
  const { ticket } = payload;
  const norm = normalize(payload);
  const errors = [...norm.errors];
  if (!ticket || !TICKET_RE.test(ticket)) errors.unshift('Ticket name must be letters/digits/-/_/. only (e.g. SEK-200300).');
  if (errors.length) return { ok: false, errors };

  const yaml =
    section('workflows', 'workflows', [...norm.workflows.values()]) +
    '\n' +
    section('endpoint-interactions', 'endpoint_interactions', [...norm.endpoints.values()]) +
    (norm.endpoints.size ? '\n' : '') +
    section('scenarios', 'scenarios', norm.scenarios);

  return {
    ok: true,
    mode: 'new',
    yaml: yaml.replace(/\n{3,}/g, '\n\n'),
    fileName: `${ticket}_scenarios_config.yaml`,
    relPath: path.join('config', 'tickets', `${ticket}_scenarios_config.yaml`),
    scenarios: summarize(norm.scenarios),
  };
}

function resolveTargetFile(relPath) {
  const abs = path.resolve(REPO_ROOT, relPath || '');
  return findConfigFiles().includes(abs) ? abs : null;
}

// Adds new list items at the end of an existing top-level section, leaving every
// other byte of the file alone. Throws on layouts it can't safely edit.
function insertIntoSection(text, key, itemsText, title) {
  const lines = text.split('\n');
  const re = new RegExp(`^${key}:(.*)$`);
  let keyIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(re);
    if (!m) continue;
    const rest = m[1].trim();
    if (rest === '[]') lines[i] = `${key}:`; // an empty list written inline: turn it into a block list to add to
    else if (rest && !rest.startsWith('#')) throw new Error(`"${key}:" uses an inline value in that file - add to it by hand.`);
    keyIdx = i;
    break;
  }
  if (keyIdx === -1) {
    return `${text.replace(/\s+$/, '')}\n\n${key}:\n${itemsText}\n`;
  }
  // Match the section's own list indent (some files use un-indented `- name:` lists).
  const firstItem = lines.slice(keyIdx + 1).find((l) => /^\s*-\s/.test(l));
  const indent = firstItem ? firstItem.match(/^(\s*)-/)[1].length : 2;
  const shift = indent - 2;
  const shifted = itemsText
    .split('\n')
    .map((l) => (shift < 0 ? l.replace(new RegExp(`^ {0,${-shift}}`), '') : shift > 0 ? (l ? ' '.repeat(shift) + l : l) : l));
  let next = lines.findIndex((l, i) => i > keyIdx && /^[^\s#-]/.test(l));
  let end = next === -1 ? lines.length : next;
  while (end - 1 > keyIdx && (lines[end - 1].trim() === '' || lines[end - 1].startsWith('#'))) end -= 1;
  lines.splice(end, 0, '', ...shifted);
  const joined = lines.join('\n');
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

function planAppend(payload) {
  const norm = normalize(payload);
  const errors = [...norm.errors];
  const abs = resolveTargetFile(payload.targetFile);
  if (!abs) errors.unshift('Pick an existing scenario file to add to.');
  if (errors.length) return { ok: false, errors };

  const text = fs.readFileSync(abs, 'utf8');
  let doc;
  try {
    doc = YAML.parse(text) || {};
  } catch (e) {
    return { ok: false, errors: [`The target file doesn't parse as YAML: ${e.message}`] };
  }
  const rel = path.relative(REPO_ROOT, abs);
  const byName = (list) => new Map((Array.isArray(list) ? list : []).filter((d) => d && d.name).map((d) => [d.name, cleanDef(d)]));
  const exWf = byName(doc.workflows);
  const exEp = byName(doc.endpoint_interactions);
  const exSc = new Set((Array.isArray(doc.scenarios) ? doc.scenarios : []).map((s) => s && s.name));

  const addWf = [];
  const addEp = [];
  const reused = [];
  for (const [items, existing, opposite, add, kind] of [
    [norm.workflows, exWf, exEp, addWf, 'workflow'],
    [norm.endpoints, exEp, exWf, addEp, 'endpoint interaction'],
  ]) {
    for (const def of items.values()) {
      if (opposite.has(def.name)) errors.push(`"${def.name}" already exists in ${rel} as a different kind of block - rename it.`);
      else if (existing.has(def.name)) {
        if (stable(existing.get(def.name)) === stable(def)) reused.push(def.name);
        else errors.push(`${kind} "${def.name}" already exists in ${rel} with different configuration - rename it (or use the file's version).`);
      } else add.push(def);
    }
  }
  for (const s of norm.scenarios) if (exSc.has(s.name)) errors.push(`Scenario "${s.name}" already exists in ${rel}.`);
  if (errors.length) return { ok: false, errors };

  let out = text;
  const previews = [];
  try {
    if (addWf.length) {
      const block = itemsBlock('workflows', addWf);
      out = insertIntoSection(out, 'workflows', block, 'workflows');
      previews.push(`# appended to workflows:\n${block}`);
    }
    if (addEp.length) {
      const block = itemsBlock('endpoint_interactions', addEp);
      out = insertIntoSection(out, 'endpoint_interactions', block, 'endpoint-interactions');
      previews.push(`# appended to endpoint_interactions:\n${block}`);
    }
    const scBlock = itemsBlock('scenarios', norm.scenarios);
    out = insertIntoSection(out, 'scenarios', scBlock, 'scenarios');
    previews.push(`# appended to scenarios:\n${scBlock}`);
  } catch (e) {
    return { ok: false, errors: [e.message] };
  }

  // Safety net: the result must still parse and must contain exactly the additions.
  try {
    const after = YAML.parse(out) || {};
    const count = (l) => (Array.isArray(l) ? l.length : 0);
    const ok =
      count(after.workflows) === count(doc.workflows) + addWf.length &&
      count(after.endpoint_interactions) === count(doc.endpoint_interactions) + addEp.length &&
      count(after.scenarios) === count(doc.scenarios) + norm.scenarios.length;
    if (!ok) return { ok: false, errors: ['Internal check failed: the appended file would not contain exactly the new items. Nothing was written.'] };
  } catch (e) {
    return { ok: false, errors: [`Internal check failed (result would not parse): ${e.message}. Nothing was written.`] };
  }

  return {
    ok: true,
    mode: 'append',
    yaml: previews.join('\n\n'),
    newText: out,
    absPath: abs,
    relPath: rel,
    added: { workflows: addWf.map((d) => d.name), endpoints: addEp.map((d) => d.name), scenarios: norm.scenarios.map((s) => s.name) },
    reused,
    scenarios: summarize(norm.scenarios),
  };
}

function buildTestCase(payload) {
  const res = payload && payload.mode === 'append' ? planAppend(payload) : buildNewFile(payload || {});
  if (res.newText !== undefined) {
    const { newText, absPath, ...rest } = res; // keep the (large) full text server-side only
    return rest;
  }
  return res;
}

function saveTestCase(payload) {
  const res = payload && payload.mode === 'append' ? planAppend(payload) : buildNewFile(payload || {});
  if (!res.ok) return res;
  if (res.mode === 'append') {
    fs.writeFileSync(res.absPath, res.newText, 'utf8');
    const { newText, absPath, ...rest } = res;
    return { ...rest, saved: true };
  }
  const target = path.join(TICKETS_DIR, res.fileName);
  if (path.dirname(target) !== TICKETS_DIR) return { ok: false, errors: ['Invalid file name.'] };
  if (fs.existsSync(target)) {
    // "New file" never clobbers an existing file; use "Add to existing file" to extend one.
    return { ok: false, conflict: true, errors: [`${res.relPath} already exists - switch to "Add to existing file" to append this scenario to it.`] };
  }
  fs.mkdirSync(TICKETS_DIR, { recursive: true });
  fs.writeFileSync(target, res.yaml, 'utf8');
  return { ...res, saved: true };
}

function listScenarioFiles() {
  const out = [];
  for (const file of findConfigFiles()) {
    let doc;
    try {
      doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      continue;
    }
    if (!doc || !Array.isArray(doc.scenarios)) continue;
    const n = (l) => (Array.isArray(l) ? l.length : 0);
    out.push({
      relPath: path.relative(REPO_ROOT, file),
      scenarios: n(doc.scenarios),
      workflows: n(doc.workflows),
      endpoints: n(doc.endpoint_interactions),
      mtime: fs.statSync(file).mtimeMs,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---------- test-before-save ----------
//
// pytest can only discover scenarios from config/**/*.yaml, and we must not change
// that logic, so a draft is written as a short-lived file under config/tickets/
// (hidden from the dashboard's own catalogs via DRAFT_PREFIX), run by label, and
// removed the moment the run finishes.

function createDraft(payload) {
  const one = { scenarios: (payload.scenarios || []).slice(0, 1) };
  const id = crypto.randomBytes(4).toString('hex');
  const built = buildNewFile({ ...one, ticket: `draft-${id}` });
  if (!built.ok) return built;
  const abs = path.join(TICKETS_DIR, `${DRAFT_PREFIX}${id}_scenarios_config.yaml`);
  fs.mkdirSync(TICKETS_DIR, { recursive: true });
  fs.writeFileSync(abs, built.yaml, 'utf8');
  const uuid = built.scenarios[0].labels.find((l) => UUID_RE.test(l));
  return { ok: true, uuid, cleanup: () => fs.rm(abs, { force: true }, () => {}) };
}

function cleanupDrafts() {
  if (!fs.existsSync(TICKETS_DIR)) return;
  for (const f of fs.readdirSync(TICKETS_DIR)) if (f.startsWith(DRAFT_PREFIX)) fs.rmSync(path.join(TICKETS_DIR, f), { force: true });
}

// `pytest --dry-run` only builds the scenario list and prints it - no requests
// are made - so it's a safe way to prove the new file is discovered and parses.
function validateWithDryRun({ label, namespace }) {
  return new Promise((resolve) => {
    if (!label || !namespace) return resolve({ ok: false, error: 'label and namespace are required' });
    const bin = PYTEST_BIN;
    const proc = spawn(bin, ['--dry-run', '--labels', label, '--namespaces', namespace, '--exclusion-labels', 'eid'], { cwd: REPO_ROOT });
    let out = '';
    const timer = setTimeout(() => proc.kill('SIGTERM'), 90000);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (out += d.toString()));
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const total = out.match(/Total number of scenarios:\s*(\d+)/);
      const names = [...out.matchAll(/Scenario Name:\s*(.+)/g)].map((m) => m[1].trim());
      const sequences = [...out.matchAll(/Sequence:\s*(.+)/g)].map((m) => m[1].trim());
      resolve({
        ok: code === 0 && !!total && Number(total[1]) > 0,
        exitCode: code,
        scenarioCount: total ? Number(total[1]) : 0,
        scenarios: names.map((n, i) => ({ name: n, sequence: sequences[i] || '' })),
        output: out.split('\n').slice(-40).join('\n'),
      });
    });
  });
}

module.exports = { insertIntoSection, itemsBlock, getSchema, getCatalogPayload, buildTestCase, saveTestCase, validateWithDryRun, listScenarioFiles, createDraft, cleanupDrafts };
