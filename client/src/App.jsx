import { useEffect, useState } from 'react';
import {
  LOGIN_URL,
  fetchAchievedDate,
  fetchAchievementHolders,
  fetchCampuses,
  fetchMe,
  fetchStudentProfile,
  fetchWorldwideAchievementHolders,
  logout,
} from './api.js';
import StudentCard from './components/StudentCard.jsx';
import StudentDetailModal from './components/StudentDetailModal.jsx';

const DEFAULT_ACHIEVEMENT = 'Je voudrais un croissant';

const AUTH_ERROR_MESSAGES = {
  invalid_state: 'Login could not be verified — please try again.',
  login_failed: 'Login with 42 failed — please try again.',
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

  // 'achievement' = the existing Moroccan achievement-holders view; 'worldwide' = students
  // who unlocked the same achievement this year, home campus outside France. Fetched 20 at
  // a time — worldwideCursor is the opaque {page, offset} to resume from on "Load more".
  const [activeTab, setActiveTab] = useState('achievement');
  const [worldwideAchievement, setWorldwideAchievement] = useState(null);
  const [worldwideHolders, setWorldwideHolders] = useState([]);
  const [worldwideCursor, setWorldwideCursor] = useState({ page: 1, offset: 0 });
  const [worldwideHasMore, setWorldwideHasMore] = useState(true);
  const [worldwideLoading, setWorldwideLoading] = useState(false);
  const [worldwideError, setWorldwideError] = useState(null);
  const [worldwideLoaded, setWorldwideLoaded] = useState(false);

  useEffect(() => {
    if (!me) { return; }
    fetchCampuses().then(setCampuses).catch(() => {});
  }, [me]);

  const loadWorldwideHolders = ({ force = false, more = false } = {}) => {
    if (!force && !more && worldwideLoaded) { return; }
    const cursor = more ? worldwideCursor : { page: 1, offset: 0 };

    setWorldwideLoading(true);
    setWorldwideError(null);
    fetchWorldwideAchievementHolders(DEFAULT_ACHIEVEMENT, cursor)
      .then((res) => {
        setWorldwideAchievement(res.achievement);
        setWorldwideHolders((prev) => (more ? [...prev, ...res.holders] : res.holders));
        setWorldwideCursor(res.nextCursor || cursor);
        setWorldwideHasMore(Boolean(res.nextCursor));
        setWorldwideLoaded(true);
      })
      .catch((err) => {
        if (err.status === 401) { setMe(null); return; }
        if (err.message === 'ACHIEVEMENT_NOT_FOUND') {
          setWorldwideError(`No achievement named "${DEFAULT_ACHIEVEMENT}" found.`);
        } else {
          setWorldwideError(err.message);
        }
      })
      .finally(() => setWorldwideLoading(false));
  };

  useEffect(() => {
    if (!me || activeTab !== 'worldwide') { return; }
    loadWorldwideHolders();
  }, [me, activeTab]);

  const loadHolders = (campusId, { force = false } = {}) => {
    const key = campusId || '';
    if (!force && cache[key]) {
      setAchievementResult(cache[key]);
      setAchievementError(null);
      return;
    }

    setAchievementLoading(true);
    setAchievementError(null);
    setAchievementResult(null);
    fetchAchievementHolders(DEFAULT_ACHIEVEMENT, campusId || null)
      .then((res) => {
        setAchievementResult(res);
        setCache((prev) => ({ ...prev, [key]: res }));
      })
      .catch((err) => {
        if (err.status === 401) { setMe(null); return; }
        if (err.message === 'ACHIEVEMENT_NOT_FOUND') {
          setAchievementError(`No achievement named "${DEFAULT_ACHIEVEMENT}" found.`);
        } else {
          setAchievementError(err.message);
        }
      })
      .finally(() => setAchievementLoading(false));
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

      <div className="tabs-row">
        <button
          type="button"
          className={`tab-btn${activeTab === 'achievement' ? ' tab-btn-active' : ''}`}
          onClick={() => setActiveTab('achievement')}
        >
          Morocco → Paris
        </button>
        <button
          type="button"
          className={`tab-btn${activeTab === 'worldwide' ? ' tab-btn-active' : ''}`}
          onClick={() => setActiveTab('worldwide')}
        >
          Worldwide → Paris
        </button>
      </div>

      {activeTab === 'achievement' && (
      <>
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
          onClick={() => loadHolders(selectedCampusId, { force: true })}
          disabled={achievementLoading}
        >
          {achievementLoading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {achievementError && <p className="error-text">{achievementError}</p>}

      {achievementLoading ? (
        <p className="status-text">Looking up the achievement and its holders…</p>
      ) : (
        achievementResult && (
          <>
            <p className="status-text">
              "{achievementResult.achievement.name}"
              {achievementResult.achievement.description ? `: ${achievementResult.achievement.description}` : ''}
            </p>

            {achievementResult.groups ? (
              // "All Morocco": one section per campus, holders never mixed together.
              achievementResult.groups.map((g) => (
                <div key={g.campus.id} className="campus-group">
                  <h2 className="section-heading">{g.campus.name} ({g.holders.length})</h2>
                  {g.holders.length === 0 ? (
                    <p className="status-text">No students hold this achievement here yet.</p>
                  ) : (
                    <div className="student-grid">
                      {g.holders.map((h) => (
                        <StudentCard key={h.id} student={h} onOpen={() => openHolderDetail(h)} />
                      ))}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <>
                <p className="status-text">
                  {achievementResult.holders.length} student(s) at{' '}
                  {campuses.find((c) => String(c.id) === selectedCampusId)?.name}
                </p>
                <div className="student-grid">
                  {achievementResult.holders.map((h) => (
                    <StudentCard key={h.id} student={h} onOpen={() => openHolderDetail(h)} />
                  ))}
                </div>
                {achievementResult.holders.length === 0 && (
                  <p className="status-text">No students hold this achievement here yet.</p>
                )}
              </>
            )}
          </>
        )
      )}
      </>
      )}

      {activeTab === 'worldwide' && (
        <>
          <div className="filters-row">
            <p className="status-text">Students worldwide who earned this achievement this year (home campus outside France)</p>
            <button
              type="button"
              className="refresh-btn"
              onClick={() => loadWorldwideHolders({ force: true })}
              disabled={worldwideLoading}
            >
              {worldwideLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {worldwideError && <p className="error-text">{worldwideError}</p>}

          {worldwideLoading && worldwideHolders.length === 0 ? (
            <p className="status-text">Looking up the achievement and its worldwide holders…</p>
          ) : (
            worldwideAchievement && (
              <>
                <p className="status-text">
                  "{worldwideAchievement.name}" — {worldwideHolders.length} student(s) loaded
                </p>
                {worldwideHolders.length === 0 ? (
                  <p className="status-text">No non-France students hold this achievement this year yet.</p>
                ) : (
                  <div className="student-grid">
                    {worldwideHolders.map((h) => (
                      <StudentCard key={h.id} student={h} onOpen={() => openHolderDetail(h)} />
                    ))}
                  </div>
                )}
                {worldwideHasMore && (
                  <button
                    type="button"
                    className="refresh-btn"
                    onClick={() => loadWorldwideHolders({ more: true })}
                    disabled={worldwideLoading}
                  >
                    {worldwideLoading ? 'Loading…' : 'Load 20 more'}
                  </button>
                )}
              </>
            )
          )}
        </>
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
    </div>
  );
};

export default App;
