import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  LuChevronDown, LuChevronRight, LuChevronsDownUp, LuClipboardCopy, LuCopy, LuExternalLink, LuFilePlus, LuFileText, LuFolder, LuFolderOpen, LuFolderPlus,
  LuPanelLeftClose, LuPencil, LuRefreshCw, LuSearch, LuTrash2, LuWorkflow, LuX,
} from 'react-icons/lu';
import { ContextMenu, IconButton, useLocalState } from './ui.jsx';

// Builds config/... into nested folders (VS Code explorer style).
function buildTree(files, dirs = []) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  // folders pytest reads are shown even while empty, so a file can be dropped into them
  for (const d of dirs) {
    const parts = d.split('/');
    let cur = root;
    parts.forEach((seg, i) => {
      if (!cur.dirs.has(seg)) cur.dirs.set(seg, { name: seg, path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] });
      cur = cur.dirs.get(seg);
    });
  }
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

// Inline name entry (VS Code style) for a new file / new folder / rename: Enter confirms, Esc or click-away cancels.
function NameRow({ depth, kind, initial, onSubmit, onCancel }) {
  const [name, setName] = useState(initial);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <div className="ft-row file new" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="ft-twisty blank" />
      {kind === 'folder' ? <LuFolder size={15} className="ft-icon dir" /> : <LuFileText size={15} className="ft-icon file" />}
      <input
        ref={ref}
        className="ft-new-input"
        value={name}
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && name.trim()) onSubmit(name.trim());
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={onCancel}
      />
      {kind !== 'folder' && <span className="ft-ext">.yaml</span>}
    </div>
  );
}

const dirOf = (p) => p.split('/').slice(0, -1).join('/');
const stem = (n) => n.replace(/\.yaml$/, '');

