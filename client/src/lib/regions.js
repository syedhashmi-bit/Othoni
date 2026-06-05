// Static datacenter-city presets for the fleet map. Picking one fills in
// lat/lon/place so a basic-IT user doesn't need to look up coordinates.
// Pure data — a few KB, no runtime cost. Manual lat/lon entry is always
// available as a fallback for regions not listed here.

export const REGIONS = [
  // Hetzner
  { key: 'hetzner-nbg', label: 'Hetzner — Nuremberg, DE', lat: 49.45, lon: 11.08, place: 'Nuremberg, DE' },
  { key: 'hetzner-fsn', label: 'Hetzner — Falkenstein, DE', lat: 50.48, lon: 12.34, place: 'Falkenstein, DE' },
  { key: 'hetzner-hel', label: 'Hetzner — Helsinki, FI', lat: 60.17, lon: 24.94, place: 'Helsinki, FI' },
  { key: 'hetzner-ash', label: 'Hetzner — Ashburn, VA', lat: 39.04, lon: -77.49, place: 'Ashburn, VA' },
  { key: 'hetzner-hil', label: 'Hetzner — Hillsboro, OR', lat: 45.52, lon: -122.99, place: 'Hillsboro, OR' },
  // DigitalOcean / common cloud cities
  { key: 'nyc', label: 'New York, US', lat: 40.71, lon: -74.01, place: 'New York, US' },
  { key: 'sfo', label: 'San Francisco, US', lat: 37.77, lon: -122.42, place: 'San Francisco, US' },
  { key: 'tor', label: 'Toronto, CA', lat: 43.65, lon: -79.38, place: 'Toronto, CA' },
  { key: 'lon', label: 'London, UK', lat: 51.51, lon: -0.13, place: 'London, UK' },
  { key: 'ams', label: 'Amsterdam, NL', lat: 52.37, lon: 4.90, place: 'Amsterdam, NL' },
  { key: 'fra', label: 'Frankfurt, DE', lat: 50.11, lon: 8.68, place: 'Frankfurt, DE' },
  { key: 'par', label: 'Paris, FR', lat: 48.86, lon: 2.35, place: 'Paris, FR' },
  { key: 'mad', label: 'Madrid, ES', lat: 40.42, lon: -3.70, place: 'Madrid, ES' },
  { key: 'sto', label: 'Stockholm, SE', lat: 59.33, lon: 18.07, place: 'Stockholm, SE' },
  { key: 'waw', label: 'Warsaw, PL', lat: 52.23, lon: 21.01, place: 'Warsaw, PL' },
  { key: 'sgp', label: 'Singapore, SG', lat: 1.35, lon: 103.82, place: 'Singapore, SG' },
  { key: 'blr', label: 'Bangalore, IN', lat: 12.97, lon: 77.59, place: 'Bangalore, IN' },
  { key: 'tyo', label: 'Tokyo, JP', lat: 35.68, lon: 139.69, place: 'Tokyo, JP' },
  { key: 'syd', label: 'Sydney, AU', lat: -33.87, lon: 151.21, place: 'Sydney, AU' },
  { key: 'sao', label: 'São Paulo, BR', lat: -23.55, lon: -46.63, place: 'São Paulo, BR' },
  { key: 'jnb', label: 'Johannesburg, ZA', lat: -26.20, lon: 28.05, place: 'Johannesburg, ZA' },
  { key: 'dxb', label: 'Dubai, AE', lat: 25.20, lon: 55.27, place: 'Dubai, AE' },
  { key: 'hkg', label: 'Hong Kong', lat: 22.32, lon: 114.17, place: 'Hong Kong' },
  { key: 'sel', label: 'Seoul, KR', lat: 37.57, lon: 126.98, place: 'Seoul, KR' },
];

// Match a stored lat/lon back to a preset key (for pre-selecting the dropdown).
// Tolerance covers the 2-decimal rounding above.
export function regionKeyFor(lat, lon) {
  if (lat == null || lon == null) return '';
  const hit = REGIONS.find(
    (r) => Math.abs(r.lat - lat) < 0.05 && Math.abs(r.lon - lon) < 0.05
  );
  return hit ? hit.key : '';
}
