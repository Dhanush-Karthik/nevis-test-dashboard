import React, { useEffect } from 'react';
import { LuKeyRound, LuSettings, LuSlidersHorizontal } from 'react-icons/lu';
import DefaultsView from './DefaultsView.jsx';
import EnvView from './EnvView.jsx';
import { Segmented, useLocalState } from './ui.jsx';

// Global settings of the integration-test project: the shared default configs and the .env file.
// Both editors stay mounted (just hidden) so unsaved edits survive switching between them.
export default function SettingsView({ active = true }) {
  const [tab, setTab] = useLocalState('settings.tab', 'defaults');
  const current = tab === 'env' ? 'env' : 'defaults';
  useEffect(() => {
    const onNav = (e) => { const n = e.detail || {}; if (n.section === 'settings' && n.tab) setTab(n.tab); };
    window.addEventListener('nevis-nav', onNav);
    return () => window.removeEventListener('nevis-nav', onNav);
  }, [setTab]);
  return (
    <div className="view col">
      <div className="tabstrip">
        <LuSettings size={15} className="muted" />
        <span className="tabstrip-title">Settings</span>
        <Segmented
          size="sm"
          block={false}
          value={current}
          onChange={setTab}
          options={[
            { value: 'defaults', label: 'Default configs', icon: <LuSlidersHorizontal size={13} /> },
            { value: 'env', label: '.env', icon: <LuKeyRound size={13} /> },
          ]}
        />
      </div>
      <div className="settings-pane" hidden={current !== 'defaults'}>
        <DefaultsView active={active && current === 'defaults'} />
      </div>
      <div className="settings-pane" hidden={current !== 'env'}>
        <EnvView active={active && current === 'env'} />
      </div>
    </div>
  );
}
