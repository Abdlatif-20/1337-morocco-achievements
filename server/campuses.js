// The 4 campuses of the "1337" network in Morocco — verified live against the real 42 API
// (GET /v2/campus?page[size]=100, filtered by country === 'Morocco').
export const MOROCCAN_CAMPUSES = [
  { id: 16, name: 'Khouribga', city: 'Khouribga' },
  { id: 21, name: 'Benguerir', city: 'Benguerir' },
  { id: 55, name: 'Tétouan', city: 'Tétouan' },
  { id: 75, name: 'Rabat', city: 'Rabat' },
];

export const isMoroccanCampusId = (id) => MOROCCAN_CAMPUSES.some((c) => c.id === Number(id));
