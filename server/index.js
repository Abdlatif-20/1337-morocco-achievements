import 'dotenv/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import express from 'express';
import cors from 'cors';
import { MOROCCAN_CAMPUSES } from './campuses.js';
import {
  getSession,
  setSessionCookie,
  clearSessionCookie,
  setOAuthStateCookie,
  getOAuthStateCookie,
  clearOAuthStateCookie,
} from './session.js';

const PORT = process.env.PORT || 4000;
const API_BASE = 'https://api.intra.42.fr/v2';
const AUTHORIZE_URL = 'https://api.intra.42.fr/oauth/authorize';
const TOKEN_URL = 'https://api.intra.42.fr/oauth/token';

// 42's API rate-limits at ~2 req/s — every outgoing call is chained through this queue so
// concurrent requests from the frontend don't burst past that limit.
const MIN_INTERVAL_MS = 550;
let queue = Promise.resolve();
let lastDispatch = 0;

const throttle = () => {
  const dispatch = queue.then(async () => {
    const wait = Math.max(0, lastDispatch + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) { await new Promise((r) => setTimeout(r, wait)); }
    lastDispatch = Date.now();
  });
  queue = dispatch;
  return dispatch;
};

// Holds the CURRENT VISITOR's own access token for the duration of one request. Every data
// route runs inside `requestContext.run({ token }, ...)` (set by the `requireAuth`
// middleware below) so apiGetOnce can read the right token without every helper function in
// this file (fetchUserRaw, fetchAllPages, etc.) needing a token parameter threaded through
// by hand. This is the mechanism that makes 42 API calls run AS the logged-in visitor,
// instead of the app's own client_credentials token — per the explicit requirement that
// data be fetched using each visitor's own 42 account, not the app owner's.
const requestContext = new AsyncLocalStorage();

const apiGetOnce = async (path, tokenOverride) => {
  await throttle();
  const token = tokenOverride || requestContext.getStore()?.token;
  if (!token) { const err = new Error('NO_REQUEST_TOKEN'); err.status = 401; throw err; }

  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const total = response.headers.get('x-total');
  // On a 429, 42's API tells us the REAL cooldown via Retry-After — verified live this can
  // be anywhere from ~14 minutes to ~47 minutes depending on how hard it's been hit. Blindly
  // retrying after a fixed short pause is useless against that and just wastes a slot.
  const retryAfterSeconds = Number(response.headers.get('retry-after')) || null;

  // Read as text first, not response.json() directly — under heavy scanning 42's API
  // occasionally returns a non-JSON body (rate-limit page, empty body, HTML error page).
  // Parsing that directly throws a raw "Unexpected non-whitespace character..." JSON error
  // that hides the real HTTP status; this surfaces a clear message instead.
  const rawText = await response.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    const err = new Error(
      `42's API returned a non-JSON response (HTTP ${response.status}): ${rawText.slice(0, 200)}`,
    );
    err.status = response.status >= 400 ? response.status : 502;
    err.retryAfterSeconds = retryAfterSeconds;
    throw err;
  }

  if (!response.ok) {
    const message = data?.message || response.statusText;
    const err = new Error(message);
    err.status = response.status;
    err.retryAfterSeconds = retryAfterSeconds;
    throw err;
  }
  return { data, total: total != null ? Number(total) : null };
};

// A single transient hiccup shouldn't blow up a request that may already be minutes into
// checking candidates — but ONLY when the wait is genuinely short. A long Retry-After (rate
// limit already tripped) is a hard stop: retrying just burns another slot and the whole
// request would otherwise hang for tens of minutes. Permanent client errors (400/401/403/404)
// are never retried at all.
const MAX_AUTO_RETRY_WAIT_SECONDS = 10;

