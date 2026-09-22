import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LuArrowDownToLine, LuClock, LuDownload, LuExpand, LuFilter, LuRegex, LuSearch, LuSquareArrowOutUpRight, LuCode, LuWrapText, LuX } from 'react-icons/lu';
import { api } from './api.js';
import { linkifyLine, useTraceLinks } from './tracing.jsx';
import { DateTimeField, EmptyState, IconButton, Modal, Segmented, Select, toLocalValue, useToast } from './ui.jsx';

const LEVEL_RE = /\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\b/i;

function levelOf(line) {
  const m = line.match(LEVEL_RE);
  return m ? m[1].toUpperCase().replace('WARNING', 'WARN') : null;
}

// Scans from `start` (an opening brace/bracket) and returns the index of its match, honoring
// quoted strings so a "}" or "]" inside a string value doesn't end the scan early.
function scanBalanced(s, start) {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

// pytest / requests often log a raw JSON body inline in an otherwise plain line (e.g. a request
// or response payload). Find the first well-formed JSON object/array embedded in the line, if any,
// so it can be pretty-printed instead of shown as one long, unreadable blob.
function extractJson(line) {
  if (!line || line.length > 200000) return null;
  let from = 0;
  for (let guard = 0; guard < 6; guard++) {
    const rel = line.slice(from).search(/[{[]/);
    if (rel === -1) return null;
    const idx = from + rel;
    const end = scanBalanced(line, idx);
    if (end === -1) return null;
    const candidate = line.slice(idx, end + 1);
    if (candidate.length > 3) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') {
          return { before: line.slice(0, idx), after: line.slice(end + 1), pretty: JSON.stringify(parsed, null, 2) };
        }
      } catch (_) { /* not JSON after all — keep scanning past it */ }
    }
    from = end + 1;
  }
  return null;
}

