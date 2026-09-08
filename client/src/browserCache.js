// Persists small JSON blobs in localStorage with a TTL, so a page reload can render
// instantly from what's already known instead of re-hitting the API — mirrors the server's
// own in-memory caches (see server/index.js) so both layers expire together. Wrapped in
// try/catch throughout: localStorage can throw (private browsing, quota, disabled storage)
// and none of that should ever break the app, just fall back to "no cache".
const PREFIX = '1337-cache:';

export const readCache = (key, ttlMs) => {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) { return null; }
    const { value, cachedAt } = JSON.parse(raw);
    if (Date.now() - cachedAt > ttlMs) { return null; }
    return value;
  } catch {
    return null;
  }
};

export const writeCache = (key, value) => {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ value, cachedAt: Date.now() }));
  } catch {
    // Storage full/unavailable — the app still works, just without the speedup.
  }
};
