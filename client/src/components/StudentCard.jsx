const initials = (name) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase() || '')
    .join('');

const StudentCard = ({ student, onOpen }) => (
  <div className="student-card" role="button" tabIndex={0} onClick={() => onOpen(student)}>
    <div className="student-avatar-wrap">
      {student.imageUrl ? (
        <img className="student-avatar" src={student.imageUrl} alt={student.displayName} />
      ) : (
        <div className="student-avatar student-avatar-fallback">{initials(student.displayName)}</div>
      )}
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
    </div>
    {student.isStaff && <span className="student-badge">Staff</span>}
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

export default StudentCard;
