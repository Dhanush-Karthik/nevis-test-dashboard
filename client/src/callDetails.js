// Turns the span on the receiving side of a cross-component hop into a readable "call":
// method + route, status, duration, and the few attributes worth showing. Works with both the
// old and the stable OpenTelemetry HTTP attribute names; non-HTTP hops (db, messaging, rpc) get a tag.

const METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/;
const first = (attrs, keys) => {
  for (const k of keys) if (attrs && attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== '') return attrs[k];
  return undefined;
};
const pathOf = (u) => {
  try { return new URL(u).pathname; } catch (_) { return String(u).split('?')[0]; }
};

export function describeCall(span, parent) {
  const a = span.attrs || {};
  const pa = (parent && parent.attrs) || {};
  const nameHit = METHOD_RE.exec(span.name || '') || METHOD_RE.exec((parent && parent.name) || '');
  const method = first(a, ['http.request.method', 'http.method']) || first(pa, ['http.request.method', 'http.method']) || (nameHit && nameHit[1]) || null;
  const rawPath =
    first(a, ['http.route', 'url.path', 'http.target']) ||
    first(pa, ['http.route', 'url.path', 'http.target']) ||
    (first(a, ['http.url', 'url.full']) && pathOf(first(a, ['http.url', 'url.full']))) ||
    (first(pa, ['http.url', 'url.full']) && pathOf(first(pa, ['http.url', 'url.full']))) ||
    (nameHit && nameHit[2]) ||
    span.name;
  const path = String(rawPath).split('?')[0] || String(rawPath);
  const statusRaw = first(a, ['http.response.status_code', 'http.status_code']) ?? first(pa, ['http.response.status_code', 'http.status_code']);
  const status = statusRaw === undefined ? null : Number(statusRaw);
  const tag = first(a, ['db.system']) ? `db · ${first(a, ['db.system'])}` : first(a, ['messaging.system']) ? `msg · ${first(a, ['messaging.system'])}` : first(a, ['rpc.system']) ? `rpc · ${first(a, ['rpc.system'])}` : null;
  const exception = (span.events || []).find((e) => e.name === 'exception');
  const failed = !!span.error || (status !== null && status >= 400);
  return {
    span,
    parent: parent || null,
    method,
    path,
    status,
    tag,
    failed,
    startUs: span.startUs,
    durUs: span.durUs,
    url: first(a, ['http.url', 'url.full']) || first(pa, ['http.url', 'url.full']) || null,
    peer: first(pa, ['server.address', 'net.peer.name', 'peer.service']) || first(a, ['server.address', 'net.host.name', 'http.host', 'host.name']) || null,
    message: span.statusMessage || (exception && (exception.attrs['exception.message'] || exception.attrs['exception.type'])) || null,
    statement: first(a, ['db.statement', 'db.query.text']) || null,
  };
}

export const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone', 415: 'Unsupported Media Type',
  422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return v < 1024 ? `${v} B` : v < 1048576 ? `${(v / 1024).toFixed(v < 10240 ? 1 : 0)} KB` : `${(v / 1048576).toFixed(1)} MB`;
}

const joined = (v) => (Array.isArray(v) ? v.join(', ') : v);

// Everything else worth knowing about a hop: sizes, content types, query, agent, and how long the request spent in
// flight before the receiver started and on the way back after it finished (client-side span vs server-side span).
export function httpFacts(span, parent) {
  const a = span.attrs || {};
  const pa = (parent && parent.attrs) || {};
  const pick = (keys) => joined(first(a, keys) ?? first(pa, keys));
  const url = first(a, ['http.url', 'url.full']) || first(pa, ['http.url', 'url.full']) || null;
  let query = first(a, ['url.query']) || null;
  if (!query && url && String(url).includes('?')) query = String(url).split('?')[1];
  if (!query && first(a, ['http.target']) && String(first(a, ['http.target'])).includes('?')) query = String(first(a, ['http.target'])).split('?')[1];
  const host = pick(['server.address', 'net.host.name', 'http.host', 'net.peer.name']);
  const port = pick(['server.port', 'net.host.port', 'net.peer.port']);
  return {
    reqSize: pick(['http.request.body.size', 'http.request_content_length', 'http.request.header.content-length']) ?? null,
    resSize: pick(['http.response.body.size', 'http.response_content_length', 'http.response.header.content-length']) ?? null,
    reqType: pick(['http.request.header.content-type']) ?? null,
    resType: pick(['http.response.header.content-type']) ?? null,
    userAgent: pick(['user_agent.original', 'http.user_agent']) ?? null,
    scheme: pick(['url.scheme', 'http.scheme']) ?? null,
    hostPort: host ? `${host}${port ? `:${port}` : ''}` : null,
    query: query || null,
    queryKeys: query ? String(query).split('&').map((kv) => kv.split('=')[0]).filter(Boolean) : [],
    inFlightUs: parent ? Math.max(0, span.startUs - parent.startUs) : null,
    backUs: parent ? Math.max(0, parent.startUs + parent.durUs - (span.startUs + span.durUs)) : null,
    clientIp: pick(['client.address', 'http.client_ip', 'net.sock.peer.addr']) ?? null,
    flavor: pick(['network.protocol.version', 'http.flavor']) ?? null,
  };
}

// A client span whose far side exported nothing (a database, a message broker, an HTTP service that is not
// instrumented): described as a call to an "external" participant.
export function describeExternal(span) {
  const a = span.attrs || {};
  const db = first(a, ['db.system']);
  const target = first(a, ['peer.service', 'server.address', 'net.peer.name', 'http.host', 'db.name']) || db || span.name;
  const call = describeCall(span, null);
  return { participant: `ext:${String(target).split('/')[0]}`, label: String(target), kind: db ? `db · ${db}` : first(a, ['messaging.system']) ? `msg · ${first(a, ['messaging.system'])}` : 'external', call };
}

export const statusTone = (c) => (c === null ? 'none' : c >= 500 ? 'bad' : c >= 400 ? 'warn' : c >= 300 ? 'redir' : 'ok');
