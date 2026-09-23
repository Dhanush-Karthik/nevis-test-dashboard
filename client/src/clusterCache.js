'use strict';

// A namespace/pod list barely changes - there's no reason to hit the cluster every time a panel
// mounts, a modal reopens, or a checkbox is toggled. These helpers persist what was last fetched
// (per environment, and pods per namespace) so it comes back instantly next time; callers only
// hit the network on first-ever use, an explicit refresh, or when a fetch actually fails (a real
// sign the cached list is stale - a deleted namespace, a pod that got rescheduled under a new
// name, ...).

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    /* storage unavailable - just means this stays uncached */
  }
}

export const nsCacheKey = (env) => `nevis.cache.namespaces.${env}`;
export const podCacheKey = (env, ns) => `nevis.cache.pods.${env}.${ns}`;

export const readCache = read;
export const writeCache = write;
