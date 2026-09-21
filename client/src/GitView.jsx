import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  LuArrowDown,
  LuArrowUp,
  LuCheck,
  LuChevronRight,
  LuCircleAlert,
  LuCloudDownload,
  LuFileDiff,
  LuGitBranch,
  LuGitBranchPlus,
  LuGitCommitHorizontal,
  LuHistory,
  LuMinus,
  LuPlus,
  LuUpload,
  LuLoader,
  LuPanelLeftClose,
  LuPanelLeftOpen,
  LuRefreshCw,
  LuSearch,
  LuX,
} from 'react-icons/lu';
import { api } from './api.js';
import { Badge, DiffView, EmptyState, Field, IconButton, MenuButton, Modal, Sash, Section, Select, usePanelSize, useLocalState, useToast } from './ui.jsx';

const STATUS_TONE = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflict: '!', copied: 'C', changed: '•' };
const CODE_TONE = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied' };
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/;

function NewBranchModal({ current, locals, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState(current);
  const [busy, setBusy] = useState(false);
  const valid = BRANCH_RE.test(name) && !locals.includes(name);
  return (
    <Modal
      title="Create a new branch"
      icon={<LuGitBranchPlus size={16} />}
      width={480}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onCreate(name, from);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <LuLoader size={14} className="spin" /> : <LuGitBranchPlus size={14} />} Create and switch
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Branch name" hint={name && !valid ? (locals.includes(name) ? 'A branch with this name already exists.' : 'Use letters, digits and . _ - /') : 'e.g. SEK-200300-new-scenarios'}>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="SEK-200300-new-scenarios" spellCheck={false} />
        </Field>
        <Field label="Start from">
          <Select value={from} onChange={setFrom} searchable options={locals} />
        </Field>
      </div>
    </Modal>
  );
}

