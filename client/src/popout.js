// Separate windows: any view, and the live output of a run, can be opened in its own browser window so it
// can sit on another screen. A pop-out is this same app loaded with ?popout=..., talking to the same server.

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export const isPopout = () => new URLSearchParams(window.location.search).has('popout');

// Ctrl+Alt+<key> (⌘⌥<key> on a Mac): free in the major browsers, unlike Ctrl+Shift+O and friends.
export const shortcutLabel = (key) => (isMac ? `⌘⌥${key}` : `Ctrl+Alt+${key}`);
export const isShortcut = (e, code) => (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.code === code;

export function popoutUrl(params) {
  return `${window.location.origin}/?${new URLSearchParams({ popout: '1', ...params })}`;
}

// Returns the new window, or null when the browser blocked it. Re-using the same key focuses the window
// that is already open instead of piling up copies.
export function openPopout(key, params, { width = 1280, height = 840 } = {}) {
  const left = Math.max(0, (window.screenX || 0) + 60);
  const top = Math.max(0, (window.screenY || 0) + 60);
  const w = window.open(popoutUrl(params), `nevis-popout-${key}`, `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
  if (w) w.focus();
  return w;
}

/* what the "current run" is, so the keyboard shortcut can pop out its logs from anywhere */
let activeRun = null;
export const setActiveRun = (id) => { activeRun = id || activeRun; };
export const getActiveRun = () => activeRun;
