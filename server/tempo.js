'use strict';

// Read-only access to the cluster's Tempo (traces) and Grafana (UI links).
// Tempo is reached through a managed `oc port-forward` (or TEMPO_URL if it is already exposed).
// Everything is GET-only against Tempo's query API.

const portForward = require('./portForward');

const OBS_NAMESPACE = process.env.OBSERVABILITY_NAMESPACE || 'dev-observability';
const TEMPO_LOCAL_PORT = Number(process.env.TEMPO_LOCAL_PORT || 13200);
const GRAFANA_LOCAL_PORT = Number(process.env.GRAFANA_LOCAL_PORT || 13000);
const GRAFANA_DATASOURCE = process.env.GRAFANA_TEMPO_DATASOURCE || 'Tempo';

async function tempoBase() {
  if (process.env.TEMPO_URL) return process.env.TEMPO_URL.replace(/\/$/, '');
  const port = await portForward.ensure({ key: 'tempo', namespace: OBS_NAMESPACE, target: 'svc/tempo-sekidp', remotePort: 3200, localPort: TEMPO_LOCAL_PORT });
  return `http://127.0.0.1:${port}`;
}

async function grafanaBase() {
  if (process.env.GRAFANA_URL) return process.env.GRAFANA_URL.replace(/\/$/, '');
  const port = await portForward.ensure({ key: 'grafana', namespace: OBS_NAMESPACE, target: 'svc/sekidp-service', remotePort: 3000, localPort: GRAFANA_LOCAL_PORT });
  return `http://localhost:${port}`;
}

