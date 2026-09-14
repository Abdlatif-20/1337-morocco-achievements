import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  LOGIN_URL,
  fetchAchievedDate,
  fetchAchievementHolders,
  fetchCampusParisAdders,
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
const ACHIEVEMENT_CACHE_TTL_MS = 60 * 60 * 1000;
const PARIS_CACHE_TTL_MS = 60 * 60 * 1000;

// Tétouan (55) and Rabat (75) have never had a holder of this achievement — searching for it
// there is a guaranteed-empty API call. Skip straight to the Paris-on-profile check instead.
const NO_ACHIEVEMENT_CAMPUS_IDS = [55, 75];
const RABAT_CAMPUS_ID = 75;

// Shimmering student-card-shaped placeholders shown while a list is loading, instead of a
// plain spinner — gives an idea of the shape of what's coming instead of a blank wait.
const SkeletonCard = () => (
  <div className="student-card skeleton-card">
    <div className="skeleton-avatar" />
    <div className="student-info">
      <div className="skeleton-line skeleton-line-wide" />
      <div className="skeleton-line skeleton-line-narrow" />
    </div>
  </div>
);

const SkeletonGrid = ({ count = 6 }) => (
  <div className="student-grid">
    {Array.from({ length: count }, (_, i) => <SkeletonCard key={i} />)}
  </div>
);

// Defers actually mounting a StudentCard until it's about to scroll into view — shows the
// same skeleton placeholder in its place until then. `rootMargin` starts the swap a bit
// before the card is actually visible so it's ready by the time scrolling reaches it. Once
// shown, stays mounted (observer disconnects) — no point re-hiding a card the user already saw.
const LazyCard = ({ student, onOpen }) => {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible || !ref.current) { return; }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) { setVisible(true); }
      },
      { rootMargin: '200px' },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);

  return <div ref={ref}>{visible ? <StudentCard student={student} onOpen={onOpen} /> : <SkeletonCard />}</div>;
};

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

// Generic custom picker — a button showing the current selection that opens a floating list
// of options, instead of a native <select>. Same open/close-on-outside-click pattern as
// AccountMenu above. `options` is [{ value, label }]; `label`, if given, renders as a
// non-interactive prefix (e.g. "Show", "Promo") the way the old <label className="filter-
// select"> selects did.
const Dropdown = ({ label, value, options, onChange }) => {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) { return; }
    const close = (e) => {
      if (wrapRef.current?.contains(e.target)) { return; }
      if (menuRef.current?.contains(e.target)) { return; }
      setOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const toggleOpen = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 6, left: rect.left });
    }
    setOpen((v) => !v);
  };

  const current = options.find((o) => String(o.value) === String(value)) ?? options[0];

  return (
    <div className="dropdown-wrap" ref={wrapRef}>
      {label && <span className="dropdown-label">{label}</span>}
      <div className="dropdown">
        <button ref={btnRef} type="button" className="dropdown-btn" onClick={toggleOpen}>
          {current?.label}
          <span className={`dropdown-chevron${open ? ' dropdown-chevron-open' : ''}`}>▾</span>
        </button>
        {open && menuPos && (
          createPortal(
            <div ref={menuRef} className="dropdown-menu" style={{ position: 'fixed', top: menuPos.top, left: menuPos.left }}>
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`dropdown-option${String(o.value) === String(value) ? ' dropdown-option-active' : ''}`}
                  onClick={() => { onChange(o.value); setOpen(false); }}
                >
                  {o.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        )}
      </div>
    </div>
  );
};

const CampusDropdown = ({ campuses, selectedCampusId, onChange }) => (
  <Dropdown
    value={selectedCampusId}
    options={[{ value: '', label: 'All Morocco' }, ...campuses.map((c) => ({ value: String(c.id), label: c.name }))]}
    onChange={onChange}
  />
);

