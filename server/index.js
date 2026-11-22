import 'dotenv/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import express from 'express';
import cors from 'cors';
import { MOROCCAN_CAMPUSES, isMoroccanCampusId } from './campuses.js';
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
//
// Two priority lanes, not one FIFO: a background full-scan (the exact-total request, or a
// Paris-adders roster scan) can need dozens of throttled calls. On a single shared queue,
// switching to a different campus mid-scan still has to wait behind whatever's left of that
// scan before its own (small, fast) page request gets a turn — visibly "stuck" even though
// the visitor no longer cares about the old campus. High-priority calls always cut ahead of
// queued low-priority ones (low-priority work already in flight still finishes normally,
// only future picks get reordered), while the total dispatch rate stays capped at the same
// MIN_INTERVAL_MS regardless of which lane it comes from — this reorders, it doesn't add
// throughput, so it can't push us over 42's real limit.
const MIN_INTERVAL_MS = 550;
const highQueue = [];
const lowQueue = [];
let dispatching = false;
let lastDispatch = 0;

const pump = () => {
  if (dispatching) { return; }
  const next = highQueue.shift() || lowQueue.shift();
  if (!next) { return; }
  dispatching = true;
  const wait = Math.max(0, lastDispatch + MIN_INTERVAL_MS - Date.now());
  setTimeout(() => {
    lastDispatch = Date.now();
    dispatching = false;
    next.resolve();
    pump();
  }, wait);
};

const throttle = (priority = 'high') => {
  return new Promise((resolve) => {
    (priority === 'low' ? lowQueue : highQueue).push({ resolve });
    pump();
  });
};

// Holds the CURRENT VISITOR's own access token for the duration of one request. Every data
// route runs inside `requestContext.run({ token }, ...)` (set by the `requireAuth`
// middleware below) so apiGetOnce can read the right token without every helper function in
// this file (fetchUserRaw, fetchAllPages, etc.) needing a token parameter threaded through
// by hand. This is the mechanism that makes 42 API calls run AS the logged-in visitor,
// instead of the app's own client_credentials token — per the explicit requirement that
// data be fetched using each visitor's own 42 account, not the app owner's.
const requestContext = new AsyncLocalStorage();

