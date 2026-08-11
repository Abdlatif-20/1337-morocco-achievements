const request = async (path) => {
  const response = await fetch(path);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || response.statusText);
  }
  return data;
};

export const fetchCampuses = () => request('/api/campuses');

export const fetchStudentProfile = (login) =>
  request(`/api/students/${encodeURIComponent(login)}/profile`);

export const fetchAchievementHolders = (name, campusId = null) =>
  request(
    `/api/achievements/holders?name=${encodeURIComponent(name)}` +
      (campusId ? `&campus=${campusId}` : ''),
  );

export const fetchAchievedDate = (login, name) =>
  request(`/api/achievements/achieved-date?login=${encodeURIComponent(login)}&name=${encodeURIComponent(name)}`);