const apiGet = async (path, tokenOverride) => {
  try {
    return await apiGetOnce(path, tokenOverride);
  } catch (err) {
    const isTransient = !err.status || err.status === 429 || err.status >= 500;
    if (!isTransient) { throw err; }
    if (err.retryAfterSeconds && err.retryAfterSeconds > MAX_AUTO_RETRY_WAIT_SECONDS) {
      err.message = `Rate limited by 42's API — try again in about ${Math.ceil(err.retryAfterSeconds / 60)} minute(s).`;
      throw err;
    }
    await new Promise((r) => setTimeout(r, (err.retryAfterSeconds ?? (err.status === 429 ? 3 : 1.5)) * 1000));
    return apiGetOnce(path, tokenOverride);
  }
};

// Full profile — the same shape and same endpoint (GET /v2/users/:login) used everywhere a
// student's complete data is needed.
const normalizeFullProfile = (data, coalitions) => {
  const mainCursus =
    data.cursus_users?.find((cu) => cu.cursus?.slug === '42cursus') ||
    data.cursus_users?.find((cu) => cu.cursus?.name?.toLowerCase().includes('42')) ||
    data.cursus_users?.[0] ||
    null;

  const primaryCampusId = data.campus_users?.find((cu) => cu.is_primary)?.campus_id;
  const primaryCampus =
    data.campus?.find((c) => c.id === primaryCampusId) ||
    data.campus?.[0] ||
    null;

  const skills = (mainCursus?.skills ?? [])
    .map((s) => ({ id: s.id, name: s.name, level: s.level }))
    .sort((a, b) => b.level - a.level);

  const projects = (data.projects_users ?? [])
    .filter((pu) => pu.project?.name && pu.status !== 'parent')
    .map((pu) => ({
      id: pu.id,
      name: pu.project.name,
      status: pu.status,
      validated: pu['validated?'],
      finalMark: pu.final_mark,
    }))
    .sort((a, b) => {
      if (a.status === 'finished' && b.status !== 'finished') { return -1; }
      if (a.status !== 'finished' && b.status === 'finished') { return 1; }
      return a.name.localeCompare(b.name);
    });

  // A student can be affiliated with more than one campus (transfers, multi-campus
  // programs) — `data.campus` from /v2/users/:login carries all of them.
  const campuses = (data.campus ?? []).map((c) => ({ id: c.id, name: c.name, country: c.country }));

  return {
    id: data.id,
    login: data.login,
    displayName: data.usual_full_name || data.displayname || data.login,
    email: data.email || 'N/A',
    phone: data.phone || null,
    wallet: data.wallet ?? 0,
    correctionPoints: data.correction_point ?? 0,
    location: data.location || null,
    active: data['active?'] ?? false,
    isStaff: data['staff?'] ?? false,
    imageUrl: data.image?.link || data.image?.versions?.large || null,
    campus: primaryCampus?.name || 'N/A',
    country: primaryCampus?.country || 'N/A',
    campuses,
    level: mainCursus?.level ?? 0,
    grade: mainCursus?.grade || null,
    coalitionColor: coalitions[0]?.color || null,
    coalitionName: coalitions[0]?.name || null,
    skills,
    projects,
  };
};

const fetchUserRaw = (login) => apiGet(`/users/${encodeURIComponent(login)}`).then((r) => r.data);
const fetchCoalitionsRaw = (login) =>
  apiGet(`/users/${encodeURIComponent(login)}/coalitions`).then((r) => r.data).catch(() => []);

const fetchFullProfile = async (login) => {
  const [user, coalitions] = await Promise.all([fetchUserRaw(login), fetchCoalitionsRaw(login)]);
  return normalizeFullProfile(user, coalitions);
};

const fetchAllPages = async (path, { maxPages = 6, pageSize = 100, tokenOverride } = {}) => {
  const results = [];
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const { data } = await apiGet(`${path}${sep}page[size]=${pageSize}&page[number]=${pageNum}`, tokenOverride);
    if (!Array.isArray(data) || data.length === 0) { break; }
    results.push(...data);
    if (data.length < pageSize) { break; }
  }
  return results;
};