const apiGetOnce = async (path, tokenOverride, priority = 'high') => {
  await throttle(priority);
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

const apiGet = async (path, tokenOverride, priority = 'high') => {
  try {
    return await apiGetOnce(path, tokenOverride, priority);
  } catch (err) {
    const isTransient = !err.status || err.status === 429 || err.status >= 500;
    if (!isTransient) { throw err; }
    if (err.retryAfterSeconds && err.retryAfterSeconds > MAX_AUTO_RETRY_WAIT_SECONDS) {
      err.message = `Rate limited by 42's API — try again in about ${Math.ceil(err.retryAfterSeconds / 60)} minute(s).`;
      throw err;
    }
    await new Promise((r) => setTimeout(r, (err.retryAfterSeconds ?? (err.status === 429 ? 3 : 1.5)) * 1000));
    return apiGetOnce(path, tokenOverride, priority);
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

  // 42's API can return more than one campus_users row flagged is_primary (stale flip not
  // fully propagated) — the one that actually reflects reality is whichever was touched most
  // recently, not whichever happens to sit first in the array.
  const primaryCampusId = data.campus_users
    ?.filter((cu) => cu.is_primary)
    ?.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))
    ?.[0]?.campus_id;
  const primaryCampus =
    data.campus?.find((c) => c.id === primaryCampusId) ||
    data.campus?.[0] ||
    null;

  // A student can carry coalitions from more than one campus (after a transfer, both the old
  // and new campus's coalition show up) — /v2/users/:login/coalitions ignores filter[campus_id]
  // and just returns all of them, so coalitions[0] isn't reliably the CURRENT one. Each
  // coalition's slug embeds its campus name (e.g. "42cursus-paris-the-federation" vs
  // "42cursus-khouribga-philantropists"), so match against the current primary campus's name
  // instead of trusting array order.
  const primaryCampusNameSlug = primaryCampus?.name?.toLowerCase().replace(/\s+/g, '-');
  const currentCoalition =
    (primaryCampusNameSlug && coalitions.find((c) => c.slug?.toLowerCase().includes(primaryCampusNameSlug))) ||
    coalitions[0] ||
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
    imageUrl: data.image?.versions?.large || data.image?.link || null,
    campus: primaryCampus?.name || 'N/A',
    country: primaryCampus?.country || 'N/A',
    campuses,
    level: mainCursus?.level ?? 0,
    grade: mainCursus?.grade || null,
    coalitionColor: currentCoalition?.color || null,
    coalitionName: currentCoalition?.name || null,
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

const fetchAllPages = async (path, { maxPages = 6, pageSize = 100, tokenOverride, priority = 'high' } = {}) => {
  const results = [];
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const { data } = await apiGet(`${path}${sep}page[size]=${pageSize}&page[number]=${pageNum}`, tokenOverride, priority);
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
    imageUrl: u.image?.versions?.medium || u.image?.link || null,
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
// query gets every this-year achiever's user_id + login in a handful of calls, no per-holder
// lookup. Keeping user_id (not just login) is what makes the Paris-switchers scan below
// possible without ever paginating a separate, much larger "all holders of all time" list —
// verified live this achievement alone has 1000+ this-year achievers, so that all-time list
// is far bigger still and would need its own uncapped-feeling page limit for no real benefit
// (we already have everything from achievements_users we actually need here).
//
// Runs under the app's client_credentials token, not the visitor's: verified live that the
// same query under a visitor token silently returned only 909 of the 1178 this-year
// achievers, and NONE of the missing ones were Moroccan-primary, which emptied every campus
// list. What 42 returns here depends on whose token asks; the app token sees everyone.
const fetchThisYearAchievers = async (achievementId) => {
  const year = new Date().getFullYear();
  const raw = await fetchAllPages(
    `/achievements_users?filter[achievement_id]=${achievementId}` +
      `&range[created_at]=${year}-01-01T00:00:00.000Z,${year + 1}-01-01T00:00:00.000Z`,
    { maxPages: 15, tokenOverride: await getAppToken() },
  );
  return raw.map((r) => ({ userId: r.user_id, login: r.login }));
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
// Cached per campus with a TTL (same pattern as achieverIndexCache below) — NOT a
// fire-and-forget background job. An earlier version kicked the scan off detached and had
// the route return immediately, relying on the client to poll until it finished; that works
// on a persistent Node process (local dev) but silently never completes on Vercel, because a
// serverless function can be frozen right after it sends its response, killing any detached
// work that hasn't finished — verified live in prod (the route kept responding "still
// scanning" forever). Awaiting the scan directly, inside the request that needs it, is what
// actually guarantees it runs to completion, on both platforms.
const PARIS_CAMPUS_ID = 1;
const RABAT_CAMPUS_ID = 75;
const NO_ACHIEVEMENT_CAMPUS_IDS = [55, RABAT_CAMPUS_ID]; // Tétouan, Rabat — mirrors the client-side constant
const CAMPUS_NAME_LOOKUP = {
  [PARIS_CAMPUS_ID]: { id: PARIS_CAMPUS_ID, name: 'Paris', country: 'France' },
  ...Object.fromEntries(MOROCCAN_CAMPUSES.map((c) => [c.id, { id: c.id, name: c.name, country: 'Morocco' }])),
};

// Mirrors the client-side constant of the same name — students whose Paris campus_users row
// became primary since this date are "recently switched", surfaced separately below since
// 42's achievement-holders query filters by CURRENT primary campus and can no longer see them.
const PARIS_SWITCH_SINCE = new Date(new Date().getFullYear(), 7, 1); // August 1st, this year

// Switchers are listed most recent move first (name breaks ties). Sorted server-side, before
// pagination slices the list, so every page continues the same newest → oldest order.
const bySwitchedAtDesc = (a, b) =>
  (new Date(b.switchedAt || 0) - new Date(a.switchedAt || 0)) || a.displayName.localeCompare(b.displayName);

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

// Khouribga (3801 students) and Benguerir (3519) both blow past a 2000-user cap — verified
// live, that's exactly what silently truncated this scan before and made it miss students
// past that point (including, ironically, this app's own builder once his profile switched
// to Paris). 60 pages × 100 covers up to 6000, comfortable headroom over every campus's
// current size.
const ROSTER_MAX_PAGES = 60;

// Same rule as normalizeFullProfile: 42 can leave more than one row flagged is_primary
// after a campus flip, and the most recently touched one is the real one.
const pickPrimaryRow = (rows) =>
  rows
    .filter((r) => r.is_primary)
    .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))[0] || null;


const mapParisAdderRow = (u, row, campusId) => ({
  id: u.id,
  login: u.login,
  displayName: u.usual_full_name || u.displayname || u.login,
  imageUrl: u.image?.versions?.medium || u.image?.link || null,
  campuses: [CAMPUS_NAME_LOOKUP[campusId], CAMPUS_NAME_LOOKUP[PARIS_CAMPUS_ID]],
  poolYear: u.pool_year || null,
  // When this student's campus_users row for Paris was created — i.e. when Paris was
  // actually added to their profile. Lets the client flag a "recently switched to
  // Paris" badge on achievement-holder cards (Khouribga/Benguerir) instead of just a
  // plain "has Paris" boolean.
  parisJoinedAt: row.created_at || null,
  // Whether Paris is their PRIMARY campus right now, and when that row was last
  // touched (a primary flip updates this even when the row itself was created much
  // earlier as a secondary campus) — this is what actually explains a student
  // disappearing from an achievement list filtered by filter[primary_campus_id]: 42's
  // API filters on the *current* primary campus, so someone who genuinely still holds
  // the achievement becomes invisible there the moment Paris becomes their primary.
  isPrimary: Boolean(row.is_primary),
  primaryUpdatedAt: row.updated_at || row.created_at || null,
});

const PARIS_ADDERS_CACHE_TTL_MS = 60 * 60 * 1000; // hourly — this data changes rarely
const parisAddersCache = new Map(); // campusId -> { rosterPage, rosterExhausted, adders, switchers, cachedAt }

// Paginated like the achievement holders route: only as many roster pages (100 students
// each) get fetched — and immediately campus_users-checked — as are needed to cover the
// requested page/size, instead of scanning a campus's entire roster (up to 3800+ students)
// before returning anything. The cache entry holds progress made so far, so a deeper
// page/larger size just fetches the additional roster pages needed and extends it.
const getParisAddersPage = async (campusId, { force = false, page = 1, pageSize = 10, promo = null } = {}) => {
  let entry = !force && parisAddersCache.get(campusId);
  if (!entry || Date.now() - entry.cachedAt >= PARIS_ADDERS_CACHE_TTL_MS) {
    entry = { rosterPage: 0, rosterExhausted: false, adders: [], switchers: [], cachedAt: Date.now() };
  }

  const token = await getAppToken();
  const neededCount = page * pageSize;
  // A huge pageSize (see ensureExactAddersTotal / getParisAdders in App.jsx) means this is a
  // background full-scan, not a visible page the visitor is waiting on — let foreground
  // requests (a normal small page, from this campus or any other) cut ahead of it in the
  // shared throttle queue instead of queuing behind however much of this scan is left.
  const priority = pageSize > 1000 ? 'low' : 'high';

  while (entry.adders.length < neededCount && !entry.rosterExhausted && entry.rosterPage < ROSTER_MAX_PAGES) {
    const nextPage = entry.rosterPage + 1;
    const { data: rosterChunk } = await apiGet(
      `/campus/${campusId}/users?page[size]=100&page[number]=${nextPage}`,
      token,
      priority,
    );
    entry.rosterPage = nextPage;
    if (!Array.isArray(rosterChunk) || rosterChunk.length === 0) { entry.rosterExhausted = true; break; }

    const candidates = rosterChunk.filter((u) => !u['staff?']);
    if (candidates.length > 0) {
      const byId = new Map(candidates.map((u) => [u.id, u]));
      const rows = await fetchAllPages(
        `/campus_users?filter[user_id]=${candidates.map((u) => u.id).join(',')}`,
        { maxPages: 3, tokenOverride: token, priority },
      );
      const rowsByUser = new Map();
      for (const row of rows) {
        if (!rowsByUser.has(row.user_id)) { rowsByUser.set(row.user_id, []); }
        rowsByUser.get(row.user_id).push(row);
      }
      // A campus roster still lists students who have since made Paris their PRIMARY campus
      // (their old campus_users row remains). Those are no longer at this campus: they go to
      // this campus's Paris-switchers list (if they switched this season), never to the
      // main "Paris on profile" table. Same primary-campus rule as the achiever index.
      for (const [userId, userRows] of rowsByUser) {
        const parisRow = userRows.find((r) => r.campus_id === PARIS_CAMPUS_ID);
        const u = byId.get(userId);
        if (!parisRow || !u) { continue; }
        const primary = pickPrimaryRow(userRows);
        if (primary?.campus_id === PARIS_CAMPUS_ID) {
          const switchedAt = primary.updated_at || primary.created_at;
          if (switchedAt && new Date(switchedAt) >= PARIS_SWITCH_SINCE) {
            entry.switchers.push({ ...mapAchievementHolder(u), campusId, recentParisMove: true, switchedAt });
          }
          continue;
        }
        entry.adders.push(mapParisAdderRow(u, parisRow, campusId));
      }
    }
    if (rosterChunk.length < 100) { entry.rosterExhausted = true; }
  }
  parisAddersCache.set(campusId, entry);

  const promoFiltered = promo ? entry.adders.filter((a) => String(a.poolYear) === String(promo)) : entry.adders;
  const adders = promoFiltered.slice((page - 1) * pageSize, page * pageSize);
  const hasMore = promoFiltered.length > page * pageSize || !entry.rosterExhausted;
  // Only known once the whole roster's been scanned — null until then, same pattern as
  // achievement holders' exactTotal/promoYears.
  const exactTotal = entry.rosterExhausted ? promoFiltered.length : null;
  const promoYears = entry.rosterExhausted
    ? [...new Set(entry.adders.map((a) => a.poolYear).filter(Boolean))].sort().reverse()
    : null;
  return { adders, hasMore, exactTotal, promoYears };
};

// Callers that need the FULL list, not one page (the boot-time prewarm below) — an
// unreachable `pageSize` means getParisAddersPage's internal loop only stops once the whole
// roster is exhausted, so one call already does the full scan.
const parisAddersFullScanInFlight = new Map(); // campusId -> Promise
const fullScanParisAdders = (campusId, { bypassCache = false } = {}) => {
  const inFlight = parisAddersFullScanInFlight.get(campusId);
  if (inFlight) { return inFlight; }
  const scan = getParisAddersPage(campusId, { force: bypassCache, page: 1, pageSize: Number.MAX_SAFE_INTEGER })
    .then(() => parisAddersCache.get(campusId))
    .finally(() => parisAddersFullScanInFlight.delete(campusId));
  parisAddersFullScanInFlight.set(campusId, scan);
  return scan;
};

const getParisAdders = async (campusId, options) => (await fullScanParisAdders(campusId, options)).adders;

// Students from a "Paris on profile" campus (Tétouan) who switched to Paris this season.
// Unlike Khouribga/Benguerir, Tétouan's main table isn't built from the achievement, so its
// switchers can't come from the achiever index alone: a Tétouan student who moved to Paris
// without earning the achievement this year would otherwise stay stuck in the main table.
const getRosterParisSwitchers = async (campusId) => (await fullScanParisAdders(campusId)).switchers;

// Prewarmed at boot in local dev only — a Vercel function instance isn't a long-lived
// process, so there's no "boot" to hook; there the first real request to hit a cold cache
// just pays the scan cost itself (well within the 300s function timeout).
if (process.env.VERCEL !== '1') {
  for (const campusId of NO_ACHIEVEMENT_CAMPUS_IDS) {
    if (campusId === RABAT_CAMPUS_ID) { continue; } // hardcoded empty, never scanned
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

// Prod moved to 42-hub.tech — these old domains stay registered (bookmarks, old links) but
// shouldn't keep serving the app. Every request on them (page or API) gets this notice
// instead, short-circuiting before any real route runs.
const DEPRECATED_HOSTS = new Set([
  '1337-7arraga.vercel.app',
  '1337-7arraga.com',
  'www.1337-7arraga.com',
]);

const DEPRECATED_DOMAIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Domain moved</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0a0a12; color: #eeeef8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .card { max-width: 480px; padding: 40px 32px; text-align: center; }
  h1 { font-size: 24px; margin: 0 0 12px; }
  p { color: #8888a8; line-height: 1.6; margin: 0 0 8px; }
  a { color: #4f8ef7; text-decoration: none; font-weight: 600; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div class="card">
    <h1>This domain is no longer valid</h1>
    <p>This site has moved to a new domain.</p>
    <p>Visit <a href="https://42-hub.tech/" target="_blank" rel="noreferrer">https://42-hub.tech/</a> instead.</p>
  </div>
</body>
</html>`;

const app = express();
app.set('trust proxy', true); // Vercel terminates TLS in front of the function; needed so req.protocol reflects the real https scheme for the OAuth redirect_uri.

app.use((req, res, next) => {
  if (DEPRECATED_HOSTS.has(req.hostname)) {
    return res.status(410).type('html').send(DEPRECATED_DOMAIN_PAGE);
  }
  next();
});

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

    // Same stale-flip issue as normalizeFullProfile above: 42 can flag more than one
    // campus_users row is_primary, so pick the one touched most recently instead of
    // whichever sits first. If that campus isn't one of the 4 this app covers (e.g. a
    // student who's since switched their primary to Paris), fall back to whichever OTHER
    // campus on their profile IS one of ours, so the dropdown still defaults to something
    // useful instead of silently landing on "All Morocco".
    const campusUsers = me.campus_users || [];
    const primaryCampusId = campusUsers
      .filter((cu) => cu.is_primary)
      .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))
      [0]?.campus_id ?? null;
    const defaultCampusId = MOROCCAN_CAMPUSES.some((c) => c.id === primaryCampusId)
      ? primaryCampusId
      : campusUsers.find((cu) => MOROCCAN_CAMPUSES.some((c) => c.id === cu.campus_id))?.campus_id ?? primaryCampusId;

    const user = {
      id: me.id,
      login: me.login,
      displayName: me.usual_full_name || me.displayname || me.login,
      imageUrl: me.image?.versions?.medium || me.image?.link || null,
      // Captured once at login so the client can default the campus dropdown to the
      // visitor's own campus instead of "All Morocco" — not refreshed on token refresh
      // since a student's home campus essentially never changes mid-session.
      primaryCampusId: defaultCampusId,
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

// Every this-year achiever, sorted into exactly one bucket by their REAL primary campus:
// a Moroccan campus's holders list, the "recently switched to Paris" list, or neither.
//
// Why not GET /v2/achievements/:id/users?filter[primary_campus_id]=X (what this used to do):
// verified live that filter is unreliable. For the same Khouribga query, the app token got
// 55 holders, a visitor's token got 0, and minutes earlier the same query had returned 271,
// including students whose campus_users rows clearly showed Paris as primary. That's what
// made Paris-switched students show up under their old Moroccan campus AND in the switchers
// section at the same time. campus_users itself is accurate, so it's the source of truth:
// one bulk check (100 users per call) decides where every achiever belongs, and the holders
// lists and the switchers list are both built from that single result, so they can't overlap.
//
// Every call in this build runs under the app's client_credentials token, the same deliberate
// exception as the Paris-adders scan: campus_users filter[user_id] 403s under a visitor's
// `scope: public` token, and the achievers list is incomplete under one (see
// fetchThisYearAchievers). Visitors still need to be logged in to reach these routes.
const ACHIEVEMENT_INDEX_CACHE_TTL_MS = 60 * 60 * 1000;
const thisYearAchieversCache = new Map(); // achievementId -> { achievers, cachedAt }
const achieverIndexCache = new Map(); // achievementId -> { index, cachedAt }
// Concurrent requests (4 campus sections, the switchers section, an exact-total scan) all
// share ONE in-flight build instead of each starting its own ~40-call scan on a cold cache.
const achieverIndexInFlight = new Map(); // achievementId -> Promise<index>

const getThisYearAchieversCached = async (achievementId) => {
  const cached = thisYearAchieversCache.get(achievementId);
  if (cached && Date.now() - cached.cachedAt < ACHIEVEMENT_INDEX_CACHE_TTL_MS) { return cached.achievers; }
  const achievers = await fetchThisYearAchievers(achievementId);
  thisYearAchieversCache.set(achievementId, { achievers, cachedAt: Date.now() });
  return achievers;
};

const buildAchieverIndex = async (achievementId) => {
  const token = await getAppToken();
  const achievers = await getThisYearAchieversCached(achievementId); // [{userId, login}]

  const holderIdsByCampus = new Map(MOROCCAN_CAMPUSES.map((c) => [c.id, []]));
  const switcherMatches = []; // { userId, campusId, switchedAt }

  for (let i = 0; i < achievers.length; i += 100) {
    const chunk = achievers.slice(i, i + 100);
    const rows = await fetchAllPages(
      `/campus_users?filter[user_id]=${chunk.map((a) => a.userId).join(',')}`,
      { maxPages: 5, tokenOverride: token },
    );
    const rowsByUser = new Map();
    for (const row of rows) {
      if (!rowsByUser.has(row.user_id)) { rowsByUser.set(row.user_id, []); }
      rowsByUser.get(row.user_id).push(row);
    }

    for (const [userId, userRows] of rowsByUser) {
      const primary = pickPrimaryRow(userRows);
      if (!primary) { continue; }
      if (isMoroccanCampusId(primary.campus_id)) {
        holderIdsByCampus.get(primary.campus_id).push(userId);
        continue;
      }
      // Not Moroccan-primary: only relevant if it's a Moroccan student who moved to Paris
      // this season. Anyone else (other campuses worldwide) is simply not ours.
      if (primary.campus_id !== PARIS_CAMPUS_ID) { continue; }
      const switchedAt = primary.updated_at || primary.created_at;
      if (!switchedAt || new Date(switchedAt) < PARIS_SWITCH_SINCE) { continue; }
      const homeRow = userRows.find((r) => isMoroccanCampusId(r.campus_id));
      if (!homeRow) { continue; }
      switcherMatches.push({ userId, campusId: homeRow.campus_id, switchedAt });
    }
  }

  // Display info (name/avatar/pool_year/staff flags), only for students we'll actually show.
  const ids = [...[...holderIdsByCampus.values()].flat(), ...switcherMatches.map((m) => m.userId)];
  const userById = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const users = await fetchAllPages(
      `/users?filter[id]=${ids.slice(i, i + 100).join(',')}`,
      { maxPages: 2, tokenOverride: token },
    );
    for (const u of users) { userById.set(u.id, u); }
  }

  const byName = (a, b) => a.displayName.localeCompare(b.displayName);
  const holdersByCampus = new Map();
  for (const [campusId, campusIds] of holderIdsByCampus) {
    holdersByCampus.set(
      campusId,
      campusIds
        .map((id) => userById.get(id))
        .filter((u) => u && u.login !== 'asabbar' && !isStaffHolder(u))
        .map(mapAchievementHolder)
        .sort(byName),
    );
  }

  const switchers = switcherMatches
    .map((m) => {
      const u = userById.get(m.userId);
      if (!u || isStaffHolder(u)) { return null; }
      return { ...mapAchievementHolder(u), campusId: m.campusId, recentParisMove: true, switchedAt: m.switchedAt };
    })
    .filter(Boolean)
    .sort(bySwitchedAtDesc);

  return { holdersByCampus, switchers };
};

const getAchieverIndex = (achievementId, { bypassCache = false } = {}) => {
  const cached = achieverIndexCache.get(achievementId);
  if (!bypassCache && cached && Date.now() - cached.cachedAt < ACHIEVEMENT_INDEX_CACHE_TTL_MS) {
    return Promise.resolve(cached.index);
  }
  const inFlight = achieverIndexInFlight.get(achievementId);
  if (inFlight) { return inFlight; }

  const build = (async () => {
    if (bypassCache) { thisYearAchieversCache.delete(achievementId); }
    const index = await buildAchieverIndex(achievementId);
    achieverIndexCache.set(achievementId, { index, cachedAt: Date.now() });
    return index;
  })().finally(() => achieverIndexInFlight.delete(achievementId));
  achieverIndexInFlight.set(achievementId, build);
  return build;
};

app.get('/api/achievements/holders', requireAuth, async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) { return res.status(400).json({ error: 'EMPTY_NAME' }); }

  // Scoped to Morocco by default (all 4 campuses, grouped per campus below), or a single one
  // when `campus` is given.
  const requestedCampusId = req.query.campus ? Number(req.query.campus) : null;
  if (requestedCampusId && !MOROCCAN_CAMPUSES.some((c) => c.id === requestedCampusId)) {
    return res.status(400).json({ error: 'INVALID_CAMPUS' });
  }

  try {
    const achievement = await findAchievementByName(name);
    if (!achievement) { return res.status(404).json({ error: 'ACHIEVEMENT_NOT_FOUND' }); }
    const index = await getAchieverIndex(achievement.id, { bypassCache: req.query.refresh === '1' });

    if (requestedCampusId) {
      // Single campus: the whole campus is already known from the index, so counts and promo
      // years are exact on the first response. Achieved date is still fetched lazily, only
      // for the one student whose card is opened.
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.max(1, Number(req.query.pageSize) || 10);
      const allHolders = index.holdersByCampus.get(requestedCampusId) || [];
      const promo = req.query.promo ? String(req.query.promo) : null;
      const promoFiltered = promo ? allHolders.filter((h) => String(h.poolYear) === promo) : allHolders;
      const holders = promoFiltered.slice((page - 1) * pageSize, page * pageSize);
      const promoYears = [...new Set(allHolders.map((h) => h.poolYear).filter(Boolean))].sort().reverse();
      return res.json({
        achievement,
        holders,
        page,
        pageSize,
        hasMore: promoFiltered.length > page * pageSize,
        total: allHolders.length,
        exactTotal: promoFiltered.length,
        promoYears,
      });
    }

    // "All Morocco": every campus's full list, grouped per campus.
    const groups = MOROCCAN_CAMPUSES.map((c) => ({
      campus: { id: c.id, name: c.name },
      holders: index.holdersByCampus.get(c.id) || [],
    }));
    res.json({ achievement, groups });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Rabat's full roster was scanned exhaustively (every non-staff student, not just a sample)
// and came back with zero students carrying Paris on their profile — unlike Tétouan, which
// has 27 confirmed. Scanning it again on every request/refresh is pure wasted API calls for
// a result that's already known, so it's hardcoded empty and never fetched.
app.get('/api/campuses/:campusId/paris-adders', requireAuth, async (req, res) => {
  const campusId = Number(req.params.campusId);
  if (!MOROCCAN_CAMPUSES.some((c) => c.id === campusId)) {
    return res.status(400).json({ error: 'INVALID_CAMPUS' });
  }
  if (campusId === RABAT_CAMPUS_ID) {
    return res.json({ adders: [], ready: true, page: 1, pageSize: 10, hasMore: false, exactTotal: 0, promoYears: [] });
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.max(1, Number(req.query.pageSize) || 10);
  const promo = req.query.promo ? String(req.query.promo) : null;

  try {
    const { adders, hasMore, exactTotal, promoYears } = await getParisAddersPage(campusId, {
      force: req.query.refresh === '1',
      page,
      pageSize,
      promo,
    });
    res.json({ adders, ready: true, page, pageSize, hasMore, exactTotal, promoYears });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/achievements/paris-switchers', requireAuth, async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) { return res.status(400).json({ error: 'EMPTY_NAME' }); }

  // Optional campus scoping — when provided, only switchers from that Moroccan campus are
  // returned (still one shared worldwide fetch, just filtered before slicing).
  const campusId = req.query.campus ? Number(req.query.campus) : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.max(1, Number(req.query.pageSize) || 10);

  try {
    const achievement = await findAchievementByName(name);
    if (!achievement) { return res.status(404).json({ error: 'ACHIEVEMENT_NOT_FOUND' }); }
    const { switchers: indexSwitchers } = await getAchieverIndex(achievement.id, { bypassCache: req.query.refresh === '1' });
    let allSwitchers = indexSwitchers;
    const rosterCampusIds = (campusId != null ? [campusId] : MOROCCAN_CAMPUSES.map((c) => c.id))
      .filter((id) => NO_ACHIEVEMENT_CAMPUS_IDS.includes(id) && id !== RABAT_CAMPUS_ID);
    for (const id of rosterCampusIds) {
      const seen = new Set(allSwitchers.map((s) => s.login));
      const extra = (await getRosterParisSwitchers(id)).filter((s) => !seen.has(s.login));
      if (extra.length > 0) {
        allSwitchers = [...allSwitchers, ...extra].sort(bySwitchedAtDesc);
      }
    }

    // Filter by campus when requested (e.g. single-campus view), otherwise return all.
    const scoped = campusId != null ? allSwitchers.filter((s) => s.campusId === campusId) : allSwitchers;
    const total = scoped.length;
    const switchers = scoped.slice((page - 1) * pageSize, page * pageSize);
    const hasMore = total > page * pageSize;

    res.json({ switchers, ready: true, page, pageSize, hasMore, total });
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

// cdn.intra.42.fr answers 403 to anonymous requests for user photos (it only serves them to
// a logged-in intra session or a request carrying a 42 API bearer token), so the browser
// can't load them directly from this site. This fetches the photo with the visitor's own
// token and streams it back. Only 42 user-photo URLs are accepted, so this can't be used as
// an open proxy. Deliberately NOT routed through throttle(): the CDN isn't the rate-limited
// API (verified: parallel bursts all return 200), and queueing every avatar at 550ms would
// make a 100-row list take nearly a minute to show its photos.
const AVATAR_URL_RE = /^https:\/\/cdn\.intra\.42\.fr\/users\/[0-9a-f]+\/[\w.-]+$/;

app.get('/api/avatar', requireAuth, async (req, res) => {
  const url = String(req.query.url || '');
  if (!AVATAR_URL_RE.test(url)) { return res.status(400).json({ error: 'BAD_AVATAR_URL' }); }

  try {
    const upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${requestContext.getStore().token}` },
    });
    const type = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !type.startsWith('image/')) {
      return res.status(upstream.ok ? 502 : upstream.status).end();
    }
    // Private: the response depends on the visitor's session. A day is plenty, since a photo
    // change gives the student a new URL anyway (the path includes a content hash).
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' });
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(502).end();
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
