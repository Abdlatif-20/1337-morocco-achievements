import Avatar from './Avatar.jsx';

const initials = (name) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase() || '')
    .join('');

// This app's own login — whoever built it gets a distinct badge wherever their card shows
// up in a holder list, instead of blending in as just another student.
const OWNER_LOGIN = 'aben-nei';

const StudentCard = ({ student, onOpen }) => {
  const isOwner = student.login === OWNER_LOGIN;
  return (
    <div className={`student-card${isOwner ? ' student-card-owner' : ''}`} role="button" tabIndex={0} onClick={() => onOpen(student)}>
      <div className="student-avatar-wrap">
        <Avatar
          url={student.imageUrl}
          alt={student.displayName}
          className="student-avatar"
          fallbackClassName="student-avatar-fallback"
          fallback={initials(student.displayName)}
        />
        {student.active && <span className="student-online-dot" title="Active now" />}
      </div>
      <div className="student-info">
        <span className="student-name">{student.displayName}</span>
        <span className="student-login">@{student.login}</span>
        {student.campuses?.length > 0 && (
          <span className="student-campus">
            {student.campuses.map((c) => c.name).join(', ')}
          </span>
        )}
        {student.switchedAt && (
          <span className="student-campus">
            Switched to Paris on {new Date(student.switchedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>
      {isOwner ? (
        <span className="student-badge student-badge-owner" title="Owner — built this site">👑</span>
      ) : student.isStaff && <span className="student-badge">Staff</span>}
      {student.recentParisMove && (
        <span className="student-badge student-badge-flight" title="Recently added 42 Paris to their profile">✈️</span>
      )}
      <a
        className="student-intra-arrow"
        href={`https://profile.intra.42.fr/users/${student.login}`}
        target="_blank"
        rel="noreferrer"
        title="Open on intra"
        onClick={(e) => e.stopPropagation()}
      >
        ↗
      </a>
    </div>
  );
};

export default StudentCard;
