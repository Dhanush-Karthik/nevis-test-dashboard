import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LuCircleAlert, LuExternalLink, LuKeyRound, LuLoader, LuLogIn, LuServer } from 'react-icons/lu';
import { api } from './api.js';
import { Field, Modal, useLocalState, useToast } from './ui.jsx';

const PASSCODE_URL = 'https://iam.cloud.ibm.com/identity/passcode';

// Views call this to reload their cluster data right after a successful login.
export function useOnOcLogin(cb) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const h = () => ref.current && ref.current();
    window.addEventListener('oc-logged-in', h);
    return () => window.removeEventListener('oc-logged-in', h);
  }, []);
}

function LoginDialog({ session, reason, onClose, onDone }) {
  const toast = useToast();
  const [server, setServer] = useLocalState('oc.server', '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const shownServer = server || session?.server || '';

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.ocLogin(shownServer, code);
      setServer(shownServer);
      setCode('');
      toast(`Logged in to the cluster as ${r.user}`);
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Log in to OpenShift"
      icon={<LuLogIn size={16} />}
      width={520}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={submit} disabled={busy || !code.trim() || !shownServer.trim()}>
            {busy ? <LuLoader size={14} className="spin" /> : <LuLogIn size={14} />} Log in
          </button>
        </>
      }
    >
      <div className="stack">
        <div className={`notice ${reason ? 'warn' : ''}`}>
          <LuCircleAlert size={15} />
          <div>{reason || 'Your OpenShift login lasts about 24 hours. Log in again with a one-time passcode; nothing is stored.'}</div>
        </div>
        <Field label="Cluster address" hint="host:port of the OpenShift API server. Remembered in this browser.">
          <div className="search-box">
            <LuServer size={14} className="search-box-icon" />
            <input value={shownServer} onChange={(e) => setServer(e.target.value)} placeholder="my-cluster.example.com:6443" spellCheck={false} autoComplete="off" />
          </div>
        </Field>
        <Field
          label="One-time passcode"
          hint={<>Get a code from <a href={PASSCODE_URL} target="_blank" rel="noreferrer" className="link-btn">the passcode page <LuExternalLink size={11} /></a>, then paste it here.</>}
        >
          <div className="search-box">
            <LuKeyRound size={14} className="search-box-icon" />
            <input
              autoFocus
              type="password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="Paste the passcode"
              spellCheck={false}
              autoComplete="one-time-code"
            />
          </div>
        </Field>
        {error && <div className="notice danger"><LuCircleAlert size={15} /><div>{error}</div></div>}
      </div>
    </Modal>
  );
}

// Sidebar status (logged in / expired) plus the login dialog; the dialog also opens by itself when any
// cluster call fails because the login has expired.
export default function OcSessionHost({ collapsed }) {
  const [session, setSession] = useState(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  const refresh = useCallback(async () => {
    try {
      setSession(await api.ocSession());
    } catch (_) {
      /* keep the last known state */
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5 * 60 * 1000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  useEffect(() => {
    const onNeeded = () => {
      setReason('Your OpenShift login has expired. Log in again to continue.');
      setOpen(true);
      refresh();
    };
    window.addEventListener('oc-login-required', onNeeded);
    return () => window.removeEventListener('oc-login-required', onNeeded);
  }, [refresh]);

  if (!session || !session.ocInstalled) return null;
  const ok = session.loggedIn;
  const label = ok ? `Cluster: ${session.user}` : 'Cluster login expired';

  return (
    <>
      <button
        type="button"
        className={`oc-chip ${ok ? 'ok' : 'expired'}`}
        onClick={() => { setReason(ok ? '' : 'Your OpenShift login has expired. Log in again to continue.'); setOpen(true); }}
        title={ok ? `Logged in to the cluster as ${session.user}. Click to log in again.` : 'Your OpenShift login has expired. Click to log in again.'}
      >
        <span className="oc-dot" />
        {!collapsed && <span className="oc-chip-text">{label}</span>}
        {!collapsed && !ok && <span className="oc-chip-action">Log in</span>}
      </button>
      {open && (
        <LoginDialog
          session={session}
          reason={reason}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            refresh();
            window.dispatchEvent(new CustomEvent('oc-logged-in'));
          }}
        />
      )}
    </>
  );
}
