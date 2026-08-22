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

export const fetchAchievementHolders = (name, campusId = null, { refresh = false } = {}) =>
  request(
    `/api/achievements/holders?name=${encodeURIComponent(name)}` +
      (campusId ? `&campus=${campusId}` : '') +
      (refresh ? '&refresh=1' : ''),
  );

export const fetchAchievedDate = (login, name) =>
  request(`/api/achievements/achieved-date?login=${encodeURIComponent(login)}&name=${encodeURIComponent(name)}`);

// Tétouan/Rabat have no holders of the croissant achievement, so this is the substitute
// "visited Paris" signal for those two campuses: students who have Paris on their profile.
// The server scans and caches the full result per campus (first request triggers it,
// subsequent ones are instant) — this just reads the current cache state: `ready: true`
// once the scan behind it has finished, `adders` populated so far either way.
export const fetchCampusParisAdders = (campusId) =>
  request(`/api/campuses/${campusId}/paris-adders`);

// Polls fetchCampusParisAdders until the server reports the scan is done, calling onProgress
// after every poll so a still-warming cache doesn't just look like a frozen spinner.
export const fetchAllCampusParisAdders = async (campusId, onProgress) => {
  for (;;) {
    const res = await fetchCampusParisAdders(campusId);
    onProgress?.(res.adders, !res.ready);
    if (res.ready) { return res.adders; }
    await new Promise((r) => setTimeout(r, 5000));
  }
};

// Auth — visitors log in with their own 42 account (authorization_code flow); every data
// route above requires this session and uses the visitor's own access token server-side.
export const LOGIN_URL = '/api/auth/login';

export const fetchMe = () => request('/api/auth/me');

export const logout = () => request('/api/auth/logout', { method: 'POST' });