export default function GitView({ active }) {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [branches, setBranches] = useState({ local: [], remote: [] });
  const [commits, setCommits] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [openFile, setOpenFile] = useState(null); // { path, staged }
  const [pushOpen, setPushOpen] = useState(false);
  const [diff, setDiff] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [branchQ, setBranchQ] = useState('');
  const [newBranch, setNewBranch] = useState(false);
  const [pullStrategy, setPullStrategy] = useLocalState('git.pullStrategy', 'ff-only');
  const [sideOpen, setSideOpen] = useLocalState('git.sideOpen', true);
  const [sideW, setSideW, resetSideW] = usePanelSize('git.side', 300, 240, () => Math.min(560, window.innerWidth - 480));
  const [listW, setListW, resetListW] = usePanelSize('git.list', 340, 240, () => Math.min(620, window.innerWidth - 520));

  const refresh = useCallback(async (quiet) => {
    try {
      const [s, b, l] = await Promise.all([api.git.status(), api.git.branches(), api.git.log()]);
      setStatus(s);
      setBranches(b);
      setCommits(l.commits || []);
      setError('');
    } catch (e) {
      setError(e.message);
      if (!quiet) toast(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => {
    if (!active) return undefined;
    refresh(true);
    const t = setInterval(() => refresh(true), 15000);
    const onFocus = () => refresh(true);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [active, refresh]);

  // diff of the open file: what would be committed (staged) or what is still only in the working copy
  const fileSig = status?.files.map((f) => `${f.path}:${f.x}${f.y}`).join('|');
  useEffect(() => {
    if (!openFile || !status) return undefined;
    const f = status.files.find((x) => x.path === openFile.path && (openFile.staged ? x.staged : x.unstaged));
    if (!f) {
      setOpenFile(null);
      return undefined;
    }
    let cancelled = false;
    setDiffLoading(true);
    api.git
      .diff(f.path, { untracked: f.untracked && !openFile.staged, staged: openFile.staged })
      .then((r) => !cancelled && setDiff(r.diff))
      .catch((e) => !cancelled && setDiff(`# ${e.message}`))
      .finally(() => !cancelled && setDiffLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFile, fileSig]);

  const run = async (label, fn, okMessage) => {
    setBusy(label);
    try {
      const r = await fn();
      if (okMessage) toast(typeof okMessage === 'function' ? okMessage(r) : okMessage);
      await refresh(true);
      return r;
    } catch (e) {
      toast(e.message, 'error');
      setError(e.message);
      return null;
    } finally {
      setBusy('');
    }
  };

  const filteredLocal = useMemo(() => branches.local.filter((b) => b.name.toLowerCase().includes(branchQ.toLowerCase())), [branches, branchQ]);
  const remoteOnly = useMemo(() => {
    const localNames = new Set(branches.local.map((b) => b.name));
    return branches.remote.filter((b) => !localNames.has(b.name.replace(/^origin\//, '')) && b.name.toLowerCase().includes(branchQ.toLowerCase()));
  }, [branches, branchQ]);

  const files = status?.files || [];
  const stagedFiles = files.filter((f) => f.staged);
  const changedFiles = files.filter((f) => f.unstaged);
  const canCommit = stagedFiles.length > 0 && message.trim() && !busy && !status?.detached;
  const needsUpstream = !!status && !status.upstream && !status.detached;
  const canPush = !!status && !status.detached && (status.ahead > 0 || needsUpstream) && !busy;

  const commit = async () => {
    const r = await run('commit', () => api.git.commit(message), 'Committed');
    if (r) setMessage('');
  };
  const stage = (paths) => run('stage', () => api.git.stage(paths));
  const unstage = (paths) => run('stage', () => api.git.unstage(paths));
  const push = async () => {
    setPushOpen(false);
    await run('push', () => api.git.push(), (r) => r.output.split('\n').filter(Boolean).pop() || 'Pushed');
  };

  return (
    <div className="view">
      {sideOpen && (
        <aside className="panel side" style={{ width: sideW }}>
          <div className="panel-head">
            <span className="panel-title">Repository</span>
            <span className="spacer" />
            <IconButton size="sm" icon={<LuRefreshCw size={14} className={busy === 'refresh' ? 'spin' : ''} />} title="Refresh" onClick={() => run('refresh', () => Promise.resolve())} />
            <IconButton size="sm" icon={<LuPanelLeftClose size={16} />} title="Hide panel" onClick={() => setSideOpen(false)} />
          </div>
          <div className="panel-scroll">
            {status && (
              <div className="git-current">
                <div className="git-current-branch">
                  <LuGitBranch size={16} />
                  <span className="mono">{status.branch}</span>
                </div>
                <div className="git-current-meta">
                  {status.upstream ? (
                    <>
                      <span className="mono">{status.upstream}</span>
                      {status.ahead > 0 && <Badge title="Commits not pushed yet"><LuArrowUp size={10} /> {status.ahead}</Badge>}
                      {status.behind > 0 && <Badge title="Commits on origin you don't have"><LuArrowDown size={10} /> {status.behind}</Badge>}
                      {!status.ahead && !status.behind && <span className="text-ok">up to date</span>}
                    </>
                  ) : (
                    <span className="muted">no upstream branch</span>
                  )}
                </div>
                <div className="git-actions">
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!canPush}
                    title={status.detached ? 'Switch to a branch to push' : needsUpstream ? `Push ${status.branch} to origin and set it as the upstream` : status.ahead > 0 ? `Push ${status.ahead} commit${status.ahead === 1 ? '' : 's'} to ${status.upstream}` : 'Nothing to push'}
                    onClick={() => setPushOpen(true)}
                  >
                    {busy === 'push' ? <LuLoader size={13} className="spin" /> : <LuUpload size={13} />} Push
                    {status.ahead > 0 && <span className="btn-count">{status.ahead}</span>}
                  </button>
                  <button type="button" className="btn sm" disabled={!!busy} onClick={() => run('fetch', api.git.fetch, 'Fetched from origin')}>
                    {busy === 'fetch' ? <LuLoader size={13} className="spin" /> : <LuCloudDownload size={13} />} Fetch
                  </button>
                  <div className="split-btn">
                    <button
                      type="button"
                      className="btn sm"
                      disabled={!!busy || !status.upstream}
                      title={status.upstream ? `Pull ${status.upstream} (${pullStrategy})` : 'This branch has no upstream to pull from'}
                      onClick={() => run('pull', () => api.git.pull(pullStrategy), (r) => r.output.split('\n').pop() || 'Pulled')}
                    >
                      {busy === 'pull' ? <LuLoader size={13} className="spin" /> : <LuArrowDown size={13} />} Pull
                    </button>
                    <MenuButton
                      className="btn sm split-caret"
                      caret
                      title="Pull strategy"
                      items={[
                        { key: 'h', heading: 'Pull strategy' },
                        ...[['ff-only', 'Fast-forward only (safe)'], ['rebase', 'Rebase local commits'], ['merge', 'Merge']].map(([v, l]) => ({
                          key: v,
                          label: l,
                          hint: pullStrategy === v ? <LuCheck size={13} /> : undefined,
                          onClick: () => setPullStrategy(v),
                        })),
                      ]}
                    />
                  </div>
                </div>
              </div>
            )}
            {error && <div className="notice danger small"><LuCircleAlert size={14} /><div>{error}</div></div>}

            <Section
              title="Branches"
              icon={<LuGitBranch size={15} />}
              badge={branches.local.length || null}
              storageKey="git.sec.branches"
              actions={<IconButton size="xs" icon={<LuGitBranchPlus size={14} />} title="Create a new branch" onClick={() => setNewBranch(true)} />}
            >
              <div className="search-box">
                <LuSearch size={14} className="search-box-icon" />
                <input value={branchQ} onChange={(e) => setBranchQ(e.target.value)} placeholder="Filter branches" spellCheck={false} />
              </div>
              <div className="branch-list">
                <div className="branch-group">Local</div>
                {filteredLocal.map((b) => (
                  <button
                    type="button"
                    key={b.name}
                    className={`branch-row ${b.current ? 'current' : ''}`}
                    disabled={!!busy}
                    onClick={() => !b.current && run('checkout', () => api.git.checkout(b.name), `Switched to ${b.name}`)}
                    title={b.current ? 'Current branch' : `Switch to ${b.name}`}
                  >
                    {b.current ? <LuCheck size={13} /> : <span className="branch-gap" />}
                    <span className="branch-name">{b.name}</span>
                    <span className="branch-when">{b.when}</span>
                  </button>
                ))}
                {!filteredLocal.length && <div className="list-hint">No local branch matches.</div>}
                {remoteOnly.length > 0 && <div className="branch-group">On origin (not checked out)</div>}
                {remoteOnly.slice(0, 60).map((b) => (
                  <button
                    type="button"
                    key={b.name}
                    className="branch-row remote"
                    disabled={!!busy}
                    onClick={() => run('checkout', () => api.git.checkout(b.name.replace(/^origin\//, '')), `Checked out ${b.name.replace(/^origin\//, '')}`)}
                    title="Create a local tracking branch and switch to it"
                  >
                    <span className="branch-gap" />
                    <span className="branch-name">{b.name.replace(/^origin\//, '')}</span>
                    <span className="branch-when">{b.when}</span>
                  </button>
                ))}
                {remoteOnly.length > 60 && <div className="list-hint">{remoteOnly.length - 60} more — use the filter.</div>}
              </div>
            </Section>

            <Section title="History" icon={<LuHistory size={15} />} defaultOpen={false} storageKey="git.sec.history">
              <div className="commit-list">
                {commits.map((c) => (
                  <div key={c.sha} className="commit-row" title={`${c.author} · ${c.when}`}>
                    <LuGitCommitHorizontal size={13} className="muted" />
                    <span className="commit-subject">{c.subject}</span>
                    <span className="mono muted">{c.sha}</span>
                  </div>
                ))}
              </div>
            </Section>
          </div>
          <Sash edge="end" size={sideW} onSize={setSideW} onReset={resetSideW} />
        </aside>
      )}

      <section className="workspace git-workspace">
        <div className="tabstrip">
          {!sideOpen && <IconButton size="sm" icon={<LuPanelLeftOpen size={16} />} title="Show panel" onClick={() => setSideOpen(true)} />}
          <span className="tabstrip-title">Changes</span>
          {status && <span className="count-pill">{files.length}</span>}
          <span className="spacer" />
          {status && <span className="muted mono">{status.branch}</span>}
        </div>

        {!status ? (
          <EmptyState icon={<LuLoader size={24} className="spin" />} title="Reading the repository…" />
        ) : (
          <div className="git-body">
            <div className="git-files panel" style={{ width: listW }}>
              <div className="panel-scroll tight">
                <div className="git-group-head">
                  <span className="git-group-title">Staged changes</span>
                  <span className="count-pill">{stagedFiles.length}</span>
                  <span className="spacer" />
                  <IconButton size="xs" icon={<LuMinus size={13} />} title="Unstage all" disabled={!stagedFiles.length || !!busy} onClick={() => unstage(stagedFiles.map((f) => f.path))} />
                </div>
                {stagedFiles.map((f) => (
                  <div key={`s-${f.path}`} className={`git-file ${openFile?.path === f.path && openFile.staged ? 'active' : ''}`} onClick={() => setOpenFile({ path: f.path, staged: true })}>
                    <span className="git-file-text" title={f.path}>
                      <span className="git-file-name">{f.path.split('/').pop()}</span>
                      <span className="git-file-dir">{f.path.split('/').slice(0, -1).join('/')}</span>
                    </span>
                    <span className="git-file-actions"><IconButton size="xs" icon={<LuMinus size={13} />} title="Unstage this file" disabled={!!busy} onClick={(e) => { e.stopPropagation(); unstage([f.path]); }} /></span>
                    <span className={`git-badge s-${CODE_TONE[f.x] || 'changed'}`} title={CODE_TONE[f.x] || 'changed'}>{f.x === ' ' ? '•' : f.x}</span>
                  </div>
                ))}
                {!stagedFiles.length && <div className="list-hint pad">Nothing staged yet. Stage the files you want in the next commit with the + button.</div>}

                <div className="git-group-head">
                  <span className="git-group-title">Changes</span>
                  <span className="count-pill">{changedFiles.length}</span>
                  <span className="spacer" />
                  <IconButton size="xs" icon={<LuPlus size={13} />} title="Stage all" disabled={!changedFiles.length || !!busy} onClick={() => stage(changedFiles.map((f) => f.path))} />
                </div>
                {changedFiles.map((f) => {
                  const tone = f.untracked ? 'untracked' : CODE_TONE[f.y] || 'changed';
                  return (
                    <div key={`u-${f.path}`} className={`git-file ${openFile?.path === f.path && !openFile.staged ? 'active' : ''}`} onClick={() => setOpenFile({ path: f.path, staged: false })}>
                      <span className="git-file-text" title={f.path}>
                        <span className="git-file-name">{f.path.split('/').pop()}</span>
                        <span className="git-file-dir">{f.path.split('/').slice(0, -1).join('/')}</span>
                      </span>
                      <span className="git-file-actions"><IconButton size="xs" icon={<LuPlus size={13} />} title="Stage this file" disabled={!!busy} onClick={(e) => { e.stopPropagation(); stage([f.path]); }} /></span>
                      <span className={`git-badge s-${tone}`} title={tone}>{STATUS_TONE[tone] || '•'}</span>
                    </div>
                  );
                })}
                {!changedFiles.length && !stagedFiles.length && <div className="list-hint pad">Working tree clean — nothing to commit.</div>}
              </div>
              <div className="git-commit">
                <textarea className="input textarea" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={`Commit message (${status.branch})`} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canCommit) commit(); }} />
                <button type="button" className="btn primary block" disabled={!canCommit} onClick={commit} title="Commit the staged files (Ctrl/⌘ Enter)">
                  {busy === 'commit' ? <LuLoader size={14} className="spin" /> : <LuGitCommitHorizontal size={14} />}
                  Commit {stagedFiles.length > 0 ? `${stagedFiles.length} staged file${stagedFiles.length === 1 ? '' : 's'}` : ''}
                </button>
                <div className="field-hint">Only staged files are committed. Use Push to send commits to origin.</div>
              </div>
              <Sash edge="end" size={listW} onSize={setListW} onReset={resetListW} />
            </div>

            <div className="git-diff">
              {openFile ? (
                <>
                  <div className="git-diff-head">
                    <LuFileDiff size={15} className="muted" />
                    <span className="mono ellipsis">{openFile.path}</span>
                    <Badge>{openFile.staged ? 'staged' : 'working copy'}</Badge>
                    <span className="spacer" />
                    {diffLoading && <LuLoader size={14} className="spin muted" />}
                    <IconButton size="sm" icon={<LuX size={15} />} title="Close diff" onClick={() => setOpenFile(null)} />
                  </div>
                  <div className="git-diff-body"><DiffView diff={diff} empty={diffLoading ? 'Loading…' : 'No textual changes (binary or mode change)'} /></div>
                </>
              ) : (
                <EmptyState icon={<LuFileDiff size={26} />} title="Select a file to see its diff">
                  Staged files show what will be committed; other changes show what differs from the index.
                </EmptyState>
              )}
            </div>
          </div>
        )}
      </section>

      {pushOpen && status && (
        <Modal
          title="Push to origin"
          icon={<LuUpload size={16} />}
          width={480}
          onClose={() => setPushOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setPushOpen(false)}>Cancel</button>
              <button type="button" className="btn primary" onClick={push}><LuUpload size={14} /> Push</button>
            </>
          }
        >
          <div className="stack">
            <div>
              {needsUpstream ? (
                <>Push <span className="mono">{status.branch}</span> to a new branch <span className="mono">origin/{status.branch}</span> and track it.</>
              ) : (
                <>Push {status.ahead} commit{status.ahead === 1 ? '' : 's'} on <span className="mono">{status.branch}</span> to <span className="mono">{status.upstream}</span>.</>
              )}
            </div>
            <div className="muted">This is a normal push: it never forces, so it stops if origin has commits you don't have.</div>
          </div>
        </Modal>
      )}
      {newBranch && status && (
        <NewBranchModal
          current={status.branch.startsWith('HEAD') ? branches.local[0]?.name : status.branch}
          locals={branches.local.map((b) => b.name)}
          onClose={() => setNewBranch(false)}
          onCreate={async (name, from) => {
            const r = await run('branch', () => api.git.createBranch(name, from), `Created and switched to ${name}`);
            if (r) setNewBranch(false);
          }}
        />
      )}
    </div>
  );
}