// Achievement lookup by name, then the users who hold it. Per 42's official apidoc
// (achievements/index + achievements_users/index): GET /v2/achievements returns
// {id, name, description, tier, kind, users_url, ...}, and GET /v2/achievements/:id/users
// returns the users who earned it.
let achievementsCache = null;

const getAllAchievements = async () => {
  if (achievementsCache) { return achievementsCache; }
  const raw = await fetchAllPages('/achievements', { maxPages: 5 });
  achievementsCache = raw.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description || null,
    tier: a.tier || null,
    kind: a.kind || null,
    nbrOfSuccess: a.nbr_of_success ?? null,
  }));
  return achievementsCache;
};

const findAchievementByName = async (name) => {
  const achievements = await getAllAchievements();
  const target = name.trim().toLowerCase();
  return achievements.find((a) => a.name?.trim().toLowerCase() === target) || null;
};

// Defensive about the item shape — handles either a raw user object or a {user: {...}} join
// wrapper.
const mapAchievementHolder = (item) => {
  const u = item.user || item;
  return {
    id: u.id,
    login: u.login,
    displayName: u.usual_full_name || u.displayname || u.login,
    imageUrl: u.image?.link || u.image?.versions?.medium || null,
    // The promo/cohort a student joined in — used for the client-side promo filter. 42's
    // API has no gender/sex field anywhere (checked live against a full user object), so
    // that filter genuinely isn't buildable here.
    poolYear: u.pool_year || null,
  };
};

// Raw holder objects from GET /v2/achievements/:id/users already carry `kind`/`staff?` —
// verified live (mika/giuseppe both showed kind:"admin", staff?:true). Filtering these out
// costs nothing extra: no per-holder call needed, just reading fields already in hand.
const isStaffHolder = (item) => {
  const u = item.user || item;
  return u['staff?'] === true || (u.kind && u.kind !== 'student');
};

// Server-side "achieved this year" filter. GET /v2/achievements_users supports
// filter[achievement_id] AND range[created_at] directly (verified live) — one paginated
// query gets every this-year achiever's login in a handful of calls, no per-holder lookup.
const fetchThisYearLogins = async (achievementId) => {
  const year = new Date().getFullYear();
  const raw = await fetchAllPages(
    `/achievements_users?filter[achievement_id]=${achievementId}` +
      `&range[created_at]=${year}-01-01T00:00:00.000Z,${year + 1}-01-01T00:00:00.000Z`,
    { maxPages: 15 },
  );
  return new Set(raw.map((r) => r.login));
};

// The unlock date lives on the join record, not the achievement or the user — verified
// live: GET /v2/achievements_users?filter[user_id]=X&filter[achievement_id]=Y returns
// created_at (e.g. "2026-03-27T11:28:02.104Z"), the real moment that achievement was earned.
const fetchAchievedAt = async (userId, achievementId) => {
  const { data } = await apiGet(
    `/achievements_users?filter[user_id]=${userId}&filter[achievement_id]=${achievementId}`,
  );
  return Array.isArray(data) && data[0]?.created_at ? data[0].created_at : null;
};

