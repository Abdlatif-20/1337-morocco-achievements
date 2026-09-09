import { useEffect, useRef, useState } from 'react';
import {
  LOGIN_URL,
  fetchAchievedDate,
  fetchAchievementHolders,
  fetchAllCampusParisAdders,
  fetchCampuses,
  fetchMe,
  fetchAchievementParisSwitchers,
  fetchStudentProfile,
  logout,
} from './api.js';
import { getRecentUses, readCache, recordUse, writeCache } from './browserCache.js';
import BackgroundMusic from './components/BackgroundMusic.jsx';
import StudentCard from './components/StudentCard.jsx';
import StudentDetailModal from './components/StudentDetailModal.jsx';

const DEFAULT_ACHIEVEMENT = 'Je voudrais un croissant';

// Mirrors the server's own cache TTLs (server/index.js) — the browser cache and the server
// cache go stale together, so a page reload never shows something the server itself would
// already consider outdated. Achievement data changes rarely; the Paris-adders scan even
// more rarely, hence the longer TTL there.
const ACHIEVEMENT_CACHE_TTL_MS = 15 * 60 * 1000;
const PARIS_CACHE_TTL_MS = 60 * 60 * 1000;

// Tétouan (55) and Rabat (75) have never had a holder of this achievement — searching for it
// there is a guaranteed-empty API call. Skip straight to the Paris-on-profile check instead.
const NO_ACHIEVEMENT_CAMPUS_IDS = [55, 75];

// For any campus with real holders shown, the Paris-adders scan (same one Tétouan/Rabat's
// fallback view uses, GET /api/campuses/:id/paris-adders) is fetched quietly in the
// background purely to cross-reference: any holder who's ALSO in that campus's Paris-adders
// list, recently, gets a ✈️ badge flagging them as having just switched their profile's
// campus to Paris. Doesn't gate or slow down the holders list itself. Which campuses have
// holders isn't a fixed pair — it changes over time (Tétouan, once always empty, now
// genuinely has some) — so this runs for whichever campus the holders result actually covers.
const RECENT_PARIS_MOVE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

// The Refresh button bypasses every cache layer (server TTL cache + browser localStorage
// cache) and hits 42's API directly, so it's the one action in this app that can actually
// burn through 42's rate limit if clicked repeatedly — capped client-side to a few uses per
// rolling hour, tracked in localStorage so it survives a page reload.
const REFRESH_LIMIT = 3;
const REFRESH_WINDOW_MS = 60 * 60 * 1000;
const REFRESH_USE_KEY = 'refreshClicks';

const AUTH_ERROR_MESSAGES = {
  invalid_state: 'Login could not be verified — please try again.',
  login_failed: 'Login with 42 failed — please try again.',
};

const PAGE_SIZE_OPTIONS = [10, 50, 100];

