import React, { useEffect, useMemo } from 'react';
import { LuChevronDown, LuChevronRight, LuChevronsDownUp, LuFileText, LuFolder, LuFolderOpen, LuRefreshCw, LuSearch, LuWorkflow, LuX } from 'react-icons/lu';
import { IconButton, useLocalState } from './ui.jsx';

// Builds config/... into nested folders (VS Code explorer style).
function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.relPath.split('/');
    let cur = root;
    parts.slice(0, -1).forEach((seg, i) => {
      const p = parts.slice(0, i + 1).join('/');
      if (!cur.dirs.has(seg)) cur.dirs.set(seg, { name: seg, path: p, dirs: new Map(), files: [] });
      cur = cur.dirs.get(seg);
    });
    cur.files.push({ ...f, name: parts[parts.length - 1] });
  }
  return root;
}

function matchFile(f, q) {
  const needle = q.toLowerCase();
  const pathHit = f.relPath.toLowerCase().includes(needle);
  const scenarios = f.scenarios.filter((s) => (s.name || '').toLowerCase().includes(needle) || s.labels.some((l) => l.toLowerCase().includes(needle)));
  const defs = [...f.workflows, ...f.endpoints].filter((n) => (n || '').toLowerCase().includes(needle));
  return { hit: pathHit || scenarios.length > 0 || defs.length > 0, scenarios: scenarios.slice(0, 8), moreScenarios: Math.max(0, scenarios.length - 8), defs: defs.length };
}

function Highlight({ text, q }) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export default function FileTree({ files, query, onQuery, openPath, activeScenario, dirty, onOpen, onRefresh, loading }) {
  const [expanded, setExpanded] = useLocalState('explorer.expanded', ['config']);
  const [openFiles, setOpenFiles] = useLocalState('explorer.openFiles', []);
  const toggleFile = (p) => setOpenFiles((e) => (e.includes(p) ? e.filter((x) => x !== p) : [...e, p]));
  const q = query.trim();
  // reveal the open file: expand every folder above it
  useEffect(() => {
    if (!openPath) return;
    const parts = openPath.split('/').slice(0, -1);
    const dirs = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    setExpanded((e) => (dirs.every((d) => e.includes(d)) ? e : [...new Set([...e, ...dirs])]));
  }, [openPath, setExpanded]);
  const exp = useMemo(() => new Set(expanded), [expanded]);

  const visible = useMemo(() => {
    if (!q) return files.map((f) => ({ ...f, match: null }));
    return files.map((f) => ({ ...f, match: matchFile(f, q) })).filter((f) => f.match.hit);
  }, [files, q]);

  const tree = useMemo(() => buildTree(visible), [visible]);
  const toggle = (p) => setExpanded((e) => (e.includes(p) ? e.filter((x) => x !== p) : [...e, p]));

  const renderDir = (dir, depth) => {
    const dirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const files2 = [...dir.files].sort((a, b) => a.name.localeCompare(b.name));
    return (
      <>
        {dirs.map((d) => {
          const open = q ? true : exp.has(d.path);
          const count = (function count(n) { return n.files.length + [...n.dirs.values()].reduce((a, c) => a + count(c), 0); })(d);
          return (
            <div key={d.path}>
              <div className="ft-row dir" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => !q && toggle(d.path)}>
                {open ? <LuChevronDown size={14} className="ft-chev" /> : <LuChevronRight size={14} className="ft-chev" />}
                {open ? <LuFolderOpen size={15} className="ft-icon dir" /> : <LuFolder size={15} className="ft-icon dir" />}
                <span className="ft-name">{d.name}</span>
                <span className="ft-count">{count}</span>
              </div>
              {open && renderDir(d, depth + 1)}
            </div>
          );
        })}
        {files2.map((f) => {
          const st = dirty.get(f.relPath);
          const isOpen = openPath === f.relPath;
          const multi = f.scenarios.length > 1;
          const showKids = multi && (q ? false : isOpen || openFiles.includes(f.relPath));
          const kidsOpen = showKids;
          return (
            <div key={f.relPath}>
              <div
                className={`ft-row file ${isOpen && !multi ? 'active' : ''} ${isOpen ? 'current' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => onOpen(f.relPath)}
                title={f.relPath}
              >
                {multi ? (
                  <span
                    className="ft-twisty"
                    role="button"
                    aria-label={kidsOpen ? 'Hide scenarios' : 'Show scenarios'}
                    onClick={(e) => { e.stopPropagation(); toggleFile(f.relPath); }}
                  >
                    {kidsOpen ? <LuChevronDown size={14} /> : <LuChevronRight size={14} />}
                  </span>
                ) : (
                  <span className="ft-twisty blank" />
                )}
                <LuFileText size={15} className="ft-icon file" />
                <span className="ft-name"><Highlight text={f.name} q={q} /></span>
                {st && <span className={`ft-git s-${st}`} title={st}>{st === 'untracked' ? 'U' : st === 'added' ? 'A' : 'M'}</span>}
                <span className="ft-count" title={`${f.scenarios.length} scenario${f.scenarios.length === 1 ? '' : 's'}`}>{f.scenarios.length}</span>
              </div>
              {kidsOpen && (
                <div className="ft-kids" style={{ '--ft-indent': `${8 + depth * 14 + 20}px` }}>
                  {f.scenarios.map((s) => (
                    <div
                      key={s.index}
                      className={`ft-row scen ${isOpen && activeScenario === s.index ? 'active' : ''}`}
                      onClick={() => onOpen(f.relPath, s.index)}
                      title={s.name}
                    >
                      <span className="ft-num">{s.index + 1}</span>
                      <LuWorkflow size={13} className="ft-icon file" />
                      <span className="ft-name">{s.name || `Scenario ${s.index + 1}`}</span>
                    </div>
                  ))}
                </div>
              )}
              {q && f.match && (f.match.scenarios.length > 0 || f.match.defs > 0) && (
                <div className="ft-matches" style={{ paddingLeft: 8 + depth * 14 + 34 }}>
                  {f.match.scenarios.map((s) => (
                    <div key={s.index} className="ft-match" onClick={() => onOpen(f.relPath, s.index)} title={s.name}>
                      <LuWorkflow size={12} className="muted" />
                      <span className="ellipsis"><Highlight text={s.name || ''} q={q} /></span>
                    </div>
                  ))}
                  {f.match.moreScenarios > 0 && <div className="ft-more">+{f.match.moreScenarios} more scenarios</div>}
                  {f.match.defs > 0 && <div className="ft-more">{f.match.defs} matching workflow/endpoint definition{f.match.defs === 1 ? '' : 's'}</div>}
                </div>
              )}
            </div>
          );
        })}
      </>
    );
  };

  return (
    <div className="ft">
      <div className="ft-controls">
        <div className="search-box">
          <LuSearch size={14} className="search-box-icon" />
          <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search files, scenarios, labels…" spellCheck={false} />
          {query && <IconButton size="xs" icon={<LuX size={13} />} title="Clear search" onClick={() => onQuery('')} />}
        </div>
        <IconButton size="md" icon={<LuChevronsDownUp size={15} />} title="Collapse all folders" onClick={() => setExpanded([])} />
        <IconButton size="md" icon={<LuRefreshCw size={14} className={loading ? 'spin' : ''} />} title="Reload the file list" onClick={onRefresh} />
      </div>
      <div className="ft-list">
        {renderDir(tree, 0)}
        {!visible.length && <div className="list-hint pad">{q ? `Nothing matches “${q}”.` : 'No scenario files found.'}</div>}
      </div>
      <div className="ft-foot">{visible.length} of {files.length} files</div>
    </div>
  );
}
