import { useEffect, useState } from 'react';
import {
  fetchAchievedDate,
  fetchAchievementHolders,
  fetchCampuses,
  fetchStudentProfile,
} from './api.js';
import StudentCard from './components/StudentCard.jsx';
import StudentDetailModal from './components/StudentDetailModal.jsx';

const DEFAULT_ACHIEVEMENT = 'Je voudrais un croissant';

const App = () => {
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
    fetchCampuses().then(setCampuses).catch(() => {});
  }, []);

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
        if (err.message === 'ACHIEVEMENT_NOT_FOUND') {
          setAchievementError(`No achievement named "${DEFAULT_ACHIEVEMENT}" found.`);
        } else {
          setAchievementError(err.message);
        }
      })
      .finally(() => setAchievementLoading(false));
  };

  useEffect(() => {
    loadHolders(selectedCampusId);
  }, [selectedCampusId]);

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
      .catch((err) => setDetailError(err.message))
      .finally(() => setDetailLoading(false));
  };

  const closeDetail = () => setDetailStudent(null);

  return (
    <div className="app">
      <header className="header">
        <h1>Achievement Holders</h1>
        <p className="subtitle">Live from the 42 API — Morocco campuses only</p>
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
    </div>
  );
};

export default App;
