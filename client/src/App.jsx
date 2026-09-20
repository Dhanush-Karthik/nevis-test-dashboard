import React, { useEffect, useState } from 'react';
import { LuBoxes, LuFlaskConical, LuFolderTree, LuGitBranch, LuMenu, LuSquarePen } from 'react-icons/lu';
import TestsView from './TestsView.jsx';
import DeploymentsView from './DeploymentsView.jsx';
import CreateTestView from './CreateTestView.jsx';
import GitView from './GitView.jsx';
import logoUrl from './assets/nevis-logo.png';
import { ToastProvider, useLocalState } from './ui.jsx';

const NAV = [
  { id: 'explorer', label: 'Explorer', icon: LuFolderTree },
  { id: 'tests', label: 'Run tests', icon: LuFlaskConical },
  { id: 'create', label: 'Create new test', icon: LuSquarePen },
  { id: 'git', label: 'Git', icon: LuGitBranch },
  { id: 'deployments', label: 'Deployments', icon: LuBoxes },
];

// Official Nevis mark (cropped from the brand logo); sits on a white tile so its colours stay true on the dark theme.
function NevisLogo({ size = 30 }) {
  return <img className="nevis-logo" src={logoUrl} width={size} height={size} alt="Nevis" draggable={false} />;
}

export default function App() {
  const [section, setSection] = useLocalState('section', 'explorer');
  const [collapsed, setCollapsed] = useLocalState('navCollapsed', false);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setCollapsed]);

  return (
    <ToastProvider>
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
              <button
                key={id}
                type="button"
                className={`nav-item ${section === id ? 'active' : ''}`}
                onClick={() => setSection(id)}
                title={collapsed ? label : undefined}
                aria-current={section === id ? 'page' : undefined}
              >
                <Icon size={18} className="nav-item-icon" />
                <span className="nav-item-label">{label}</span>
              </button>
            ))}
          </nav>
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
    </ToastProvider>
  );
}