// Fallback shown for a campus with zero achievement holders (Tétouan/Rabat, always empty so
// far): students there who have 42 Paris on their profile. Paginated server-side just like
// the achievement holders view — only enough of the campus roster gets scanned to cover the
// requested page/size (see server/index.js's getParisAddersPage), so Show/Prev/Next each
// trigger a real request instead of slicing one big pre-fetched list. No Promo filter here,
// same trade-off as the holders view: knowing which promo years exist needs the whole list.
const ParisAddersSection = ({ campusName, showCount = true, hideControls = false, page, pageSize, promo, promoYears, result, exactTotal, loading, error, onPageChange, onPageSizeChange, onPromoChange, onOpenStudent }) => {
  if (error) {
    return <p className="error-text">{error}</p>;
  }
  const adders = result?.adders || [];
  if (loading && adders.length === 0) {
    return (
      <>
        <p className="status-text">No achievement holders here — checking who has 42 Paris on their profile…</p>
        <SkeletonGrid />
      </>
    );
  }
  if (page === 1 && adders.length === 0) {
    return (
      <p className="status-text">
        {promo
          ? `No students from promo ${promo} here have 42 Paris on their profile.`
          : 'No students hold this achievement here, and none have 42 Paris on their profile.'}
      </p>
    );
  }
  // Dedupe (the scan can't produce duplicates, but cheap to guard), sort alphabetically so
  // the page reads consistently instead of raw campus-roster order, and drop `campuses` —
  // StudentCard would otherwise show "Tétouan, Paris" under every name, which is redundant
  // with the section heading/status line right above the grid.
  const sortedAdders = [...new Map(adders.map((a) => [a.id, a])).values()]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map(({ campuses, ...rest }) => rest);
  return (
    <>
      {!hideControls && (
        <div className="filters-row grid-controls">
          <Dropdown
            label="Show"
            value={pageSize}
            options={PAGE_SIZE_OPTIONS.map((n) => ({ value: n, label: String(n) }))}
            onChange={(v) => onPageSizeChange(Number(v))}
          />
          {promoYears?.length > 0 && (
            <Dropdown
              label="Promo"
              value={promo}
              options={[{ value: '', label: 'All' }, ...promoYears.map((y) => ({ value: y, label: String(y) }))]}
              onChange={onPromoChange}
            />
          )}
        </div>
      )}
      {showCount && (
        <p className="status-text">
          {exactTotal != null ? `${exactTotal} student(s)` : `Page ${page}`} at {campusName}
        </p>
      )}
      <div className="student-grid">
        {sortedAdders.map((s) => (
          <LazyCard key={s.id} student={s} onOpen={() => onOpenStudent(s)} />
        ))}
      </div>
      <div className="pagination">
        <button type="button" onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page === 1 || loading}>
          ← Prev
        </button>
        <span>Page {page}</span>
        <button type="button" onClick={() => onPageChange(page + 1)} disabled={!result?.hasMore || loading}>
          Next →
        </button>
      </div>
    </>
  );
};

