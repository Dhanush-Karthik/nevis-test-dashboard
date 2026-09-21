import React, { useCallback, useEffect, useState } from 'react';
import { LuBoxes, LuFlaskConical, LuFolderTree, LuGitBranch, LuMenu, LuSettings, LuSquareArrowOutUpRight, LuSquarePen } from 'react-icons/lu';
import TestsView from './TestsView.jsx';
import DeploymentsView from './DeploymentsView.jsx';
import CreateTestView from './CreateTestView.jsx';
import GitView from './GitView.jsx';
import logoUrl from './assets/nevis-logo.png';
import SettingsView from './SettingsView.jsx';
import OcSessionHost from './OcSession.jsx';
import { getActiveRun, isShortcut, openPopout, shortcutLabel } from './popout.js';
import { ToastProvider, useLocalState, useToast } from './ui.jsx';

const NAV = [
  { id: 'explorer', label: 'Explorer', icon: LuFolderTree },
  { id: 'tests', label: 'Run tests', icon: LuFlaskConical },
  { id: 'create', label: 'Create new test', icon: LuSquarePen },
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
  const section = storedSection === 'defaults' || storedSection === 'env' ? 'settings' : storedSection; // tabs merged into Settings
  const [collapsed, setCollapsed] = useLocalState('navCollapsed', false);

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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && !e.shiftKey && !e.altKey) {
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
          <div className="app-pane" hidden={section !== 'settings'}>
            <SettingsView active={section === 'settings'} />
          </div>
          <div className="app-pane" hidden={section !== 'git'}>
            <GitView active={section === 'git'} />
          </div>
          <div className="app-pane" hidden={section !== 'deployments'}>
            <DeploymentsView />
          </div>
          <div className="app-pane" hidden={section !== 'create'}>
            <CreateTestView active={section === 'create'} mode="create" />
          </div>
        </main>
      </div>
    </>
  );
}