const CONTEXT_WINDOWS = ['5s', '10s', '30s', '1m', '5m'].map((label, i) => ({ label: `±${label}`, value: [5000, 10000, 30000, 60000, 300000][i] }));
const LEVELS = ['ALL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'FATAL'].map((l) => ({ value: l, label: l === 'ALL' ? 'All levels' : l }));

const logText = (entries) => entries.map((e) => `${new Date(e.ts).toISOString()} ${e.line}`).join('\n');
const safeName = (s) => s.replace(/[^a-z0-9._-]/gi, '_');


function LogLine({ entry, level, onShowContext, pinned, onLinkOpen }) {
  const rootLinks = useTraceLinks();
  // remember which line the trace was opened from, and stop autoscroll so the log stays where it is
  const links = useMemo(
    () => rootLinks && { ...rootLinks, open: (t, s) => { onLinkOpen(entry); rootLinks.open(t, s); } },
    [rootLinks, entry, onLinkOpen]
  );
  // only the pytest run's own output, not pod logs: a request/response body there is the one
  // thing worth reformatting, and it should read like an ordinary (if indented) log line - no
  // extra box, border or button, just the same text with proper line breaks.
  const json = useMemo(() => (entry.source === 'pytest' ? extractJson(entry.line) : null), [entry.line, entry.source]);
  const text = (s) => (links ? linkifyLine(s, links) : s);
  return (
    <div className={`log-line lvl-${level || 'NONE'} ${entry.stream === 'stderr' ? 'stderr' : ''} ${pinned ? 'pinned' : ''} ${json ? 'has-json' : ''}`}>
      <button className="log-ctx-btn" title="Show surrounding logs" aria-label="Show surrounding logs" onClick={() => onShowContext(entry)}>
        <LuExpand size={12} />
      </button>
      <span className="log-ts">{new Date(entry.ts).toLocaleTimeString()}</span>
      <span className="log-text">
        {json ? (
          <>
            {text(json.before)}
            {json.pretty}
            {text(json.after)}
          </>
        ) : (
          text(entry.line)
        )}
      </span>
    </div>
  );
}

function ContextModal({ entry, allEntries, onClose }) {
  const [windowMs, setWindowMs] = useState(30000);
  const context = useMemo(() => {
    const lo = entry.ts - windowMs / 2;
    const hi = entry.ts + windowMs / 2;
    return allEntries.filter((e) => e.ts >= lo && e.ts <= hi).sort((a, b) => a.ts - b.ts);
  }, [entry, allEntries, windowMs]);

  return (
    <Modal title={`Surrounding logs · ${new Date(entry.ts).toLocaleTimeString()}`} onClose={onClose} width={860} icon={<LuExpand size={16} />}>
      <div className="ctx-controls">
        <span className="muted">Window around the selected line</span>
        <Segmented size="sm" block={false} value={windowMs} onChange={setWindowMs} options={CONTEXT_WINDOWS} />
      </div>
      <div className="ctx-body log-surface">
        {context.map((e, i) => {
          const isTarget = e.ts === entry.ts && e.line === entry.line;
          return (
            <div key={i} className={`log-line lvl-${levelOf(e.line) || 'NONE'} ${isTarget ? 'ctx-target' : ''}`}>
              <span className="log-ts">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="log-text">{e.line}</span>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

export default function LogPanel({ title, entries, onPopout }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [level, setLevel] = useState('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [showTime, setShowTime] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [contextEntry, setContextEntry] = useState(null);
  const [pinnedKey, setPinnedKey] = useState(null);
  const bottomRef = useRef(null);
  const onLinkOpen = useCallback((entry) => {
    setAutoscroll(false);
    setPinnedKey(`${entry.source}:${entry.seq}`);
  }, []);

  const matcher = useMemo(() => {
    if (!search) return null;
    if (useRegex) {
      try {
        return new RegExp(search, 'i');
      } catch (_) {
        return null;
      }
    }
    const needle = search.toLowerCase();
    return { test: (s) => s.toLowerCase().includes(needle) };
  }, [search, useRegex]);

  const regexInvalid = useRegex && search && !matcher;
  const timeActive = Boolean(from || to);
  const isFiltering = Boolean(search || level !== 'ALL' || timeActive);

  const filtered = useMemo(() => {
    const fromTs = from ? new Date(from).getTime() : null;
    const toTs = to ? new Date(to).getTime() : null;
    return entries.filter((e) => {
      if (fromTs && e.ts < fromTs) return false;
      if (toTs && e.ts > toTs) return false;
      if (level !== 'ALL' && levelOf(e.line) !== level) return false;
      if (matcher && !matcher.test(e.line)) return false;
      return true;
    });
  }, [entries, from, to, level, matcher]);

  useEffect(() => {
    if (autoscroll) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [filtered.length, autoscroll]);

  const download = () => {
    const blob = new Blob([logText(filtered)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName(title)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openInVsCode = async () => {
    if (!filtered.length) {
      toast('Nothing to open — no log lines match the current filters', 'info');
      return;
    }
    try {
      await api.openLog({ ide: 'vscode', name: safeName(title), content: logText(filtered) });
      toast(`Opened ${filtered.length.toLocaleString()} lines in VS Code`);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const clearFilters = () => {
    setSearch('');
    setLevel('ALL');
    setFrom('');
    setTo('');
  };

  return (
    <div className="log-panel">
      <div className="log-toolbar">
        <div className={`search-box ${regexInvalid ? 'invalid' : ''}`}>
          <LuSearch size={14} className="search-box-icon" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={useRegex ? 'Search (regular expression)' : 'Search logs'} spellCheck={false} />
          {search && <IconButton size="xs" icon={<LuX size={13} />} title="Clear search" onClick={() => setSearch('')} />}
          <IconButton size="xs" icon={<LuRegex size={14} />} title="Use regular expression" active={useRegex} onClick={() => setUseRegex((v) => !v)} />
        </div>

        <Select size="sm" value={level} onChange={setLevel} options={LEVELS} icon={<LuFilter size={13} />} className="w-level" title="Log level" />

        <button type="button" className={`btn sm ${showTime || timeActive ? 'active' : ''}`} onClick={() => setShowTime((v) => !v)} title="Filter by time range">
          <LuClock size={14} />
          <span>Time range</span>
          {timeActive && <span className="dot-indicator" />}
        </button>

        <span className="spacer" />

        <span className="muted mono-num" title="Matching / total lines">
          {filtered.length.toLocaleString()} / {entries.length.toLocaleString()} lines
        </span>
        <span className="tool-sep" />
        <IconButton size="md" icon={<LuWrapText size={15} />} title="Wrap long lines" active={wrap} onClick={() => setWrap((v) => !v)} />
        <IconButton size="md" icon={<LuArrowDownToLine size={15} />} title="Auto-scroll to newest" active={autoscroll} onClick={() => setAutoscroll((v) => !v)} />
        <IconButton size="md" icon={<LuDownload size={15} />} title="Download as .log file" onClick={download} />
        {onPopout && <IconButton size="md" icon={<LuSquareArrowOutUpRight size={15} />} title="Open these logs in a separate window (keeps streaming live)" onClick={onPopout} />}
        <button type="button" className="btn sm" onClick={openInVsCode} title="Open the (filtered) logs in VS Code">
          <LuCode size={14} />
          <span>Open in VS Code</span>
        </button>
      </div>

      {(showTime || timeActive) && (
        <div className="log-toolbar log-toolbar-sub">
          <span className="muted">From</span>
          <DateTimeField size="sm" value={from} onChange={setFrom} placeholder="Start of run" title="From" />
          <span className="muted">To</span>
          <DateTimeField size="sm" value={to} onChange={setTo} placeholder="Now" title="To" />
          <button type="button" className="btn sm ghost" onClick={() => setFrom(entries.length ? toLocalValue(entries[0].ts) : '')} title="Start at the first log line">
            First line
          </button>
          {timeActive && (
            <button type="button" className="btn sm ghost" onClick={() => { setFrom(''); setTo(''); }}>
              Clear range
            </button>
          )}
        </div>
      )}

      {isFiltering && (
        <div className="log-filter-banner">
          <LuFilter size={13} />
          <span>
            Filters are active — hidden lines are still in the log. Use the <b>expand</b> button on any line to see what surrounds it, unfiltered.
          </span>
          <button type="button" className="link-btn" onClick={clearFilters}>Reset filters</button>
        </div>
      )}

      <div className={`log-body log-surface ${wrap ? 'wrap' : ''}`}>
        {filtered.length === 0 ? (
          <EmptyState icon={<LuSearch size={22} />} title={entries.length ? 'No lines match your filters' : 'Waiting for output…'} />
        ) : (
          filtered.map((e, i) => <LogLine key={i} entry={e} level={levelOf(e.line)} onShowContext={setContextEntry} pinned={pinnedKey === `${e.source}:${e.seq}`} onLinkOpen={onLinkOpen} />)
        )}
        <div ref={bottomRef} />
      </div>
      {contextEntry && <ContextModal entry={contextEntry} allEntries={entries} onClose={() => setContextEntry(null)} />}
    </div>
  );
}
