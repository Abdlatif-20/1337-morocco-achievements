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

// Single-campus holders are paginated server-side: only enough upstream 42 API pages get
// fetched to cover the requested page/pageSize (see server/index.js) — the client only ever
// receives the one page it asked for, not the whole campus. The grouped "All Morocco" view
// (no campusId) is unpaginated, unchanged: one plain JSON response with every campus's full
// list.
export const fetchAchievementHolders = (name, campusId = null, { refresh = false, page, pageSize, promo } = {}) =>
  request(
    `/api/achievements/holders?name=${encodeURIComponent(name)}` +
      (campusId ? `&campus=${campusId}` : '') +
      (campusId && page ? `&page=${page}` : '') +
      (campusId && pageSize ? `&pageSize=${pageSize}` : '') +
      (campusId && promo ? `&promo=${encodeURIComponent(promo)}` : '') +
      (refresh ? '&refresh=1' : ''),
  );

export const fetchAchievedDate = (login, name) =>
  request(`/api/achievements/achieved-date?login=${encodeURIComponent(login)}&name=${encodeURIComponent(name)}`);

// Tétouan/Rabat have no holders of the croissant achievement, so this is the substitute
// "visited Paris" signal for those two campuses: students who have Paris on their profile.
// Paginated server-side like the achievement holders route: only as many roster pages as
// needed to cover the requested page/size get scanned (see server/index.js) — a request can
// still take a while on a cold cache since Paris-adders is a sparse signal (finding even 10
// of them can mean scanning most of a campus's roster), but a warm cache is instant.
export const fetchCampusParisAdders = (campusId, { refresh = false, page, pageSize, promo } = {}) =>
  request(
    `/api/campuses/${campusId}/paris-adders?` +
      new URLSearchParams({
        ...(page ? { page } : {}),
        ...(pageSize ? { pageSize } : {}),
        ...(promo ? { promo } : {}),
        ...(refresh ? { refresh: '1' } : {}),
      }),
  );

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