export default function FileTree({
  files, dirs: allDirs = [], unscanned = [], query, onQuery, openPath, activeScenario, dirty, drafts, onOpen, onRefresh, loading,
  onCreateFile, onCreateFolder, onMove, onDelete, onCopy, onRename, onCollapsePanel,
}) {
  const [sel, setSel] = useState(null); // { kind: 'file' | 'dir', path }
  const [creating, setCreating] = useState(null); // { kind: 'file' | 'folder', dir }
  const [renaming, setRenaming] = useState(null); // file path
  const [dropDir, setDropDir] = useState(null);
  const [menu, setMenu] = useState(null); // { x, y, target: { kind: 'file' | 'dir' | 'root', path } }
  const [expanded, setExpanded] = useLocalState('explorer.expanded', ['config']);
  const [openFiles, setOpenFiles] = useLocalState('explorer.openFiles', []);
  const toggleFile = (p) => setOpenFiles((e) => (e.includes(p) ? e.filter((x) => x !== p) : [...e, p]));
  const q = query.trim();
  const unscannedSet = useMemo(() => new Set(unscanned), [unscanned]);
  // reveal the open file: expand every folder above it
  useEffect(() => {
    if (!openPath) return;
    const parts = openPath.split('/').slice(0, -1);
    const dirsAbove = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    setExpanded((e) => (dirsAbove.every((d) => e.includes(d)) ? e : [...new Set([...e, ...dirsAbove])]));
  }, [openPath, setExpanded]);
  const exp = useMemo(() => new Set(expanded), [expanded]);

  const visible = useMemo(() => {
    if (!q) return files.map((f) => ({ ...f, match: null }));
    return files.map((f) => ({ ...f, match: matchFile(f, q) })).filter((f) => f.match.hit);
  }, [files, q]);

  const tree = useMemo(() => buildTree(visible, q ? [] : allDirs), [visible, allDirs, q]);
  const toggle = (p) => setExpanded((e) => (e.includes(p) ? e.filter((x) => x !== p) : [...e, p]));
  const expandTo = (dir) => setExpanded((e) => [...new Set([...e, ...dir.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))])]);

  // where "new file / new folder" lands: the selected folder, or the folder of the selected file
  const targetDir = () => {
    const cand = sel ? (sel.kind === 'dir' ? sel.path : dirOf(sel.path)) : null;
    if (cand && allDirs.includes(cand)) return cand;
    return allDirs.includes('config/tickets') ? 'config/tickets' : allDirs[0];
  };
  const startCreate = (kind, dir) => {
    const at = dir || targetDir();
    if (!at) return;
    onQuery('');
    expandTo(at);
    setSel({ kind: 'dir', path: at });
    setRenaming(null);
    setCreating({ kind, dir: at });
  };
  const startRename = (path) => { setCreating(null); setRenaming(path); };
  const openMenu = (e, target) => {
    e.preventDefault();
    e.stopPropagation();
    setSel(target.kind === 'root' ? sel : target);
    setMenu({ x: e.clientX, y: e.clientY, target });
  };
  const copyText = (t) => navigator.clipboard?.writeText(t).catch(() => {});

  const menuItems = (t) => {
    if (t.kind === 'file') {
      return [
        { key: 'open', label: 'Open', icon: <LuExternalLink size={14} />, onClick: () => onOpen(t.path) },
        { key: 'dup', label: 'Duplicate', icon: <LuCopy size={14} />, onClick: () => onCopy(t.path) },
        { key: 'ren', label: 'Rename…', icon: <LuPencil size={14} />, hint: 'F2', onClick: () => startRename(t.path) },
        { key: 's1', separator: true },
        { key: 'cp', label: 'Copy path', icon: <LuClipboardCopy size={14} />, onClick: () => copyText(t.path) },
        { key: 's2', separator: true },
        { key: 'del', label: 'Delete', icon: <LuTrash2 size={14} />, hint: 'Del', danger: true, onClick: () => onDelete(t.path, 'file') },
      ];
    }
    const items = [
      { key: 'nf', label: 'New file', icon: <LuFilePlus size={14} />, onClick: () => startCreate('file', t.path || undefined) },
      { key: 'nd', label: 'New folder', icon: <LuFolderPlus size={14} />, onClick: () => startCreate('folder', t.path || undefined) },
    ];
    if (t.kind === 'dir') {
      items.push({ key: 's1', separator: true }, { key: 'cp', label: 'Copy path', icon: <LuClipboardCopy size={14} />, onClick: () => copyText(t.path) });
      items.push({ key: 'del', label: 'Delete folder', icon: <LuTrash2 size={14} />, danger: true, onClick: () => onDelete(t.path, 'folder') });
    }
    return items;
  };

  const onKeyDown = (e) => {
    if (!sel || sel.kind !== 'file' || creating || renaming) return;
    if (e.key === 'F2') { e.preventDefault(); startRename(sel.path); }
    else if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) { e.preventDefault(); onDelete(sel.path, 'file'); }
  };

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
              <div
                className={`ft-row dir ${sel?.path === d.path ? 'sel' : ''} ${dropDir === d.path ? 'drop' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => { setSel({ kind: 'dir', path: d.path }); if (!q) toggle(d.path); }}
                onContextMenu={(e) => openMenu(e, { kind: 'dir', path: d.path })}
                onDragOver={(e) => { if (onMove && allDirs.includes(d.path) && e.dataTransfer.types.includes('application/x-nevis-file')) { e.preventDefault(); if (dropDir !== d.path) setDropDir(d.path); } }}
                onDragLeave={() => setDropDir((cur) => (cur === d.path ? null : cur))}
                onDrop={(e) => {
                  const from = e.dataTransfer.getData('application/x-nevis-file');
                  setDropDir(null);
                  if (from && onMove && allDirs.includes(d.path)) { e.preventDefault(); onMove(from, d.path); }
                }}
              >
                {open ? <LuChevronDown size={14} className="ft-chev" /> : <LuChevronRight size={14} className="ft-chev" />}
                {open ? <LuFolderOpen size={15} className="ft-icon dir" /> : <LuFolder size={15} className="ft-icon dir" />}
                <span className="ft-name">{d.name}</span>
                {unscannedSet.has(d.path) && <span className="ft-note" title="pytest does not read this folder. Move files to config/features, config/tickets, ... to run them.">not run</span>}
                <span className="ft-count">{count}</span>
              </div>
              {open && creating && creating.dir === d.path && (
                <NameRow
                  depth={depth + 1}
                  kind={creating.kind}
                  initial={creating.kind === 'folder' ? 'new-folder' : 'new-test'}
                  onCancel={() => setCreating(null)}
                  onSubmit={(name) => { const c = creating; setCreating(null); (c.kind === 'folder' ? onCreateFolder : onCreateFile)(c.dir, name); }}
                />
              )}
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
          const hasDraft = drafts && drafts.has(f.relPath);
          if (renaming === f.relPath) {
            return <NameRow key={f.relPath} depth={depth} kind="file" initial={stem(f.name)} onCancel={() => setRenaming(null)} onSubmit={(name) => { setRenaming(null); onRename(f.relPath, name); }} />;
          }
          return (
            <div key={f.relPath}>
              <div
                className={`ft-row file ${isOpen && !multi ? 'active' : ''} ${isOpen ? 'current' : ''} ${sel?.path === f.relPath ? 'sel' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => { setSel({ kind: 'file', path: f.relPath }); onOpen(f.relPath); }}
                onContextMenu={(e) => openMenu(e, { kind: 'file', path: f.relPath })}
                title={f.relPath}
                draggable={!!onMove && !q}
                onDragStart={(e) => { e.dataTransfer.setData('application/x-nevis-file', f.relPath); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setDropDir(null)}
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
                {hasDraft && <span className="ft-draft" title="Unsaved changes are kept in the app">●</span>}
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
      <div className="panel-head slim ft-head">
        <span className="panel-title">Files</span>
        <span className="spacer" />
        <span className="ft-actions">
          <IconButton size="sm" icon={<LuFilePlus size={15} />} title={`New file in ${targetDir() || 'config'}`} onClick={() => startCreate('file')} />
          <IconButton size="sm" icon={<LuFolderPlus size={15} />} title={`New folder in ${targetDir() || 'config'}`} onClick={() => startCreate('folder')} />
          <IconButton size="sm" icon={<LuRefreshCw size={14} className={loading ? 'spin' : ''} />} title="Refresh explorer" onClick={onRefresh} />
          <IconButton size="sm" icon={<LuChevronsDownUp size={15} />} title="Collapse folders" onClick={() => setExpanded([])} />
          {onCollapsePanel && <><i className="ft-actions-sep" /><IconButton size="sm" icon={<LuPanelLeftClose size={15} />} title="Hide files" onClick={onCollapsePanel} /></>}
        </span>
      </div>
      <div className="ft-controls">
        <div className="search-box">
          <LuSearch size={14} className="search-box-icon" />
          <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search files, scenarios, labels…" spellCheck={false} />
          {query && <IconButton size="xs" icon={<LuX size={13} />} title="Clear search" onClick={() => onQuery('')} />}
        </div>
      </div>
      <div className="ft-list" tabIndex={0} onKeyDown={onKeyDown} onContextMenu={(e) => openMenu(e, { kind: 'root', path: '' })}>
        {renderDir(tree, 0)}
        {!visible.length && <div className="list-hint pad">{q ? `Nothing matches “${q}”.` : 'No scenario files yet. Use the new file button above.'}</div>}
      </div>
      <div className="ft-foot">{visible.length} of {files.length} files{onMove && !q ? ' · right-click for more · drag files onto folders' : ''}</div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={() => setMenu(null)} />}
    </div>
  );
}