// Shown under Khouribga/Benguerir's achievement holders (whether or not that list itself has
// results) — students the API's filter[primary_campus_id] can no longer see (their primary
// campus is now Paris) but who genuinely made that switch recently. The parent already
// triggers the background Paris-adders fetch this reads from (same one powering the ✈️
// badge), so this never fires its own network request.
const RecentParisSwitchersSection = ({ students, loading, campusId, onOpenStudent }) => {
  // Rabat has zero students full stop, verified live (see server/index.js) — no point
  // showing a "checking…" spinner for a campus that structurally can never have a switcher.
  const effectiveLoading = campusId === RABAT_CAMPUS_ID ? false : loading;
  if (effectiveLoading && students.length === 0) {
    return (
      <>
        <p className="status-text">Checking for students who recently switched to Paris Campus…</p>
        <SkeletonGrid count={3} />
      </>
    );
  }
  const sorted = [...students].sort((a, b) => a.displayName.localeCompare(b.displayName));
  return (
    <div className="campus-group">
      <h2 className="section-heading">✈️ Recently switched to Paris Campus ({sorted.length})</h2>
      {sorted.length === 0 ? (
        <p className="status-text">
          No students here have switched their primary campus to 42 Paris since August.
        </p>
      ) : (
        <div className="student-grid">
          {sorted.map((s) => (
            <LazyCard key={s.id} student={s} onOpen={() => onOpenStudent(s)} />
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
  // When on, hides the normal holders/Paris-adders view entirely and shows only the
  // "✈️ Recently switched to 42 Paris" section(s) — the underlying data is already fetched
  // either way, this is purely a display filter.
  const [switchersOnly, setSwitchersOnly] = useState(false);
  // Only meaningful in the "All Morocco" (grouped) view — one page size shared by every
  // campus group instead of each group having its own (Prev/Next stay per-campus though —
  // see `groupPages`). No Promo filter here anymore: filtering by promo year needs seeing a
  // campus's whole holder list to know which years even exist, which defeats the point of
  // backend pagination (only fetching the page actually requested).
  const [globalPageSize, setGlobalPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [globalPromo, setGlobalPromo] = useState('');
  useEffect(() => { setGlobalPageSize(PAGE_SIZE_OPTIONS[0]); setGlobalPromo(''); }, [selectedCampusId]);
  const [achievementResult, setAchievementResult] = useState(null);
  const [achievementError, setAchievementError] = useState(null);
  const [achievementLoading, setAchievementLoading] = useState(false);
  // Single-campus holders are paginated server-side (see server/index.js) — only this page's
  // worth ever gets fetched/held client-side. Reset to page 1 whenever the campus or page
  // size changes, so neither carries a stale page number into a fresh selection.
  const [holdersPage, setHoldersPage] = useState(1);
  const [holdersPageSize, setHoldersPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [holdersPromo, setHoldersPromo] = useState('');
  useEffect(() => { setHoldersPage(1); setHoldersPromo(''); }, [selectedCampusId, holdersPageSize]);

  // "All Morocco" is now ALSO backend-paginated: instead of one big request that fetches
  // every campus's full holder list, each campus group is fetched independently through the
  // same paginated single-campus endpoint, one page at a time — reusing `globalPageSize` as
  // the shared "Show" control, but each group keeps its OWN page number so Prev/Next on one
  // campus doesn't touch the others (matches the old client-side-slicing behavior, where each
  // group's PaginatedStudentGrid instance paginated independently).
  const [groupPages, setGroupPages] = useState({}); // campusId -> page
  const [groupResults, setGroupResults] = useState({}); // campusId -> { holders, hasMore, page }
  const [groupLoading, setGroupLoading] = useState({}); // campusId -> bool
  const anyGroupLoading = Object.values(groupLoading).some(Boolean);
  useEffect(() => { setGroupPages({}); }, [selectedCampusId, globalPageSize]);
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

  // Used for the ✈️ badge cross-reference (any campus with real holders) — needs the FULL
  // Paris-adders list, not one page, since a badge lookup has to check any given holder's
  // login against the whole set. Requests an effectively-unbounded pageSize so the server
  // (see getParisAddersPage) just keeps scanning roster pages until exhausted — the same
  // incremental cache entry a paginated request would've built anyway, just driven to
  // completion in one call instead of many small ones.
  const loadParisAdders = (campusId, { force = false } = {}) => {
    if (!force && parisCache[campusId]?.ready) { return; }
    if (parisLoading[campusId]) { return; }

    setParisLoading((prev) => ({ ...prev, [campusId]: true }));
    setParisError((prev) => ({ ...prev, [campusId]: null }));
    fetchCampusParisAdders(campusId, { refresh: force, page: 1, pageSize: 100000 })
      .then((res) => {
        setParisCache((prev) => ({ ...prev, [campusId]: { adders: res.adders, ready: true } }));
      })
      .catch((err) => {
        if (err.status === 401) { setMe(null); return; }
        setParisError((prev) => ({ ...prev, [campusId]: err.message }));
      })
      .finally(() => {
        setParisLoading((prev) => ({ ...prev, [campusId]: false }));
      });
  };

  // The paginated DISPLAY version — Tétouan/Rabat's own fallback view, Show/Prev/Next driving
  // real per-page requests instead of slicing a big pre-fetched list.
  const [addersPage, setAddersPage] = useState({}); // campusId -> page
  const [addersPageSize, setAddersPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [addersResult, setAddersResult] = useState({}); // campusId -> { adders, hasMore }
  const [addersLoading, setAddersLoading] = useState({});
  const [addersError, setAddersError] = useState({});
  // Grouped "All Morocco" view's Paris-adders fallback shares globalPageSize (not
  // addersPageSize, which is only for the single-campus fallback's own local Show control) —
  // reset each campus's adders page back to 1 whenever the campus selection or that global
  // page size changes, same as groupPages above.
  useEffect(() => { setAddersPage({}); }, [selectedCampusId, globalPageSize]);

  // Exact Paris-adders count per campus — null until a background full-roster-scan request
  // (same trick as ensureExactTotal for achievement holders) finishes.
  const [exactAddersTotals, setExactAddersTotals] = useState({}); // campusId -> number

  const [addersPromoYears, setAddersPromoYears] = useState({}); // campusId -> string[]
  const [addersPromo, setAddersPromo] = useState({}); // campusId -> selected year ('' = all)

  const ensureExactAddersTotal = (campusId) => {
    if (exactAddersTotals[campusId] != null) { return; }
    fetchCampusParisAdders(campusId, { page: 1, pageSize: 1000000 })
      .then((res) => {
        if (res.exactTotal != null) {
          setExactAddersTotals((prev) => ({ ...prev, [campusId]: res.exactTotal }));
        }
        if (res.promoYears) {
          setAddersPromoYears((prev) => ({ ...prev, [campusId]: res.promoYears }));
        }
      })
      .catch(() => {});
  };

  const loadAddersPage = (campusId, { force = false, page, pageSize, promo } = {}) => {
    const p = page ?? addersPage[campusId] ?? 1;
    const size = pageSize ?? addersPageSize;
    const yr = promo ?? addersPromo[campusId] ?? '';
    setAddersLoading((prev) => ({ ...prev, [campusId]: true }));
    setAddersError((prev) => ({ ...prev, [campusId]: null }));
    fetchCampusParisAdders(campusId, { refresh: force, page: p, pageSize: size, promo: yr })
      .then((res) => {
        setAddersResult((prev) => ({ ...prev, [campusId]: res }));
        ensureExactAddersTotal(campusId);
      })
      .catch((err) => {
        if (err.status === 401) { setMe(null); return; }
        setAddersError((prev) => ({ ...prev, [campusId]: err.message }));
      })
      .finally(() => setAddersLoading((prev) => ({ ...prev, [campusId]: false })));
  };

  // The achievement-gated version of the Paris-adders scan — students who genuinely hold the
  // achievement this year AND made Paris their primary campus since August, which is exactly
  // the group invisible to the normal per-campus holders query. Scoped to this achievement's
  // this-year holders only (a few hundred, worldwide), NOT a full campus roster scan, so it's
  // one shared fetch for every campus instead of one scan per campus — each result already
  // carries its own `campusId` (the Moroccan campus it's grouped under).
  const [switchers, setSwitchers] = useState(() => readCache('parisSwitchers', PARIS_CACHE_TTL_MS) || []);
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

  // Exact per-campus holder count (post staff/this-year filtering) — null until a background
  // full-scan request (see ensureExactTotal) finishes. Kept separate from achievementResult
  // since it survives page/pageSize changes and grouped-vs-single-campus switches, instead of
  // being re-derived (and re-fetched) every time either of those change.
  const [exactTotals, setExactTotals] = useState({}); // campusId -> number
  const [holdersPromoYears, setHoldersPromoYears] = useState({}); // campusId -> string[]

  const ensureExactTotal = (campusId) => {
    if (exactTotals[campusId] != null) { return; }
    fetchAchievementHolders(DEFAULT_ACHIEVEMENT, campusId, { page: 1, pageSize: 1000000 })
      .then((res) => {
        if (res.exactTotal != null) {
          setExactTotals((prev) => ({ ...prev, [campusId]: res.exactTotal }));
        }
        if (res.promoYears) {
          setHoldersPromoYears((prev) => ({ ...prev, [campusId]: res.promoYears }));
        }
      })
      .catch(() => {});
  };

  const loadHolders = (campusId, { force = false, page = holdersPage, pageSize = holdersPageSize, promo = holdersPromo } = {}) => {
    const key = `${campusId}:${page}:${pageSize}:${promo}`;
    latestHoldersKeyRef.current = key;

    // ensureExactTotal for this campusId is fired eagerly, in parallel, from the effect that
    // calls loadHolders (see below) — not repeated here, to avoid sending the same expensive
    // full-scan request twice concurrently.
    if (!force && cache[key]) {
      setAchievementResult(cache[key]);
      setAchievementError(null);
      return;
    }

    setAchievementLoading(true);
    setAchievementError(null);
    fetchAchievementHolders(DEFAULT_ACHIEVEMENT, campusId, { refresh: force, page, pageSize, promo })
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

  // "All Morocco": each campus group is its own independent paginated fetch through the same
  // endpoint used for a single selected campus — see the `groupPages`/`groupResults` state
  // above for why.
  const loadGroupCampus = (campusId, { force = false, page, promo = globalPromo } = {}) => {
    const p = page ?? groupPages[campusId] ?? 1;
    const key = `${campusId}:${p}:${globalPageSize}:${promo}`;

    if (!force && cache[key]) {
      setGroupResults((prev) => ({ ...prev, [campusId]: cache[key] }));
      ensureExactTotal(campusId);
      return;
    }

    setGroupLoading((prev) => ({ ...prev, [campusId]: true }));
    fetchAchievementHolders(DEFAULT_ACHIEVEMENT, campusId, { refresh: force, page: p, pageSize: globalPageSize, promo })
      .then((res) => {
        setCache((prev) => ({ ...prev, [key]: res }));
        setGroupResults((prev) => ({ ...prev, [campusId]: res }));
        ensureExactTotal(campusId);
      })
      .catch((err) => {
        if (err.status === 401) { setMe(null); }
      })
      .finally(() => setGroupLoading((prev) => ({ ...prev, [campusId]: false })));
  };

  useEffect(() => {
    if (!me || !selectedCampusId) { return; }
    loadHolders(selectedCampusId, { page: holdersPage, pageSize: holdersPageSize, promo: holdersPromo });
    // For a single selected campus, start the full-scan exact-total request RIGHT AWAY, in
    // parallel with the paginated page fetch — not queued behind it. Only one campus to scan
    // here (fast enough to show immediately), unlike "All Morocco" where 4 campuses' worth of
    // background scans firing at once would be worse, so that view still only starts a
    // campus's scan once ITS holders have already resolved (see loadGroupCampus's `.then`).
    ensureExactTotal(Number(selectedCampusId));
  }, [me, selectedCampusId, holdersPage, holdersPageSize, holdersPromo]);

  useEffect(() => {
    if (!me || selectedCampusId || campuses.length === 0) { return; }
    campuses.forEach((c) => loadGroupCampus(c.id, { page: 1, promo: globalPromo }));
  }, [me, selectedCampusId, globalPageSize, globalPromo, campuses]);

  // Whenever the holders list resolves and it includes Khouribga/Benguerir with real
  // holders, quietly kick off (or reuse the cache of) the per-campus raw Paris-adders scan
  // (powers the ✈️ badge on existing holder cards) — doesn't block or slow down the holders
  // list itself.
  useEffect(() => {
    if (!achievementResult) { return; }
    // Which campuses actually have holders shown right now changes over time (Tétouan, once
    // always empty, now genuinely has some) — so this runs for any campus with holders,
    // not a fixed hardcoded pair.
    if (achievementResult.holders?.length > 0 && selectedCampusId) {
      loadParisAdders(Number(selectedCampusId));
    }
  }, [achievementResult]);

  // Same as above, but for "All Morocco" — one campus's group resolving with holders
  // triggers that campus's own Paris-adders scan.
  useEffect(() => {
    if (selectedCampusId) { return; }
    Object.entries(groupResults).forEach(([campusId, res]) => {
      if (res?.holders?.length > 0) { loadParisAdders(Number(campusId)); }
    });
  }, [groupResults, selectedCampusId]);

  // Triggers the DISPLAY-paginated Paris-adders fetch (Tétouan/Rabat's own fallback view)
  // once a campus's holders result comes back empty on page 1 — mirrors how the holders
  // fetch itself is triggered, just for this fallback view instead.
  useEffect(() => {
    if (!selectedCampusId) { return; }
    const id = Number(selectedCampusId);
    const pageEmpty = achievementResult?.page === 1 && achievementResult.holders.length === 0;
    // Same distinction as the grouped view: only a real Paris-adders campus if it
    // structurally never has holders, or no promo filter is narrowing things down.
    if (pageEmpty && (NO_ACHIEVEMENT_CAMPUS_IDS.includes(id) || !holdersPromo)) {
      if (!addersLoading[id] && !addersResult[id]) { loadAddersPage(id, { page: 1 }); }
    }
  }, [achievementResult, selectedCampusId, holdersPromo]);

  // In the grouped "All Morocco" view, the Paris-adders fallback uses the SAME global
  // Show/Promo controls as the rest of the view (no per-campus controls of its own) — so this
  // re-fetches whenever those change too, not just when a campus's holders result changes.
  useEffect(() => {
    if (selectedCampusId) { return; }
    Object.entries(groupResults).forEach(([campusIdStr, res]) => {
      const id = Number(campusIdStr);
      const page = groupPages[id] ?? 1;
      const pageEmpty = page === 1 && (res?.holders?.length ?? 0) === 0;
      // Only actually a Paris-adders campus if it structurally never has holders — a normal
      // campus whose page is empty just because the promo filter matched nobody doesn't need
      // this (different, unrelated) scan at all.
      if (pageEmpty && NO_ACHIEVEMENT_CAMPUS_IDS.includes(id)) {
        loadAddersPage(id, { page: 1, pageSize: globalPageSize, promo: globalPromo });
      }
    });
  }, [groupResults, selectedCampusId, globalPageSize, globalPromo]);

  // The achievement-gated switchers list is one shared fetch (not per campus) — triggered
  // once whenever there's a holders result to show it alongside, regardless of which
  // Moroccan campus(es) that result covers.
  useEffect(() => {
    if (!achievementResult && Object.keys(groupResults).length === 0) { return; }
    loadParisSwitchers();
  }, [achievementResult, groupResults]);

  // null when the student isn't a recent Paris-adder for this campus, otherwise the date
  // Paris was added to their profile — recency is judged against RECENT_PARIS_MOVE_MS.
  const getRecentParisJoin = (campusId, login) => {
    const match = parisCache[campusId]?.adders?.find((a) => a.login === login);
    if (!match?.parisJoinedAt || !match.isPrimary) { return null; }
    const age = Date.now() - new Date(match.parisJoinedAt).getTime();
    return age >= 0 && age < RECENT_PARIS_MOVE_MS ? match.parisJoinedAt : null;
  };

  const withRecentParisFlag = (campusId, holders) =>
    holders.map((h) => ({ ...h, recentParisMove: Boolean(getRecentParisJoin(campusId, h.login)) }));

  // 42's filter[primary_campus_id] can lag right after a primary-campus flip — a student who
  // just switched to Paris can still show up under their old campus's holders list for a
  // while, duplicating them against the "Recently switched to 42 Paris" section below. Drop
  // anyone already accounted for there, since we already have that data loaded.
  const excludeSwitchers = (campusId, holders) => {
    const switcherLogins = new Set(switchers.filter((s) => s.campusId === campusId).map((s) => s.login));
    return holders.filter((h) => !switcherLogins.has(h.login));
  };

  // The number actually shown for a campus in the "All Morocco" view — matches whichever
  // dataset that campus's section is rendering: achievement holders normally, or Paris-adders
  // when a campus has zero holders and falls back to that list instead (Tétouan today). Used
  // both for each campus's own heading and for the grand total, so the two always agree —
  // summing achievement-holder counts alone would silently drop campuses like Tétouan that
  // are showing a real, non-empty list via the fallback.
  const campusDisplayTotal = (c) => {
    const res = groupResults[c.id];
    const page = groupPages[c.id] ?? 1;
    const isAddersFallback = page === 1 && (res?.holders?.length ?? 0) === 0;
    return isAddersFallback ? exactAddersTotals[c.id] : (exactTotals[c.id] ?? null);
  };

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
        <CampusDropdown campuses={campuses} selectedCampusId={selectedCampusId} onChange={setSelectedCampusId} />

        <label className="switch-toggle">
          <input
            type="checkbox"
            checked={switchersOnly}
            onChange={(e) => setSwitchersOnly(e.target.checked)}
          />
          <span className="switch-track" />
          ✈️ Paris switchers
        </label>

        <button
          type="button"
          className="refresh-btn"
          onClick={() => {
            if (refreshesLeft <= 0) { return; }
            setRefreshUses(recordUse(REFRESH_USE_KEY, REFRESH_WINDOW_MS));
            if (selectedCampusId) {
              loadHolders(selectedCampusId, { force: true, page: holdersPage, pageSize: holdersPageSize, promo: holdersPromo });
              if (NO_ACHIEVEMENT_CAMPUS_IDS.includes(Number(selectedCampusId))) {
                loadParisAdders(Number(selectedCampusId), { force: true });
                loadAddersPage(Number(selectedCampusId), { force: true, page: 1 });
              }
            } else {
              campuses.forEach((c) => loadGroupCampus(c.id, { force: true, page: groupPages[c.id] ?? 1, promo: globalPromo }));
              NO_ACHIEVEMENT_CAMPUS_IDS.forEach((id) => {
                loadParisAdders(id, { force: true });
                loadAddersPage(id, { force: true, page: 1 });
              });
            }
          }}
          disabled={(selectedCampusId ? achievementLoading : anyGroupLoading) || refreshesLeft <= 0}
          title={refreshesLeft <= 0 ? 'Refresh limit reached — try again in a bit' : `${refreshesLeft} refresh(es) left this hour`}
        >
          {(selectedCampusId ? achievementLoading : anyGroupLoading) ? 'Loading…' : refreshesLeft <= 0 ? 'Limit reached' : `Refresh (${refreshesLeft})`}
        </button>
      </div>

      {achievementError && <p className="error-text">{achievementError}</p>}

      {selectedCampusId ? (
        achievementLoading && !achievementResult?.holders?.length ? (
          <>
            <p className="status-text">Looking up the achievement and its holders…</p>
            <SkeletonGrid />
          </>
        ) : (
          achievementResult && (
            <>
              {achievementLoading && achievementResult.holders && (
                <div className="inline-loading">
                  <span className="spinner" />
                  Loading…
                </div>
              )}
              {switchersOnly ? (
                // Toggle is on: skip the normal holders/Paris-adders view entirely and show
                // only the "recently switched" section(s) — same underlying data, already
                // fetched either way, just a display filter.
                <RecentParisSwitchersSection
                  students={switchers.filter((s) => s.campusId === Number(selectedCampusId))}
                  loading={switchersLoading}
                  campusId={Number(selectedCampusId)}
                  onOpenStudent={openHolderDetail}
                />
              ) : (
                <>
                  {achievementResult.page === 1 && achievementResult.holders.length === 0 && holdersPromo &&
                  !NO_ACHIEVEMENT_CAMPUS_IDS.includes(Number(selectedCampusId)) ? (
                    // A promo filter is active and yielded nothing for THIS filter — not the
                    // same as the campus having zero holders overall, so don't fall back to
                    // the Paris-adders view (that fallback is for campuses with no holders at
                    // all, regardless of promo).
                    <p className="status-text">No students from promo {holdersPromo} hold this achievement here.</p>
                  ) : achievementResult.page === 1 && achievementResult.holders.length === 0 ? (
                    <ParisAddersSection
                      campusName={campuses.find((c) => String(c.id) === selectedCampusId)?.name}
                      page={addersPage[Number(selectedCampusId)] ?? 1}
                      pageSize={addersPageSize}
                      result={addersResult[Number(selectedCampusId)]}
                      exactTotal={exactAddersTotals[Number(selectedCampusId)]}
                      promo={addersPromo[Number(selectedCampusId)] ?? ''}
                      promoYears={addersPromoYears[Number(selectedCampusId)]}
                      loading={Boolean(addersLoading[Number(selectedCampusId)])}
                      error={addersError[Number(selectedCampusId)]}
                      onPageChange={(p) => {
                        setAddersPage((prev) => ({ ...prev, [Number(selectedCampusId)]: p }));
                        loadAddersPage(Number(selectedCampusId), { page: p });
                      }}
                      onPageSizeChange={(size) => {
                        setAddersPageSize(size);
                        setAddersPage((prev) => ({ ...prev, [Number(selectedCampusId)]: 1 }));
                        loadAddersPage(Number(selectedCampusId), { page: 1, pageSize: size });
                      }}
                      onPromoChange={(year) => {
                        setAddersPromo((prev) => ({ ...prev, [Number(selectedCampusId)]: year }));
                        setAddersPage((prev) => ({ ...prev, [Number(selectedCampusId)]: 1 }));
                        loadAddersPage(Number(selectedCampusId), { page: 1, promo: year });
                      }}
                      onOpenStudent={openHolderDetail}
                    />
                  ) : (
                    <>
                      <div className="filters-row grid-controls">
                        <Dropdown
                          label="Show"
                          value={holdersPageSize}
                          options={PAGE_SIZE_OPTIONS.map((n) => ({ value: n, label: String(n) }))}
                          onChange={(v) => setHoldersPageSize(Number(v))}
                        />
                        {holdersPromoYears[Number(selectedCampusId)]?.length > 0 && (
                          <Dropdown
                            label="Promo"
                            value={holdersPromo}
                            options={[
                              { value: '', label: 'All' },
                              ...holdersPromoYears[Number(selectedCampusId)].map((y) => ({ value: y, label: String(y) })),
                            ]}
                            onChange={(year) => { setHoldersPromo(year); setHoldersPage(1); }}
                          />
                        )}
                      </div>
                      <p className="status-text">
                        {holdersPromo
                          ? (achievementResult.exactTotal != null
                              ? `${achievementResult.exactTotal} student(s)`
                              : `Page ${achievementResult.page}`)
                          : exactTotals[Number(selectedCampusId)] != null
                            ? `${exactTotals[Number(selectedCampusId)]} student(s)`
                            : `Page ${achievementResult.page}`} at{' '}
                        {campuses.find((c) => String(c.id) === selectedCampusId)?.name}
                      </p>
                      <div className="student-grid">
                        {withRecentParisFlag(
                          Number(selectedCampusId),
                          excludeSwitchers(Number(selectedCampusId), achievementResult.holders),
                        ).map((s) => (
                          <LazyCard key={s.id} student={s} onOpen={() => openHolderDetail(s)} />
                        ))}
                      </div>
                      <div className="pagination">
                        <button
                          type="button"
                          onClick={() => setHoldersPage((p) => Math.max(1, p - 1))}
                          disabled={holdersPage === 1 || achievementLoading}
                        >
                          ← Prev
                        </button>
                        <span>Page {holdersPage}</span>
                        <button
                          type="button"
                          onClick={() => setHoldersPage((p) => p + 1)}
                          disabled={!achievementResult.hasMore || achievementLoading}
                        >
                          Next →
                        </button>
                      </div>
                    </>
                  )}
                  <RecentParisSwitchersSection
                    students={switchers.filter((s) => s.campusId === Number(selectedCampusId))}
                    loading={switchersLoading}
                    campusId={Number(selectedCampusId)}
                    onOpenStudent={openHolderDetail}
                  />
                </>
              )}
            </>
          )
        )
      ) : (
        campuses.length > 0 && (
          <>
            {switchersOnly ? (
              campuses.map((c) => (
                <div key={c.id} className="campus-group">
                  <h2 className="section-heading">{c.name}</h2>
                  <RecentParisSwitchersSection
                    students={switchers.filter((s) => s.campusId === c.id)}
                    loading={switchersLoading}
                    campusId={c.id}
                    onOpenStudent={openHolderDetail}
                  />
                </div>
              ))
            ) : (
              <>
                {campuses.every((c) => campusDisplayTotal(c) != null) && (
                  <p className="status-text total-count">
                    {campuses.reduce((sum, c) => sum + campusDisplayTotal(c), 0)} student(s) total across all campuses
                  </p>
                )}
                <div className="filters-row grid-controls">
                  <Dropdown
                    label="Show"
                    value={globalPageSize}
                    options={PAGE_SIZE_OPTIONS.map((n) => ({ value: n, label: String(n) }))}
                    onChange={(v) => setGlobalPageSize(Number(v))}
                  />
                  {(() => {
                    const allPromoYears = [...new Set(campuses.flatMap((c) => holdersPromoYears[c.id] || []))]
                      .sort()
                      .reverse();
                    return allPromoYears.length > 0 && (
                      <Dropdown
                        label="Promo"
                        value={globalPromo}
                        options={[{ value: '', label: 'All' }, ...allPromoYears.map((y) => ({ value: y, label: String(y) }))]}
                        onChange={(year) => {
                          setGlobalPromo(year);
                          setGroupPages({});
                          setAddersPage({});
                        }}
                      />
                    );
                  })()}
                </div>
                {/* "All Morocco": one section per campus, each independently paginated
                    through the same backend-paginated endpoint as a single selected campus. */}
                {campuses.map((c) => {
                  const res = groupResults[c.id];
                  const loading = Boolean(groupLoading[c.id]);
                  const page = groupPages[c.id] ?? 1;
                  const holders = res?.holders || [];
                  const pageEmpty = page === 1 && holders.length === 0;
                  // A campus with zero holders ALWAYS falls back to the Paris-adders view
                  // (regardless of promo — Tétouan/Rabat structurally never have holders). A
                  // normal campus whose page came back empty only because the promo filter
                  // matched nobody is a different case: show "no match" instead of switching
                  // to an entirely different dataset.
                  const isAddersFallback = pageEmpty && (NO_ACHIEVEMENT_CAMPUS_IDS.includes(c.id) || !globalPromo);
                  const isPromoEmpty = pageEmpty && !isAddersFallback;
                  return (
                    <div key={c.id} className="campus-group">
                      <h2 className="section-heading">
                        {c.name}
                        {/* Shows whichever total actually matches what's rendered below — a
                            campus with zero holders falls back to the Paris-adders list
                            instead (a different dataset), so its own total is shown there,
                            not the (misleading) achievement-holders one. */}
                        {isAddersFallback
                          ? (exactAddersTotals[c.id] != null ? ` (${exactAddersTotals[c.id]})` : '')
                          : (exactTotals[c.id] != null ? ` (${exactTotals[c.id]})` : '')}
                      </h2>
                      {loading && holders.length === 0 ? (
                        <SkeletonGrid />
                      ) : isPromoEmpty ? (
                        <p className="status-text">No students from promo {globalPromo} hold this achievement here.</p>
                      ) : isAddersFallback ? (
                        <ParisAddersSection
                          campusName={c.name}
                          showCount={false}
                          hideControls
                          page={addersPage[c.id] ?? 1}
                          pageSize={globalPageSize}
                          result={addersResult[c.id]}
                          exactTotal={exactAddersTotals[c.id]}
                          promo={globalPromo}
                          onPageChange={(p) => {
                            setAddersPage((prev) => ({ ...prev, [c.id]: p }));
                            loadAddersPage(c.id, { page: p, pageSize: globalPageSize, promo: globalPromo });
                          }}
                          loading={Boolean(addersLoading[c.id])}
                          error={addersError[c.id]}
                          onOpenStudent={openHolderDetail}
                        />
                      ) : (
                        <>
                          <div className="student-grid">
                            {withRecentParisFlag(c.id, excludeSwitchers(c.id, holders)).map((s) => (
                              <LazyCard key={s.id} student={s} onOpen={() => openHolderDetail(s)} />
                            ))}
                          </div>
                          <div className="pagination">
                            <button
                              type="button"
                              onClick={() => {
                                const nextPage = Math.max(1, page - 1);
                                setGroupPages((prev) => ({ ...prev, [c.id]: nextPage }));
                                loadGroupCampus(c.id, { page: nextPage });
                              }}
                              disabled={page === 1 || loading}
                            >
                              ← Prev
                            </button>
                            <span>Page {page}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const nextPage = page + 1;
                                setGroupPages((prev) => ({ ...prev, [c.id]: nextPage }));
                                loadGroupCampus(c.id, { page: nextPage });
                              }}
                              disabled={!res?.hasMore || loading}
                            >
                              Next →
                            </button>
                          </div>
                        </>
                      )}
                      <RecentParisSwitchersSection
                        students={switchers.filter((s) => s.campusId === c.id)}
                        loading={switchersLoading}
                        campusId={c.id}
                        onOpenStudent={openHolderDetail}
                      />
                    </div>
                  );
                })}
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