// Every student list in this app is already fully fetched client-side (achievement holders,
// Paris-adders), so pagination/filtering here is just a display slice — no extra API calls.
// Give it a `key` (e.g. the campus id) wherever the underlying list can change out from
// under it, so page/filter state resets instead of showing a stale slice from a different
// list. Promo filter uses `poolYear` (the cohort a student joined in) — 42's API has no
// gender/sex field anywhere (checked live against a full user object), so that one isn't
// buildable here.
// `globalPromoFilter`/`globalPageSize` are how the "All Morocco" view applies ONE Promo
// filter and ONE page size across every campus group at once: the parent passes its own
// values down and this component just uses them, hiding its own per-group controls (there's
// nothing to pick locally, since it's already been picked globally). Every other view (a
// single campus selected, or a Paris-adders list) leaves both undefined and keeps its own
// independent controls, since there's only ever one list on screen there anyway.
const PaginatedStudentGrid = ({ students, onOpenStudent, globalPromoFilter, globalPageSize }) => {
  const [page, setPage] = useState(1);
  const [localPageSize, setLocalPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [localPromoFilter, setLocalPromoFilter] = useState('');
  const isGlobal = globalPromoFilter !== undefined;
  const promoFilter = isGlobal ? globalPromoFilter : localPromoFilter;
  const pageSize = globalPageSize !== undefined ? globalPageSize : localPageSize;

  const promoYears = [...new Set(students.map((s) => s.poolYear).filter(Boolean))].sort().reverse();
  const filtered = promoFilter ? students.filter((s) => s.poolYear === promoFilter) : students;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const start = (clampedPage - 1) * pageSize;
  const pageStudents = filtered.slice(start, start + pageSize);

  // Covers every path a filter/page-size can change through — a local control here, or a
  // global one re-rendering this with new props — either way, page 1 is where the newly
  // filtered/resized list should start from instead of possibly landing past its end.
  useEffect(() => { setPage(1); }, [promoFilter, pageSize]);

  return (
    <>
      <div className="filters-row grid-controls">
        {!isGlobal && (
          <label className="filter-select">
            Show
            <select value={localPageSize} onChange={(e) => setLocalPageSize(Number(e.target.value))}>
              {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
        {!isGlobal && promoYears.length > 0 && (
          <label className="filter-select">
            Promo
            <select value={localPromoFilter} onChange={(e) => setLocalPromoFilter(e.target.value)}>
              <option value="">All</option>
              {promoYears.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
        )}
      </div>
      {filtered.length === 0 ? (
        <p className="status-text">No students match this filter.</p>
      ) : (
        <div className="student-grid">
          {pageStudents.map((s) => (
            <StudentCard key={s.id} student={s} onOpen={() => onOpenStudent(s)} />
          ))}
        </div>
      )}
      {totalPages > 1 && (
        <div className="pagination">
          <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={clampedPage === 1}>
            ← Prev
          </button>
          <span>Page {clampedPage} / {totalPages}</span>
          <button type="button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={clampedPage === totalPages}>
            Next →
          </button>
        </div>
      )}
    </>
  );
};

// Floating "back to top" arrow — hidden until the page is scrolled down a bit, since these
// lists (especially "All Morocco") can get long.
const ScrollToTopButton = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 400);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!visible) { return null; }
  return (
    <button
      type="button"
      className="scroll-top-btn"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="Scroll to top"
      title="Scroll to top"
    >
      ↑
    </button>
  );
};

// Small top-right avatar button — the logged-in visitor's own 42 photo, opens a one-item
// dropdown ("Logout") on click. Closes itself on an outside click.
const AccountMenu = ({ user, onLogout }) => {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) { return; }
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  return (
    <div className="account-menu" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="account-avatar-btn" onClick={() => setOpen((v) => !v)}>
        {user.imageUrl ? (
          <img src={user.imageUrl} alt={user.displayName} className="account-avatar" />
        ) : (
          <span className="account-avatar account-avatar-fallback">
            {user.displayName.slice(0, 2).toUpperCase()}
          </span>
        )}
      </button>
      {open && (
        <div className="account-dropdown">
          <div className="account-dropdown-name">@{user.login}</div>
          <button type="button" className="account-logout-btn" onClick={onLogout}>Logout</button>
        </div>
      )}
    </div>
  );
};

// Fallback shown for a campus with zero achievement holders (Tétouan/Rabat, always empty so
// far): students there who have 42 Paris on their profile. The server caches this per campus
// (see server/index.js) and refreshes it automatically — the point of this component is to
// respect that: a cached result renders immediately with no network call at all, and only
// "Refresh" (or a first-ever visit) actually asks the server, which itself just serves its
// cache unless that cache is still warming.
const ParisAddersSection = ({ campusId, campusName, showCount = true, cached, loading, error, onLoad, onOpenStudent, globalPromoFilter, globalPageSize }) => {
  useEffect(() => {
    onLoad(campusId);
  }, [campusId]);

  if (error) {
    return <p className="error-text">{error}</p>;
  }
  const adders = cached?.adders || [];
  if (loading && adders.length === 0) {
    return (
      <div className="inline-loading">
        <span className="spinner" />
        No achievement holders here — checking who has 42 Paris on their profile…
      </div>
    );
  }
  if (adders.length === 0) {
    return <p className="status-text">No students hold this achievement here, and none have 42 Paris on their profile.</p>;
  }
  // Dedupe (the scan can't produce duplicates, but cheap to guard), sort alphabetically so
  // the list reads consistently instead of raw campus-roster order, and drop `campuses` —
  // StudentCard would otherwise show "Tétouan, Paris" under every name, which is redundant
  // with the section heading/status line right above the grid.
  const sortedAdders = [...new Map(adders.map((a) => [a.id, a])).values()]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map(({ campuses, ...rest }) => rest);
  return (
    <>
      {showCount ? (
        <p className="status-text">
          {sortedAdders.length} student(s) at {campusName}
          {cached && !cached.ready ? ' (still checking for more)' : ''}
        </p>
      ) : (
        cached && !cached.ready && <p className="status-text">(still checking for more)</p>
      )}
      <PaginatedStudentGrid
        key={campusId}
        students={sortedAdders}
        onOpenStudent={onOpenStudent}
        globalPromoFilter={globalPromoFilter}
        globalPageSize={globalPageSize}
      />
    </>
  );
};

// Shown under Khouribga/Benguerir's achievement holders (whether or not that list itself has
// results) — students the API's filter[primary_campus_id] can no longer see (their primary
// campus is now Paris) but who genuinely made that switch recently. The parent already
// triggers the background Paris-adders fetch this reads from (same one powering the ✈️
// badge), so this never fires its own network request.
const RecentParisSwitchersSection = ({ students, loading, onOpenStudent }) => {
  if (loading && students.length === 0) {
    return (
      <div className="inline-loading">
        <span className="spinner" />
        Checking for students who recently switched to 42 Paris…
      </div>
    );
  }
  const sorted = [...students].sort((a, b) => a.displayName.localeCompare(b.displayName));
  return (
    <div className="campus-group">
      <h2 className="section-heading">✈️ Recently switched to 42 Paris ({sorted.length})</h2>
      {sorted.length === 0 ? (
        <p className="status-text">
          No students here have switched their primary campus to 42 Paris since August.
        </p>
      ) : (
        <div className="student-grid">
          {sorted.map((s) => (
            <StudentCard key={s.id} student={s} onOpen={() => onOpenStudent(s)} />
          ))}
        </div>
      )}
    </div>
  );
};

const App = () => {
  // `me`: undefined = still checking, null = not logged in, object = the logged-in visitor.
  // Every data route on the server requires this session and uses the visitor's own 42
  // access token — nothing below fetches until this resolves to a real user.
  const [me, setMe] = useState(undefined);
  const [authError, setAuthError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('authError');
    if (err) {
      setAuthError(AUTH_ERROR_MESSAGES[err] || 'Login failed — please try again.');
      window.history.replaceState({}, '', window.location.pathname);
    }
    fetchMe()
      .then((res) => setMe(res.user))
      .catch(() => setMe(null));
  }, []);

  const handleLogout = () => {
    logout().finally(() => setMe(null));
  };

  const [campuses, setCampuses] = useState([]);
  const [selectedCampusId, setSelectedCampusId] = useState('');
  // Only meaningful in the "All Morocco" (grouped) view — one Promo filter and page size
  // shared by every campus group instead of each group having its own. Reset whenever the
  // campus selection changes so neither carries a stale value into a freshly picked
  // single-campus view.
  const [globalPromoFilter, setGlobalPromoFilter] = useState('');
  const [globalPageSize, setGlobalPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  useEffect(() => { setGlobalPromoFilter(''); setGlobalPageSize(PAGE_SIZE_OPTIONS[0]); }, [selectedCampusId]);
  const [achievementResult, setAchievementResult] = useState(null);
  const [achievementError, setAchievementError] = useState(null);
  const [achievementLoading, setAchievementLoading] = useState(false);
  const [refreshUses, setRefreshUses] = useState(() => getRecentUses(REFRESH_USE_KEY, REFRESH_WINDOW_MS));
  const refreshesLeft = Math.max(0, REFRESH_LIMIT - refreshUses.length);
  // Keyed by campus id ('' = All Morocco) — switching back to an already-fetched campus
  // reuses this instead of hitting the API again. Only "Refresh" bypasses it. Hydrated from
  // localStorage on load so even a fresh page load (not just switching campuses in-session)
  // renders instantly from what's already known, instead of waiting on the network.
  const [cache, setCache] = useState(() => readCache('achievementHolders', ACHIEVEMENT_CACHE_TTL_MS) || {});

  useEffect(() => {
    writeCache('achievementHolders', cache);
  }, [cache]);

  const [detailStudent, setDetailStudent] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  useEffect(() => {
    if (!me) { return; }
    fetchCampuses().then((list) => {
      setCampuses(list);
      // Default the dropdown to the visitor's own campus instead of "All Morocco" — only
      // when nothing's been picked yet, so this never clobbers a manual selection.
      if (me.primaryCampusId && list.some((c) => c.id === me.primaryCampusId)) {
        setSelectedCampusId((prev) => (prev === '' ? String(me.primaryCampusId) : prev));
      }
    }).catch(() => {});
  }, [me]);

  // Paris-adders cache, kept in App (not the section component) so switching the campus
  // dropdown back and forth reuses what's already been fetched instead of re-scanning.
  // { [campusId]: { adders, ready } } — `ready: false` means still checking, `adders` is
  // whatever's been found so far. Hydrated from localStorage like `cache` above, but only
  // ever persists finished (`ready: true`) entries — a scan-in-progress isn't a snapshot
  // worth restoring, since reloading mid-scan should just resume by asking the server again
  // (which itself serves its own completed cache instantly if one already exists).
  const [parisCache, setParisCache] = useState(() => readCache('parisAdders', PARIS_CACHE_TTL_MS) || {});
  const [parisLoading, setParisLoading] = useState({});
  const [parisError, setParisError] = useState({});

  useEffect(() => {
    const readyOnly = Object.fromEntries(Object.entries(parisCache).filter(([, v]) => v.ready));
    writeCache('parisAdders', readyOnly);
  }, [parisCache]);

  const loadParisAdders = (campusId, { force = false } = {}) => {
    // Already have a finished result and nothing asked for a refresh — don't call the API
    // at all, just keep showing what's cached.
    if (!force && parisCache[campusId]?.ready) { return; }
    if (parisLoading[campusId]) { return; }

    setParisLoading((prev) => ({ ...prev, [campusId]: true }));
    setParisError((prev) => ({ ...prev, [campusId]: null }));
    fetchAllCampusParisAdders(campusId, (soFar) => {
      setParisCache((prev) => ({ ...prev, [campusId]: { adders: soFar, ready: false } }));
    }, { refresh: force })
      .then((all) => {
        setParisCache((prev) => ({ ...prev, [campusId]: { adders: all, ready: true } }));
      })
      .catch((err) => {
        if (err.status === 401) { setMe(null); return; }
        setParisError((prev) => ({ ...prev, [campusId]: err.message }));
      })
      .finally(() => {
        setParisLoading((prev) => ({ ...prev, [campusId]: false }));
      });
  };

  // The achievement-gated version of the Paris-adders scan — students who genuinely hold the
  // achievement this year AND made Paris their primary campus since August, which is exactly
  // the group invisible to the normal per-campus holders query. Scoped to this achievement's
  // this-year holders only (a few hundred, worldwide), NOT a full campus roster scan, so it's
  // one shared fetch for every campus instead of one scan per campus — each result already
  // carries its own `campusId` (the Moroccan campus it's grouped under).
  const [switchers, setSwitchers] = useState(() => readCache('parisSwitchers', ACHIEVEMENT_CACHE_TTL_MS) || []);
  const [switchersReady, setSwitchersReady] = useState(switchers.length > 0);
  const [switchersLoading, setSwitchersLoading] = useState(false);

  useEffect(() => {
    if (switchersReady) { writeCache('parisSwitchers', switchers); }
  }, [switchers, switchersReady]);

  const loadParisSwitchers = ({ force = false } = {}) => {
    if (!force && switchersReady) { return; }
    if (switchersLoading) { return; }

    setSwitchersLoading(true);
    fetchAchievementParisSwitchers(DEFAULT_ACHIEVEMENT, { refresh: force })
      .then((res) => {
        setSwitchers(res.switchers);
        setSwitchersReady(true);
      })
      .catch((err) => {
        if (err.status === 401) { setMe(null); return; }
      })
      .finally(() => setSwitchersLoading(false));
  };

  // Guards against out-of-order responses: switching from "All Morocco" to a specific campus
  // fires two requests in quick succession (mount defaults to '', then the visitor's own
  // campus effect fires right after) — the slower "All Morocco" one can resolve AFTER the
  // faster single-campus one and clobber it with the wrong (all-campuses) result. Only the
  // response matching the most recently *started* request is ever applied.
  const latestHoldersKeyRef = useRef(null);

  const loadHolders = (campusId, { force = false } = {}) => {
    const key = campusId || '';
    latestHoldersKeyRef.current = key;

    if (!force && cache[key]) {
      setAchievementResult(cache[key]);
      setAchievementError(null);
      return;
    }

    setAchievementLoading(true);
    setAchievementError(null);
    setAchievementResult(null);
    fetchAchievementHolders(DEFAULT_ACHIEVEMENT, campusId || null, { refresh: force })
      .then((res) => {
        setCache((prev) => ({ ...prev, [key]: res }));
        if (latestHoldersKeyRef.current !== key) { return; }
        setAchievementResult(res);
      })
      .catch((err) => {
        if (err.status === 401) { setMe(null); return; }
        if (latestHoldersKeyRef.current !== key) { return; }
        if (err.message === 'ACHIEVEMENT_NOT_FOUND') {
          setAchievementError(`No achievement named "${DEFAULT_ACHIEVEMENT}" found.`);
        } else {
          setAchievementError(err.message);
        }
      })
      .finally(() => {
        if (latestHoldersKeyRef.current !== key) { return; }
        setAchievementLoading(false);
      });
  };

  useEffect(() => {
    if (!me) { return; }
    loadHolders(selectedCampusId);
  }, [me, selectedCampusId]);

  // Whenever the holders list resolves and it includes Khouribga/Benguerir with real
  // holders, quietly kick off (or reuse the cache of) the per-campus raw Paris-adders scan
  // (powers the ✈️ badge on existing holder cards) — doesn't block or slow down the holders
  // list itself.
  useEffect(() => {
    if (!achievementResult) { return; }
    // Which campuses actually have holders shown right now changes over time (Tétouan, once
    // always empty, now genuinely has some) — so this runs for any campus with holders,
    // not a fixed hardcoded pair.
    const campusIdsWithHolders = achievementResult.groups
      ? achievementResult.groups.filter((g) => g.holders.length > 0).map((g) => g.campus.id)
      : achievementResult.holders?.length > 0 && selectedCampusId
        ? [Number(selectedCampusId)]
        : [];
    campusIdsWithHolders.forEach((id) => loadParisAdders(id));
  }, [achievementResult]);

  // The achievement-gated switchers list is one shared fetch (not per campus) — triggered
  // once whenever there's a holders result to show it alongside, regardless of which
  // Moroccan campus(es) that result covers.
  useEffect(() => {
    if (!achievementResult) { return; }
    loadParisSwitchers();
  }, [achievementResult]);

  // null when the student isn't a recent Paris-adder for this campus, otherwise the date
  // Paris was added to their profile — recency is judged against RECENT_PARIS_MOVE_MS.
  const getRecentParisJoin = (campusId, login) => {
    const match = parisCache[campusId]?.adders?.find((a) => a.login === login);
    if (!match?.parisJoinedAt) { return null; }
    const age = Date.now() - new Date(match.parisJoinedAt).getTime();
    return age >= 0 && age < RECENT_PARIS_MOVE_MS ? match.parisJoinedAt : null;
  };

  const withRecentParisFlag = (campusId, holders) =>
    holders.map((h) => ({ ...h, recentParisMove: Boolean(getRecentParisJoin(campusId, h.login)) }));

  // The achieved date is fetched lazily here, only for the one student actually opened —
  // not for every card in the list (that was an earlier slowdown).
  const openHolderDetail = (holder) => {
    setDetailLoading(true);
    setDetailError(null);
    Promise.all([
      fetchStudentProfile(holder.login).then((res) => res.profile),
      fetchAchievedDate(holder.login, DEFAULT_ACHIEVEMENT).catch(() => ({ achievedAt: null })),
    ])
      .then(([profile, dateRes]) => {
        setDetailStudent({ ...profile, achievedAt: dateRes.achievedAt });
      })
      .catch((err) => {
        if (err.status === 401) { setMe(null); return; }
        setDetailError(err.message);
      })
      .finally(() => setDetailLoading(false));
  };

  const closeDetail = () => setDetailStudent(null);

  if (me === undefined) {
    return (
      <div className="app">
        <p className="status-text">Checking session…</p>
      </div>
    );
  }

  if (me === null) {
    return (
      <div className="app login-gate">
        <header className="header">
          <h1>Achievement Holders</h1>
          <p className="subtitle">Moroccan students who've traveled to 42 Paris this year</p>
        </header>
        {authError && <p className="error-text">{authError}</p>}
        <p className="status-text">Log in with your 42 intra account to see the data.</p>
        <a className="login-btn" href={LOGIN_URL}>Login with 42</a>
        <footer className="footer">
          <p className="footer-label">Built by</p>
          <p className="footer-name">Abdellatyf en neiymy</p>
          <p className="footer-meta">
            aben-nei · <a href="https://profile.intra.42.fr/users/aben-nei" target="_blank" rel="noreferrer">42 Profile</a>
          </p>
        </footer>
      </div>
    );
  }

  return (
    <div className="app">
      <BackgroundMusic />
      <header className="header">
        <div className="header-top">
          <div>
            <h1>Achievement Holders</h1>
            <p className="subtitle">Moroccan students who've traveled to 42 Paris this year</p>
          </div>
          <AccountMenu user={me} onLogout={handleLogout} />
        </div>
      </header>

      <div className="filters-row">
        <label className="filter-select">
          Campus
          <select value={selectedCampusId} onChange={(e) => setSelectedCampusId(e.target.value)}>
            <option value="">All Morocco</option>
            {campuses.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="refresh-btn"
          onClick={() => {
            if (refreshesLeft <= 0) { return; }
            setRefreshUses(recordUse(REFRESH_USE_KEY, REFRESH_WINDOW_MS));
            loadHolders(selectedCampusId, { force: true });
            if (selectedCampusId && NO_ACHIEVEMENT_CAMPUS_IDS.includes(Number(selectedCampusId))) {
              loadParisAdders(Number(selectedCampusId), { force: true });
            } else if (!selectedCampusId) {
              NO_ACHIEVEMENT_CAMPUS_IDS.forEach((id) => loadParisAdders(id, { force: true }));
            }
          }}
          disabled={achievementLoading || refreshesLeft <= 0}
          title={refreshesLeft <= 0 ? 'Refresh limit reached — try again in a bit' : `${refreshesLeft} refresh(es) left this hour`}
        >
          {achievementLoading ? 'Loading…' : refreshesLeft <= 0 ? 'Limit reached' : `Refresh (${refreshesLeft})`}
        </button>
      </div>

      {achievementError && <p className="error-text">{achievementError}</p>}

      {achievementLoading ? (
        <div className="inline-loading">
          <span className="spinner" />
          Looking up the achievement and its holders…
        </div>
      ) : (
        achievementResult && (
          <>
            {achievementResult.groups ? (
              <>
                {achievementResult.groups.every((g) => g.holders.length > 0 || parisCache[g.campus.id]?.ready) && (
                  <p className="status-text total-count">
                    {achievementResult.groups.reduce(
                      (sum, g) => sum + (g.holders.length > 0 ? g.holders.length : (parisCache[g.campus.id]?.adders.length ?? 0)),
                      0,
                    )} student(s) total across all campuses
                  </p>
                )}
                {(() => {
                  // One Show (page size) and Promo control shared across every campus group,
                  // instead of each group needing its own — Promo options built from the
                  // union of promo years across every group's list (achievement holders
                  // where present, Paris-adders otherwise).
                  const allPromoYears = [...new Set(
                    achievementResult.groups.flatMap((g) =>
                      (g.holders.length > 0 ? g.holders : parisCache[g.campus.id]?.adders || [])
                        .map((s) => s.poolYear)
                        .filter(Boolean),
                    ),
                  )].sort().reverse();
                  return (
                    <div className="filters-row grid-controls">
                      <label className="filter-select">
                        Show
                        <select value={globalPageSize} onChange={(e) => setGlobalPageSize(Number(e.target.value))}>
                          {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </label>
                      {allPromoYears.length > 0 && (
                        <label className="filter-select">
                          Promo
                          <select value={globalPromoFilter} onChange={(e) => setGlobalPromoFilter(e.target.value)}>
                            <option value="">All</option>
                            {allPromoYears.map((y) => <option key={y} value={y}>{y}</option>)}
                          </select>
                        </label>
                      )}
                    </div>
                  );
                })()}
                {/* "All Morocco": one section per campus, holders never mixed together. */}
                {achievementResult.groups.map((g) => (
                <div key={g.campus.id} className="campus-group">
                  <h2 className="section-heading">
                    {g.campus.name} ({g.holders.length > 0 ? g.holders.length : (parisCache[g.campus.id]?.adders.length ?? 0)})
                  </h2>
                  {g.holders.length === 0 ? (
                    <ParisAddersSection
                      campusId={g.campus.id}
                      campusName={g.campus.name}
                      showCount={false}
                      cached={parisCache[g.campus.id]}
                      loading={Boolean(parisLoading[g.campus.id])}
                      error={parisError[g.campus.id]}
                      onLoad={loadParisAdders}
                      onOpenStudent={openHolderDetail}
                      globalPromoFilter={globalPromoFilter}
                      globalPageSize={globalPageSize}
                    />
                  ) : (
                    <PaginatedStudentGrid
                      key={g.campus.id}
                      students={withRecentParisFlag(g.campus.id, g.holders)}
                      onOpenStudent={openHolderDetail}
                      globalPromoFilter={globalPromoFilter}
                      globalPageSize={globalPageSize}
                    />
                  )}
                  <RecentParisSwitchersSection
                    students={switchers.filter((s) => s.campusId === g.campus.id)}
                    loading={switchersLoading}
                    onOpenStudent={openHolderDetail}
                  />
                </div>
                ))}
              </>
            ) : (
              <>
                {achievementResult.holders.length === 0 ? (
                  <ParisAddersSection
                    campusId={Number(selectedCampusId)}
                    campusName={campuses.find((c) => String(c.id) === selectedCampusId)?.name}
                    cached={parisCache[Number(selectedCampusId)]}
                    loading={Boolean(parisLoading[Number(selectedCampusId)])}
                    error={parisError[Number(selectedCampusId)]}
                    onLoad={loadParisAdders}
                    onOpenStudent={openHolderDetail}
                  />
                ) : (
                  <>
                    <p className="status-text">
                      {achievementResult.holders.length} student(s) at{' '}
                      {campuses.find((c) => String(c.id) === selectedCampusId)?.name}
                    </p>
                    <PaginatedStudentGrid
                      key={selectedCampusId}
                      students={withRecentParisFlag(Number(selectedCampusId), achievementResult.holders)}
                      onOpenStudent={openHolderDetail}
                    />
                  </>
                )}
                <RecentParisSwitchersSection
                  students={switchers.filter((s) => s.campusId === Number(selectedCampusId))}
                  loading={switchersLoading}
                  onOpenStudent={openHolderDetail}
                />
              </>
            )}
          </>
        )
      )}

      {detailError && <p className="error-text">{detailError}</p>}
      {detailLoading && (
        <div className="loading-overlay">
          <div className="spinner-large" />
        </div>
      )}

      {detailStudent && (
        <StudentDetailModal
          login={detailStudent.login}
          profile={detailStudent}
          loading={false}
          error={null}
          onClose={closeDetail}
        />
      )}

      <footer className="footer">
        <p className="footer-label">Built by</p>
        <p className="footer-name">Abdellatyf en neiymy</p>
        <p className="footer-meta">
          aben-nei · <a href="https://profile.intra.42.fr/users/aben-nei" target="_blank" rel="noreferrer">42 Profile</a>
        </p>
      </footer>

      <ScrollToTopButton />
    </div>
  );
};

export default App;
