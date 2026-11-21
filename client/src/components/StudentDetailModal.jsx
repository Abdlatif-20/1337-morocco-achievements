import Avatar from './Avatar.jsx';

const levelInt = (l) => Math.floor(l);
const levelPct = (l) => Math.min(Math.round((l % 1) * 100), 100);

const formatAchievedDate = (iso) => {
  if (!iso) { return null; }
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

const StudentDetailModal = ({ login, profile, loading, error, onClose }) => {
  const coalitionColor = profile?.coalitionColor || '#4f8ef7';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>

        {loading && <p className="status-text">Loading @{login}'s full profile…</p>}
        {error && <p className="error-text">{error}</p>}

        {profile && (
          <>
            <div className="profile-hero">
              <Avatar
                url={profile.imageUrl}
                alt={profile.displayName}
                className="profile-avatar"
                fallbackClassName="profile-avatar-fallback"
                fallback={profile.displayName.slice(0, 2).toUpperCase()}
                style={{ borderColor: coalitionColor }}
                fallbackStyle={{ background: coalitionColor }}
              />
              <h2>{profile.displayName}</h2>
              <span className="profile-login" style={{ color: coalitionColor }}>@{profile.login}</span>
              {profile.isStaff ? (
                <span className="profile-pill" style={{ borderColor: '#ffba3b', color: '#ffba3b' }}>Staff</span>
              ) : profile.grade ? (
                <span className="profile-pill" style={{ borderColor: coalitionColor, color: coalitionColor }}>{profile.grade}</span>
              ) : null}

              <div className="level-bar-wrap">
                <div className="level-bar-row">
                  <span>Level {levelInt(profile.level)}</span>
                  <span style={{ color: coalitionColor }}>{levelPct(profile.level)}%</span>
                </div>
                <div className="level-track">
                  <div
                    className="level-fill"
                    style={{ width: `${levelPct(profile.level)}%`, background: coalitionColor }}
                  />
                </div>
                <span className="level-sub" style={{ color: coalitionColor }}>
                  {profile.level.toFixed(2)} · {profile.campus}
                </span>
              </div>
            </div>

            <h3 className="section-title">Student Info</h3>
            <div className="info-grid">
              <div className="info-card info-card-full">
                <span className="info-label">Email</span>
                <span className="info-value">{profile.email}</span>
              </div>
              <div className="info-card">
                <span className="info-label">Location</span>
                <span className="info-value">{profile.location || 'Unavailable'}</span>
              </div>
              <div className="info-card">
                <span className="info-label">Wallet</span>
                <span className="info-value">{profile.wallet} ₳</span>
              </div>
              <div className="info-card">
                <span className="info-label">Evaluations</span>
                <span className="info-value">{profile.correctionPoints} pts</span>
              </div>
              <div className="info-card">
                <span className="info-label">Status</span>
                <span className="info-value" style={{ color: profile.active ? '#3dd68c' : '#ff6b6b' }}>
                  {profile.active ? 'Active' : 'Inactive'}
                </span>
              </div>
              {profile.campuses?.length > 0 && (
                <div className="info-card info-card-full">
                  <span className="info-label">Campuses</span>
                  <span className="info-value">
                    {profile.campuses.map((c) => c.name).join(', ')}
                  </span>
                </div>
              )}
              {profile.achievedAt !== undefined && (
                <div className="info-card info-card-full">
                  <span className="info-label">Achieved Date</span>
                  <span className="info-value">
                    {formatAchievedDate(profile.achievedAt) || 'Unknown'}
                  </span>
                </div>
              )}
            </div>

            <a
              className="intra-link"
              href={`https://profile.intra.42.fr/users/${profile.login}`}
              target="_blank"
              rel="noreferrer"
              style={{ borderColor: coalitionColor, color: coalitionColor }}
            >
              View full profile on intra ↗
            </a>
          </>
        )}
      </div>
    </div>
  );
};

export default StudentDetailModal;