// --- Tétouan/Rabat: students who have Paris on their profile ---------------------------
// Neither Tétouan nor Rabat has ever had a holder of "Je voudrais un croissant" (verified
// live — both always come back empty), so for those two campuses the achievement itself
// can't be used as a "visited Paris" signal.
//
// This is the one deliberate exception to "every 42 API call runs as the visitor" (see
// CLAUDE.md): GET /v2/campus_users?filter[user_id]=a,b,c batches this check for ~100
// students in a single call, but 403s under an ordinary visitor's `scope: public` token —
// verified live it works fine under this app's own client_credentials token, which has
// broader access. The data behind it (campus rosters, which campuses a student belongs to)
// isn't visitor-specific or sensitive — it's the same public directory info every visitor
// can already see elsewhere in this app — so running this one aggregate lookup as the app
// itself, instead of forcing a ~10-minute one-profile-at-a-time scan under a visitor's
// token, is a reasonable trade. Every other route is untouched and still visitor-scoped.
//
// Cached per campus with a TTL (same pattern as achievementHoldersCache below) — NOT a
// fire-and-forget background job. An earlier version kicked the scan off detached and had
// the route return immediately, relying on the client to poll until it finished; that works
// on a persistent Node process (local dev) but silently never completes on Vercel, because a
// serverless function can be frozen right after it sends its response, killing any detached
// work that hasn't finished — verified live in prod (the route kept responding "still
// scanning" forever). Awaiting the scan directly, inside the request that needs it, is what
// actually guarantees it runs to completion, on both platforms.
const PARIS_CAMPUS_ID = 1;
const NO_ACHIEVEMENT_CAMPUS_IDS = [55, 75]; // Tétouan, Rabat — mirrors the client-side constant
const CAMPUS_NAME_LOOKUP = {
  [PARIS_CAMPUS_ID]: { id: PARIS_CAMPUS_ID, name: 'Paris', country: 'France' },
  ...Object.fromEntries(MOROCCAN_CAMPUSES.map((c) => [c.id, { id: c.id, name: c.name, country: 'Morocco' }])),
};

let appTokenCache = null; // { token, expiresAt }

const getAppToken = async () => {
  if (appTokenCache && Date.now() < appTokenCache.expiresAt - 60_000) {
    return appTokenCache.token;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.FT_CLIENT_ID,
    client_secret: process.env.FT_CLIENT_SECRET,
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) { throw new Error('APP_TOKEN_FAILED'); }
  const data = await response.json();
  appTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return appTokenCache.token;
};

const computeParisAdders = async (campusId) => {
  const token = await getAppToken();
  const roster = await fetchAllPages(`/campus/${campusId}/users`, { maxPages: 20, tokenOverride: token });
  const candidates = roster.filter((u) => !u['staff?']);
  const byId = new Map(candidates.map((u) => [u.id, u]));
  const adders = [];

  for (let i = 0; i < candidates.length; i += 100) {
    const chunk = candidates.slice(i, i + 100);
    const rows = await fetchAllPages(
      `/campus_users?filter[user_id]=${chunk.map((u) => u.id).join(',')}`,
      { maxPages: 3, tokenOverride: token },
    );
    for (const row of rows) {
      if (row.campus_id !== PARIS_CAMPUS_ID) { continue; }
      const u = byId.get(row.user_id);
      if (!u) { continue; }

      adders.push({
        id: u.id,
        login: u.login,
        displayName: u.usual_full_name || u.displayname || u.login,
        imageUrl: u.image?.link || u.image?.versions?.medium || null,
        campuses: [CAMPUS_NAME_LOOKUP[campusId], CAMPUS_NAME_LOOKUP[PARIS_CAMPUS_ID]],
        poolYear: u.pool_year || null,
      });
    }
  }
  return adders;
};

const PARIS_ADDERS_CACHE_TTL_MS = 60 * 60 * 1000; // hourly — this data changes rarely
const parisAddersCache = new Map(); // campusId -> { adders, cachedAt }

const getParisAdders = async (campusId, { bypassCache = false } = {}) => {
  const cached = parisAddersCache.get(campusId);
  if (!bypassCache && cached && Date.now() - cached.cachedAt < PARIS_ADDERS_CACHE_TTL_MS) {
    return cached.adders;
  }
  const adders = await computeParisAdders(campusId);
  parisAddersCache.set(campusId, { adders, cachedAt: Date.now() });
  return adders;
};

// Prewarmed at boot in local dev only — a Vercel function instance isn't a long-lived
// process, so there's no "boot" to hook; there the first real request to hit a cold cache
// just pays the scan cost itself (well within the 300s function timeout).
if (process.env.VERCEL !== '1') {
  for (const campusId of NO_ACHIEVEMENT_CAMPUS_IDS) {
    getParisAdders(campusId).catch(() => {});
  }
}

