import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { getValidToken } from './auth.js';
import { MOROCCAN_CAMPUSES } from './campuses.js';

const PORT = process.env.PORT || 4000;
const API_BASE = 'https://api.intra.42.fr/v2';

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

const apiGetOnce = async (path) => {
  await throttle();
  const token = await getValidToken();
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

const apiGet = async (path) => {
  try {
    return await apiGetOnce(path);
  } catch (err) {
    const isTransient = !err.status || err.status === 429 || err.status >= 500;
    if (!isTransient) { throw err; }
    if (err.retryAfterSeconds && err.retryAfterSeconds > MAX_AUTO_RETRY_WAIT_SECONDS) {
      err.message = `Rate limited by 42's API — try again in about ${Math.ceil(err.retryAfterSeconds / 60)} minute(s).`;
      throw err;
    }
    await new Promise((r) => setTimeout(r, (err.retryAfterSeconds ?? (err.status === 429 ? 3 : 1.5)) * 1000));
    return apiGetOnce(path);
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

const fetchAllPages = async (path, { maxPages = 6, pageSize = 100 } = {}) => {
  const results = [];
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const { data } = await apiGet(`${path}${sep}page[size]=${pageSize}&page[number]=${pageNum}`);
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

const app = express();
app.use(cors());

app.get('/api/campuses', (req, res) => {
  res.json(MOROCCAN_CAMPUSES);
});

// Lazy, single-student lookup — called only when a card is actually opened, not for every
// holder in a list. One extra call to the real join resource.
app.get('/api/achievements/achieved-date', async (req, res) => {
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

app.get('/api/achievements/holders', async (req, res) => {
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

    // Both filters below cost no per-holder calls: staff exclusion reads fields already on
    // the raw holder object, and the year filter is one shared, paginated lookup reused
    // across every campus.
    const thisYearLogins = await fetchThisYearLogins(achievement.id);
    const filterHolders = (rawHolders) =>
      rawHolders
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
      return res.json({ achievement, holders: filterHolders(rawHolders) });
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
      groups.push({ campus: { id: c.id, name: c.name }, holders: filterHolders(rawHolders) });
    }
    res.json({ achievement, groups });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/students/:login/profile', async (req, res) => {
  const login = String(req.params.login || '').trim().toLowerCase();
  if (!login) { return res.status(400).json({ error: 'EMPTY_LOGIN' }); }

  try {
    res.json({ profile: await fetchFullProfile(login) });
  } catch (err) {
    if (err.status === 404) { return res.status(404).json({ error: 'NOT_FOUND' }); }
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Exported so a serverless wrapper (see /api/[...path].js) can reuse this exact app without
// binding a port — app.listen() only happens in local dev, below.
export default app;

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`1337 Morocco Students API listening on http://localhost:${PORT}`);
  });
}