async function tempoGet(pathAndQuery, retried = false) {
  const base = await tempoBase();
  let res;
  try {
    res = await fetch(`${base}${pathAndQuery}`, { signal: AbortSignal.timeout(20000) });
  } catch (err) {
    // A stale tunnel (pod restarted / idle drop) leaves the local port open but dead: rebuild it once.
    if (retried || process.env.TEMPO_URL) throw new Error(`Tempo is unreachable (${err.cause?.code || err.message})`);
    portForward.restart('tempo');
    await new Promise((r) => setTimeout(r, 500));
    return tempoGet(pathAndQuery, true);
  }
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw new Error(`Tempo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { data: await res.json() };
}

const b64hex = (b) => (b ? Buffer.from(b, 'base64').toString('hex') : '');
const anyValue = (v) => {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(anyValue);
  return JSON.stringify(v);
};
const attrsOf = (list) => Object.fromEntries((list || []).map((a) => [a.key, anyValue(a.value)]));
const usOf = (nanoStr) => Number(BigInt(nanoStr || '0') / 1000n); // ns -> us (fits in a double)

// OTLP/JSON batches -> flat span list with hex ids and microsecond times.
function normalizeTrace(raw, traceId) {
  const spans = [];
  for (const batch of raw.batches || raw.resourceSpans || []) {
    const res = attrsOf(batch.resource?.attributes);
    const service = res['service.name'] || 'unknown';
    for (const scope of batch.scopeSpans || batch.instrumentationLibrarySpans || []) {
      for (const sp of scope.spans || []) {
        const start = usOf(sp.startTimeUnixNano);
        const end = usOf(sp.endTimeUnixNano);
        spans.push({
          spanId: b64hex(sp.spanId),
          parentId: b64hex(sp.parentSpanId) || null,
          name: sp.name,
          service,
          kind: String(sp.kind || '').replace('SPAN_KIND_', '').toLowerCase(),
          startUs: start,
          durUs: Math.max(0, end - start),
          error: sp.status?.code === 'STATUS_CODE_ERROR' || sp.status?.code === 2,
          statusMessage: sp.status?.message || '',
          attrs: attrsOf(sp.attributes),
          resource: { host: res['host.name'], version: res['service.version'], instance: res['service.instance.id'] },
          events: (sp.events || []).map((e) => ({ name: e.name, timeUs: usOf(e.timeUnixNano), attrs: attrsOf(e.attributes) })),
        });
      }
    }
  }
  spans.sort((a, b) => a.startUs - b.startUs);
  return { traceId, spans, summary: summarize(spans) };
}

function summarize(spans) {
  if (!spans.length) return { spanCount: 0, services: [], startUs: 0, durUs: 0, errorCount: 0, rootName: null, roots: 0, rootNames: [] };
  const ids = new Set(spans.map((s) => s.spanId));
  const start = Math.min(...spans.map((s) => s.startUs));
  const end = Math.max(...spans.map((s) => s.startUs + s.durUs));
  const roots = spans.filter((s) => !s.parentId || !ids.has(s.parentId));
  return {
    spanCount: spans.length,
    services: [...new Set(spans.map((s) => s.service))],
    startUs: start,
    durUs: end - start,
    errorCount: spans.filter((s) => s.error).length,
    rootName: (roots[0] || spans[0]).name,
    // entry points into the instrumented components = one per request whose parent span was never exported
    roots: roots.length,
    rootNames: roots.slice(0, 4).map((r) => r.name),
  };
}

const cleanId = (id) => String(id || '').replace(/-/g, '').toLowerCase();

// Traces fetched recently, kept so the global search can find their spans by id or name without another Tempo call.
const traceCache = new Map();
const CACHE_MAX = 40;
function remember(trace) {
  traceCache.delete(trace.traceId);
  traceCache.set(trace.traceId, trace);
  while (traceCache.size > CACHE_MAX) traceCache.delete(traceCache.keys().next().value);
}
function cachedSpanMatches(q, limit = 20) {
  const out = [];
  for (const t of traceCache.values()) {
    for (const s of t.spans) {
      if (s.spanId.includes(q) || (s.parentId && s.parentId.includes(q)) || (s.name || '').toLowerCase().includes(q)) {
        out.push({ traceId: t.traceId, spanId: s.spanId, parentId: s.parentId, name: s.name, service: s.service, error: s.error, durUs: s.durUs });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

async function getTrace(id) {
  const traceId = cleanId(id);
  if (!/^[0-9a-f]{1,32}$/.test(traceId)) throw new Error('trace id must be hex (or a uuid)');
  const r = await tempoGet(`/api/traces/${traceId}`);
  if (r.notFound) return { traceId, found: false, spans: [], summary: normalizeTrace({}, traceId).summary };
  const full = { found: true, ...normalizeTrace(r.data, traceId) };
  remember(full);
  return full;
}

// Time-window fallback: recent traces (any service) between two epoch-ms bounds.
async function searchWindow(startMs, endMs, limit = 20) {
  const q = `/api/search?start=${Math.floor(startMs / 1000)}&end=${Math.ceil(endMs / 1000)}&limit=${limit}`;
  const r = await tempoGet(q);
  return (r.data?.traces || []).map((t) => ({
    traceId: t.traceID,
    rootService: t.rootServiceName,
    rootName: t.rootTraceName,
    startMs: Math.floor(Number(BigInt(t.startTimeUnixNano || '0') / 1000000n)),
    durMs: t.durationMs ?? null,
  }));
}

async function status() {
  try {
    const base = await tempoBase();
    const res = await fetch(`${base}/api/echo`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Tempo answered ${res.status}`);
    return { ok: true, source: process.env.TEMPO_URL ? 'TEMPO_URL' : `oc port-forward ${OBS_NAMESPACE}/svc/tempo-sekidp` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Deep link into Grafana Explore for a trace id. The Grafana tunnel is started on demand.
async function grafanaTraceUrl(traceId, fromMs, toMs) {
  const base = await grafanaBase();
  const range = { from: String(Math.floor((fromMs || Date.now() - 3 * 3600e3) - 60e3)), to: String(Math.ceil((toMs || Date.now()) + 15 * 60e3)) };
  const left = { datasource: GRAFANA_DATASOURCE, queries: [{ refId: 'A', queryType: 'traceql', query: cleanId(traceId) }], range };
  return `${base}/explore?orgId=1&left=${encodeURIComponent(JSON.stringify(left))}`;
}

module.exports = { cachedSpanMatches, getTrace, searchWindow, status, grafanaTraceUrl, cleanId };