// --- Visitor OAuth (authorization_code grant) -------------------------------------------
// The app's FT_CLIENT_ID/FT_CLIENT_SECRET identify the same registered 42 API application
// as before, but every data-fetching request below runs using the VISITOR's own access
// token (obtained here), not an app-level client_credentials token — each visitor's calls
// are made as themselves against 42's API.
// In local dev, Vite's proxy rewrites the Host header to the proxy target (localhost:4000)
// before Express ever sees the request, so req.get('host') can't be trusted to reflect the
// browser's real origin — APP_ORIGIN overrides it when set. Not needed in production
// (Vercel has no such proxy in front of the function).
const getRedirectUri = (req) =>
  `${process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`}/api/auth/callback`;

const exchangeCodeForToken = async (code, redirectUri) => {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.FT_CLIENT_ID,
    client_secret: process.env.FT_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`AUTH_FAILED:${response.status}:${text}`);
  }
  return response.json();
};

const refreshAccessToken = async (refreshToken) => {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.FT_CLIENT_ID,
    client_secret: process.env.FT_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) { throw new Error('REFRESH_FAILED'); }
  return response.json();
};

// GET /v2/me right after the token exchange — unlike every data route below, this runs
// before requestContext exists, so it can't go through apiGet. It still needs the same
// throttle + 429 backoff: without it, a 429 here (this app's shared 2 req/s cap, easily hit
// if a visitor double-clicks Login or retries fast) fails instantly and every immediate
// retry 429s again since nothing ever backs off.
const fetchMe = async (accessToken) => {
  await throttle();
  const response = await fetch(`${API_BASE}/me`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (response.ok) { return response.json(); }

  if (response.status === 429) {
    const retryAfterSeconds = Number(response.headers.get('retry-after')) || 3;
    if (retryAfterSeconds <= MAX_AUTO_RETRY_WAIT_SECONDS) {
      await new Promise((r) => setTimeout(r, retryAfterSeconds * 1000));
      await throttle();
      const retryResponse = await fetch(`${API_BASE}/me`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      if (retryResponse.ok) { return retryResponse.json(); }
      const body = await retryResponse.text().catch(() => '');
      throw new Error(`ME_FETCH_FAILED:${retryResponse.status}:${body.slice(0, 300)}`);
    }
  }

  const body = await response.text().catch(() => '');
  throw new Error(`ME_FETCH_FAILED:${response.status}:${body.slice(0, 300)}`);
};

// Gates every data route: no session → 401 (client sends the visitor to /api/auth/login).
// Refreshes an expiring access token before use and rewrites the session cookie with the
// refreshed tokens, so a visitor doesn't get logged out just because their token aged out
// mid-session.
const requireAuth = async (req, res, next) => {
  const session = getSession(req);
  if (!session) { return res.status(401).json({ error: 'UNAUTHENTICATED' }); }

  let { accessToken, refreshToken, expiresAt, user } = session;
  if (Date.now() > expiresAt - 60_000) {
    try {
      const data = await refreshAccessToken(refreshToken);
      accessToken = data.access_token;
      refreshToken = data.refresh_token || refreshToken;
      expiresAt = Date.now() + (data.expires_in || 7200) * 1000;
      setSessionCookie(res, { accessToken, refreshToken, expiresAt, user });
    } catch {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'SESSION_EXPIRED' });
    }
  }

  requestContext.run({ token: accessToken }, () => next());
};

const app = express();
app.set('trust proxy', true); // Vercel terminates TLS in front of the function; needed so req.protocol reflects the real https scheme for the OAuth redirect_uri.
app.use(cors());

app.get('/api/campuses', (req, res) => {
  res.json(MOROCCAN_CAMPUSES);
});

app.get('/api/auth/login', (req, res) => {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  setOAuthStateCookie(res, state);
  const params = new URLSearchParams({
    client_id: process.env.FT_CLIENT_ID,
    redirect_uri: getRedirectUri(req),
    response_type: 'code',
    scope: 'public',
    state,
  });
  res.redirect(`${AUTHORIZE_URL}?${params}`);
});

app.get('/api/auth/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  if (oauthError) { return res.redirect(`/?authError=${encodeURIComponent(String(oauthError))}`); }

  const expectedState = getOAuthStateCookie(req);
  clearOAuthStateCookie(res);
  if (!code || !state || state !== expectedState) {
    return res.redirect('/?authError=invalid_state');
  }

  try {
    const tokenData = await exchangeCodeForToken(code, getRedirectUri(req));
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresAt = Date.now() + (tokenData.expires_in || 7200) * 1000;

    const me = await fetchMe(accessToken);
    const user = {
      id: me.id,
      login: me.login,
      displayName: me.usual_full_name || me.displayname || me.login,
      imageUrl: me.image?.link || me.image?.versions?.medium || null,
      // Captured once at login so the client can default the campus dropdown to the
      // visitor's own campus instead of "All Morocco" — not refreshed on token refresh
      // since a student's home campus essentially never changes mid-session.
      primaryCampusId: me.campus_users?.find((cu) => cu.is_primary)?.campus_id ?? null,
    };

    setSessionCookie(res, { accessToken, refreshToken, expiresAt, user });
    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback failed:', err);
    res.redirect('/?authError=login_failed');
  }
});

app.get('/api/auth/me', (req, res) => {
  const session = getSession(req);
  if (!session) { return res.status(401).json({ error: 'UNAUTHENTICATED' }); }
  res.json({ user: session.user });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Lazy, single-student lookup — called only when a card is actually opened, not for every
// holder in a list. One extra call to the real join resource.
app.get('/api/achievements/achieved-date', requireAuth, async (req, res) => {
  const login = String(req.query.login || '').trim().toLowerCase();
  const name = String(req.query.name || '').trim();
  if (!login || !name) { return res.status(400).json({ error: 'MISSING_PARAMS' }); }

  try {
    const achievement = await findAchievementByName(name);
    if (!achievement) { return res.status(404).json({ error: 'ACHIEVEMENT_NOT_FOUND' }); }
    const user = await fetchUserRaw(login);
    const achievedAt = await fetchAchievedAt(user.id, achievement.id);
    res.json({ achievedAt });
  } catch (err) {
    if (err.status === 404) { return res.status(404).json({ error: 'NOT_FOUND' }); }
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Khouribga/Benguerir achievement holders are already fast to fetch (a handful of filtered
// calls, a few seconds), so unlike the Tétouan/Rabat Paris scan this just needs a plain
// TTL cache — no need for the async pending/ready job machinery that exists specifically to
// handle a multi-minute operation. Cached per achievement+campus combination; "this year"
// logins are cached separately (shared across every campus for the same achievement).
const ACHIEVEMENT_HOLDERS_CACHE_TTL_MS = 15 * 60 * 1000;
const achievementHoldersCache = new Map(); // `${achievementId}:${campusKey}` -> { data, cachedAt }
const thisYearLoginsCache = new Map(); // achievementId -> { logins, cachedAt }

const getThisYearLoginsCached = async (achievementId) => {
  const cached = thisYearLoginsCache.get(achievementId);
  if (cached && Date.now() - cached.cachedAt < ACHIEVEMENT_HOLDERS_CACHE_TTL_MS) { return cached.logins; }
  const logins = await fetchThisYearLogins(achievementId);
  thisYearLoginsCache.set(achievementId, { logins, cachedAt: Date.now() });
  return logins;
};

app.get('/api/achievements/holders', requireAuth, async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) { return res.status(400).json({ error: 'EMPTY_NAME' }); }

  // Scoped to Morocco by default (all 4 campuses, grouped per campus below), or a single one
  // when `campus` is given. Verified live: GET /v2/achievements/:id/users supports
  // filter[primary_campus_id] (its error message on an unsupported filter name told us the
  // real field is `primary_campus_id`, not `campus_id`).
  const requestedCampusId = req.query.campus ? Number(req.query.campus) : null;
  if (requestedCampusId && !MOROCCAN_CAMPUSES.some((c) => c.id === requestedCampusId)) {
    return res.status(400).json({ error: 'INVALID_CAMPUS' });
  }

  try {
    const achievement = await findAchievementByName(name);
    if (!achievement) { return res.status(404).json({ error: 'ACHIEVEMENT_NOT_FOUND' }); }

    const bypassCache = req.query.refresh === '1';
    const cacheKey = `${achievement.id}:${requestedCampusId || 'all'}`;
    const cached = !bypassCache && achievementHoldersCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < ACHIEVEMENT_HOLDERS_CACHE_TTL_MS) {
      return res.json({ achievement, ...cached.data });
    }

    // Both filters below cost no per-holder calls: staff exclusion reads fields already on
    // the raw holder object, and the year filter is one shared, paginated lookup reused
    // across every campus.
    const thisYearLogins = await getThisYearLoginsCached(achievement.id);
    const filterHolders = (rawHolders) =>
      rawHolders
        .filter((item) => (item.user || item).login !== 'asabbar')
        .filter((item) => !isStaffHolder(item))
        .filter((item) => thisYearLogins.has((item.user || item).login))
        .map(mapAchievementHolder);

    if (requestedCampusId) {
      // Single campus selected — flat list, no grouping needed. Achieved date is NOT
      // fetched here (that would be 1 extra call per holder and make the whole list slow) —
      // it's fetched lazily, only for the one student a card is actually clicked open for.
      const rawHolders = await fetchAllPages(
        `/achievements/${achievement.id}/users?filter[primary_campus_id]=${requestedCampusId}`,
        { maxPages: 5 },
      );
      const holders = filterHolders(rawHolders);
      const data = { holders };
      achievementHoldersCache.set(cacheKey, { data, cachedAt: Date.now() });
      return res.json({ achievement, ...data });
    }

    // "All Morocco": the holder objects carry no campus field at all (verified live), so the
    // only way to know which campus each one belongs to is to query per campus separately —
    // one filtered call per campus, then group under that campus's own section.
    const groups = [];
    for (const c of MOROCCAN_CAMPUSES) {
      const rawHolders = await fetchAllPages(
        `/achievements/${achievement.id}/users?filter[primary_campus_id]=${c.id}`,
        { maxPages: 5 },
      );
      const holders = filterHolders(rawHolders);
      groups.push({ campus: { id: c.id, name: c.name }, holders });
    }
    const data = { groups };
    achievementHoldersCache.set(cacheKey, { data, cachedAt: Date.now() });
    res.json({ achievement, ...data });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/campuses/:campusId/paris-adders', requireAuth, async (req, res) => {
  const campusId = Number(req.params.campusId);
  if (!MOROCCAN_CAMPUSES.some((c) => c.id === campusId)) {
    return res.status(400).json({ error: 'INVALID_CAMPUS' });
  }

  try {
    const adders = await getParisAdders(campusId, { bypassCache: req.query.refresh === '1' });
    res.json({ adders, ready: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/students/:login/profile', requireAuth, async (req, res) => {
  const login = String(req.params.login || '').trim().toLowerCase();
  if (!login) { return res.status(400).json({ error: 'EMPTY_LOGIN' }); }

  try {
    res.json({ profile: await fetchFullProfile(login) });
  } catch (err) {
    if (err.status === 404) { return res.status(404).json({ error: 'NOT_FOUND' }); }
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Exported so a serverless wrapper (see /api/*.js) can reuse this exact app without
// binding a port — app.listen() only happens in local dev, below.
export default app;

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`1337 Morocco Students API listening on http://localhost:${PORT}`);
  });
}
