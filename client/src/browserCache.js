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

// Tracks how many times a rate-limited action (e.g. the Refresh button) has been used within
// a rolling time window, persisted in localStorage so the limit survives a page reload —
// it's a per-visitor client-side throttle, not a security boundary (nothing stops someone
// from clearing localStorage), just a guard against accidentally hammering the API.
export const getRecentUses = (key, windowMs) => {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    const timestamps = raw ? JSON.parse(raw) : [];
    return timestamps.filter((t) => Date.now() - t < windowMs);
  } catch {
    return [];
  }
};

export const recordUse = (key, windowMs) => {
  const recent = getRecentUses(key, windowMs);
  recent.push(Date.now());
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(recent));
  } catch {
    // Storage full/unavailable — worst case the limit just doesn't persist across reloads.
  }
  return recent;
};
