const request = async (path, options = {}) => {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || response.statusText);
    err.status = response.status;
    throw err;
  }
  return data;
};

export const fetchCampuses = () => request('/api/campuses');

export const fetchStudentProfile = (login) =>
  request(`/api/students/${encodeURIComponent(login)}/profile`);

// Single-campus holders stream as newline-delimited JSON (see server/index.js) so the first
// upstream page's worth of cards can render immediately instead of waiting on the whole
// campus — `onChunk` fires with each batch as it arrives, in addition to the final resolved
// `{ achievement, holders }` covering the complete list once the stream ends. The grouped
// "All Morocco" view (no campusId) is unchanged: one plain JSON response.
export const fetchAchievementHolders = async (name, campusId = null, { refresh = false, onChunk } = {}) => {
  const url =
    `/api/achievements/holders?name=${encodeURIComponent(name)}` +
    (campusId ? `&campus=${campusId}` : '') +
    (refresh ? '&refresh=1' : '');

  if (!campusId) { return request(url); }

  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const err = new Error(data.error || response.statusText);
    err.status = response.status;
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let holders = [];
  let achievement = null;

  const handleLine = (line) => {
    if (!line) { return; }
    const msg = JSON.parse(line);
    if (msg.type === 'chunk') {
      holders = holders.concat(msg.holders);
      onChunk?.(msg.holders);
    } else if (msg.type === 'done') {
      achievement = msg.achievement;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) { break; }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(handleLine);
  }
  if (buffer) { handleLine(buffer); }

  return { achievement, holders };
};

export const fetchAchievedDate = (login, name) =>
  request(`/api/achievements/achieved-date?login=${encodeURIComponent(login)}&name=${encodeURIComponent(name)}`);

// Tétouan/Rabat have no holders of the croissant achievement, so this is the substitute
// "visited Paris" signal for those two campuses: students who have Paris on their profile.
// The server awaits the scan directly and caches the result per campus (first request pays
// the scan cost — can take up to a minute — every request after that within the cache
// window is instant), so this single call either returns fast or takes a while; there's
// nothing to poll for.
export const fetchCampusParisAdders = (campusId, { refresh = false } = {}) =>
  request(`/api/campuses/${campusId}/paris-adders${refresh ? '?refresh=1' : ''}`);

export const fetchAllCampusParisAdders = (campusId, onProgress, { refresh = false } = {}) => {
  onProgress?.([], true);
  return fetchCampusParisAdders(campusId, { refresh }).then((res) => res.adders);
};

// Students who still hold this achievement but vanished from the normal per-campus holders
// list because their primary campus is now Paris (42's API filters holders by CURRENT
// primary campus). One call for the whole achievement — scoped to this-year holders only
// (not a full campus roster scan) — each result tagged with `campusId`, the Moroccan campus
// they're originally from, so the client can bucket them into the right section.
export const fetchAchievementParisSwitchers = (name, { refresh = false } = {}) =>
  request(
    `/api/achievements/paris-switchers?name=${encodeURIComponent(name)}` +
      (refresh ? '&refresh=1' : ''),
  );

// Auth — visitors log in with their own 42 account (authorization_code flow); every data
// route above requires this session and uses the visitor's own access token server-side.
export const LOGIN_URL = '/api/auth/login';

export const fetchMe = () => request('/api/auth/me');

export const logout = () => request('/api/auth/logout', { method: 'POST' });
