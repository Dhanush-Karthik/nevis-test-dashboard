import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LuBoxes, LuFlaskConical, LuFolderTree, LuGitBranch, LuHistory, LuMenu, LuSearch, LuSettings, LuSquareArrowOutUpRight } from 'react-icons/lu';
import TestsView from './TestsView.jsx';
import DeploymentsView from './DeploymentsView.jsx';
import CreateTestView from './CreateTestView.jsx';
import GitView from './GitView.jsx';
import logoUrl from './assets/nevis-logo.png';
import SettingsView from './SettingsView.jsx';
import HistoryView from './HistoryView.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import OcSessionHost from './OcSession.jsx';
import { getActiveRun, isShortcut, openPopout, shortcutLabel } from './popout.js';
import { api } from './api.js';
import { ToastProvider, useLocalState, useToast } from './ui.jsx';

const NAV = [
  { id: 'explorer', label: 'Explorer', icon: LuFolderTree },
  { id: 'tests', label: 'Run tests', icon: LuFlaskConical },
  { id: 'history', label: 'History', icon: LuHistory },
  { id: 'git', label: 'Git', icon: LuGitBranch },
  { id: 'deployments', label: 'Deployments', icon: LuBoxes },
  { id: 'settings', label: 'Settings', icon: LuSettings },
];

// Official Nevis mark (cropped from the brand logo); sits on a white tile so its colours stay true on the dark theme.
function NevisLogo({ size = 30 }) {
  return <img className="nevis-logo" src={logoUrl} width={size} height={size} alt="Nevis" draggable={false} />;
}

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}

