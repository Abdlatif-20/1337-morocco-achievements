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

// Auth — visitors log in with their own 42 account (authorization_code flow); every data
// route above requires this session and uses the visitor's own access token server-side.
export const LOGIN_URL = '/api/auth/login';

export const fetchMe = () => request('/api/auth/me');

export const logout = () => request('/api/auth/logout', { method: 'POST' });
