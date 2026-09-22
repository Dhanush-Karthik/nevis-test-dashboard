import React, { useCallback, useEffect, useState } from 'react';
import { LuFingerprint, LuLoader, LuRefreshCw } from 'react-icons/lu';
import { api } from './api.js';
import { Field, IconButton } from './ui.jsx';

// The suite starts this same podman container itself for an eid-labelled run (lib/eid_helper.py).
// Lets a dev start/stop it here instead of a separate terminal - including booting the podman
// machine VM first if that's why it can't be reached - and see whether it's already up before
// running an eid scenario. Used from both Run tests and the Explorer's Test scenario dialog.
export default function AusweisAppControl() {
  const [state, setState] = useState({ status: 'stopped' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.ausweisApp.status().then(setState).catch((e) => setState({ status: 'unavailable', error: e.message }));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const toggle = async () => {
    setBusy(true);
    try {
      setState(state.status === 'running' ? await api.ausweisApp.stop() : await api.ausweisApp.start());
    } catch (e) {
      setState({ status: 'unavailable', error: e.message });
    } finally {
      setBusy(false);
    }
  };

  const running = state.status === 'running';
  const hint = busy && !running
    ? "Starting… if podman itself isn't running yet, this also boots it, which can take a minute the first time."
    : state.status === 'unavailable'
      ? state.error || "Couldn't reach podman from the dashboard."
      : state.machineDown
        ? "Podman isn't running - Start will boot it automatically."
        : 'Only needed if an eid-labelled scenario actually runs.';

  return (
    <Field
      label="eID simulator (AusweisApp2)"
      hint={hint}
      right={<IconButton size="xs" icon={<LuRefreshCw size={13} className={busy ? 'spin' : ''} />} title="Refresh" onClick={load} disabled={busy} />}
    >
      <div className="ausweis-row">
        <span className={`sdot ${running ? 's-passed' : state.status === 'unavailable' ? 's-failed' : ''}`} />
        <span className="ausweis-status">{running ? `Running on localhost:${state.port || 24727}` : state.status === 'unavailable' ? 'Unavailable' : 'Stopped'}</span>
        <span className="spacer" />
        <button type="button" className={`btn sm ${running ? 'danger-ghost' : ''}`} onClick={toggle} disabled={busy || state.status === 'unavailable'}>
          {busy ? <LuLoader size={13} className="spin" /> : <LuFingerprint size={13} />} {running ? 'Stop' : 'Start'}
        </button>
      </div>
    </Field>
  );
}