function AppInner() {
  const toast = useToast();
  const [storedSection, setSection] = useLocalState('section', 'explorer');
  const section = storedSection === 'defaults' || storedSection === 'env' ? 'settings' : storedSection === 'create' ? 'explorer' : storedSection; // tabs merged into Settings / Explorer
  const [collapsed, setCollapsed] = useLocalState('navCollapsed', false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [badges, setBadges] = useState({ history: 0, git: 0 });
  // jump to a search result: switch tab, then tell that view what to show
  const navigate = useCallback((nav) => {
    setSection(nav.section);
    setTimeout(() => window.dispatchEvent(new CustomEvent('nevis-nav', { detail: nav })), 60);
  }, [setSection]);

  // Sidebar badges + background run notifications: running runs on History, uncommitted files on Git (like VS Code).
  const seen = useRef(null); // runId -> last status; null until the first look
  const sectionRef = useRef(section);
  sectionRef.current = section;
  useEffect(() => {
    let alive = true;
    const finished = (r) => !['starting', 'running'].includes(r.status);
    const label = (r) => r.title || (r.config.labels || []).join(', ') || 'Run';
    const originTab = (r) => (r.kind === 'scenario-test' ? 'explorer' : 'tests');
    const look = async () => {
      try {
        const { runs } = await api.runs();
        if (!alive) return;
        const first = seen.current === null;
        if (first) seen.current = new Map();
        for (const r of runs) {
          const prev = seen.current.get(r.id);
          const here = sectionRef.current;
          if (!first && prev === undefined && !finished(r) && here !== 'history' && here !== originTab(r)) {
            toast(`${r.kind === 'scenario-test' ? 'Scenario test' : 'Test run'} started in the background`, 'info', { sub: `${label(r)} · click to follow it`, duration: 5000, onClick: () => navigate({ section: 'history', run: r.id }) });
          }
          if (prev !== undefined && !finished({ status: prev }) && finished(r) && here !== 'history' && here !== originTab(r)) {
            const c = r.counts || {};
            const bad = r.status !== 'passed' || c.failed > 0;
            toast(`${label(r)} ${bad ? 'failed' : 'passed'}`, bad ? 'error' : 'ok', { sub: `${c.total ? `${c.passed} passed, ${c.failed} failed · ` : ''}click to see the execution`, duration: 8000, onClick: () => navigate({ section: 'history', run: r.id }) });
          }
          seen.current.set(r.id, r.status);
        }
        setBadges((b) => { const n = runs.filter((r) => !finished(r)).length; return b.history === n ? b : { ...b, history: n }; });
      } catch (_) { /* server restarting: try again on the next tick */ }
    };
    look();
    const t = setInterval(look, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [toast, navigate]);
  useEffect(() => {
    let alive = true;
    const look = async () => {
      try {
        const g = await api.git.status();
        if (alive) setBadges((b) => (b.git === (g.files || []).length ? b : { ...b, git: (g.files || []).length }));
      } catch (_) { /* not a repo, or busy */ }
    };
    look();
    const t = setInterval(look, 8000);
    window.addEventListener('focus', look);
    window.addEventListener('nevis-git-changed', look);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', look); window.removeEventListener('nevis-git-changed', look); };
  }, []);

  const popOut = useCallback((id) => {
    if (!openPopout(`section-${id}`, { kind: 'section', name: id })) toast('The browser blocked the new window. Allow pop-ups for this site and try again.', 'error');
  }, [toast]);
  const popOutLogs = useCallback(() => {
    const run = getActiveRun();
    if (!run) return toast('Start a run first: its output can then be opened in its own window.', 'info');
    if (!openPopout(`run-${run}`, { kind: 'run', run, view: 'logs' })) toast('The browser blocked the new window. Allow pop-ups for this site and try again.', 'error');
  }, [toast]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setCollapsed((c) => !c);
      } else if (isShortcut(e, 'KeyO')) {
        e.preventDefault();
        popOut(section);
      } else if (isShortcut(e, 'KeyL')) {
        e.preventDefault();
        popOutLogs();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setCollapsed, popOut, popOutLogs, section]);

  return (
    <>
      <div className={`app ${collapsed ? 'nav-collapsed' : ''}`}>
        <aside className="nav" aria-label="Primary">
          <div className="nav-head">
            <NevisLogo />
            <span className="nav-title">Test dashboard</span>
            <button
              type="button"
              className="icon-btn md nav-toggle"
              onClick={() => setCollapsed((c) => !c)}
              title={collapsed ? 'Expand sidebar (Ctrl/⌘ B)' : 'Collapse sidebar (Ctrl/⌘ B)'}
              aria-label="Toggle sidebar"
              aria-expanded={!collapsed}
            >
              <LuMenu size={18} />
            </button>
          </div>
          <button type="button" className="nav-search" onClick={() => setSearchOpen(true)} title="Search everything (Ctrl/⌘ K)">
            <LuSearch size={16} />
            <span className="nav-item-label">Search</span>
            <kbd className="nav-item-label">{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <nav className="nav-items">
            {NAV.map(({ id, label, icon: Icon }) => (
              <div key={id} className="nav-row">
                <button
                  type="button"
                  className={`nav-item ${section === id ? 'active' : ''}`}
                  onClick={() => setSection(id)}
                  title={collapsed ? label : undefined}
                  aria-current={section === id ? 'page' : undefined}
                >
                  <Icon size={18} className="nav-item-icon" />
                  <span className="nav-item-label">{label}</span>
                  {badges[id] > 0 && (
                    <span className={`nav-badge ${id}`} title={id === 'git' ? `${badges[id]} uncommitted change${badges[id] === 1 ? '' : 's'}` : `${badges[id]} run${badges[id] === 1 ? '' : 's'} in progress`}>
                      {badges[id] > 99 ? '99+' : badges[id]}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="nav-item-pop"
                  onClick={() => popOut(id)}
                  title={`Open ${label} in a separate window${section === id ? ` (${shortcutLabel('O')})` : ''}`}
                  aria-label={`Open ${label} in a separate window`}
                >
                  <LuSquareArrowOutUpRight size={14} />
                </button>
              </div>
            ))}
          </nav>
          <div className="nav-foot">
            <OcSessionHost collapsed={collapsed} />
          </div>
        </aside>

        {/* All sections stay mounted (just hidden) so switching tabs never loses a
            half-built test case or a live test run's state. */}
        <main className="app-body">
          <div className="app-pane" hidden={section !== 'explorer'}>
            <CreateTestView active={section === 'explorer'} mode="explore" />
          </div>
          <div className="app-pane" hidden={section !== 'tests'}>
            <TestsView />
          </div>
          <div className="app-pane" hidden={section !== 'history'}>
            <HistoryView active={section === 'history'} />
          </div>
          <div className="app-pane" hidden={section !== 'settings'}>
            <SettingsView active={section === 'settings'} />
          </div>
          <div className="app-pane" hidden={section !== 'git'}>
            <GitView active={section === 'git'} />
          </div>
          <div className="app-pane" hidden={section !== 'deployments'}>
            <DeploymentsView />
          </div>
        </main>
      </div>
      {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} onNavigate={navigate} />}
    </>
  );
}
