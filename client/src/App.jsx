import { useEffect, useRef, useState } from 'react';
import {
  LOGIN_URL,
  fetchAchievedDate,
  fetchAchievementHolders,
  fetchAllCampusParisAdders,
  fetchCampuses,
  fetchMe,
  fetchStudentProfile,
  logout,
} from './api.js';
import StudentCard from './components/StudentCard.jsx';
import StudentDetailModal from './components/StudentDetailModal.jsx';

const DEFAULT_ACHIEVEMENT = 'Je voudrais un croissant';

// Tétouan (55) and Rabat (75) have never had a holder of this achievement — searching for it
// there is a guaranteed-empty API call. Skip straight to the Paris-on-profile check instead.
const NO_ACHIEVEMENT_CAMPUS_IDS = [55, 75];

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
const PaginatedStudentGrid = ({ students, onOpenStudent }) => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [promoFilter, setPromoFilter] = useState('');

  const promoYears = [...new Set(students.map((s) => s.poolYear).filter(Boolean))].sort().reverse();
  const filtered = promoFilter ? students.filter((s) => s.poolYear === promoFilter) : students;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const start = (clampedPage - 1) * pageSize;
  const pageStudents = filtered.slice(start, start + pageSize);

  return (
    <>
      <div className="filters-row grid-controls">
        <label className="filter-select">
          Show
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
            {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {promoYears.length > 0 && (
          <label className="filter-select">
            Promo
            <select value={promoFilter} onChange={(e) => { setPromoFilter(e.target.value); setPage(1); }}>
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
const ParisAddersSection = ({ campusId, campusName, showCount = true, cached, loading, error, onLoad, onOpenStudent }) => {
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
      <PaginatedStudentGrid key={campusId} students={sortedAdders} onOpenStudent={onOpenStudent} />
    </>
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
  const [achievementResult, setAchievementResult] = useState(null);
  const [achievementError, setAchievementError] = useState(null);
  const [achievementLoading, setAchievementLoading] = useState(false);
  // Keyed by campus id ('' = All Morocco) — switching back to an already-fetched campus
  // reuses this instead of hitting the API again. Only "Refresh" bypasses it.
  const [cache, setCache] = useState({});

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
  // whatever's been found so far.
  const [parisCache, setParisCache] = useState({});
  const [parisLoading, setParisLoading] = useState({});
  const [parisError, setParisError] = useState({});

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

    if (campusId && NO_ACHIEVEMENT_CAMPUS_IDS.includes(Number(campusId))) {
      const empty = { achievement: null, holders: [] };
      setAchievementResult(empty);
      setCache((prev) => ({ ...prev, [key]: empty }));
      setAchievementError(null);
      setAchievementLoading(false);
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
            loadHolders(selectedCampusId, { force: true });
            if (selectedCampusId && NO_ACHIEVEMENT_CAMPUS_IDS.includes(Number(selectedCampusId))) {
              loadParisAdders(Number(selectedCampusId), { force: true });
            } else if (!selectedCampusId) {
              NO_ACHIEVEMENT_CAMPUS_IDS.forEach((id) => loadParisAdders(id, { force: true }));
            }
          }}
          disabled={achievementLoading}
        >
          {achievementLoading ? 'Loading…' : 'Refresh'}
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
                    />
                  ) : (
                    <PaginatedStudentGrid key={g.campus.id} students={g.holders} onOpenStudent={openHolderDetail} />
                  )}
                </div>
                ))}
              </>
            ) : achievementResult.holders.length === 0 ? (
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
                <PaginatedStudentGrid key={selectedCampusId} students={achievementResult.holders} onOpenStudent={openHolderDetail} />
              </>
            )}
          </>
        )
      )}

      {detailError && <p className="error-text">{detailError}</p>}
      {detailLoading && <p className="status-text">Loading profile…</p>}

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
