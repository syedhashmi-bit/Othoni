// Stylized low-detail world landmasses for the fleet map, authored as
// simplified [lon, lat] rings. Deliberately coarse (a recognizable flat
// silhouette, not a survey map) to stay tiny and dependency-free — no GeoJSON,
// no map library, no tiles. The map and the plotted dots share one
// equirectangular coordinate space so projection is a single subtraction:
//
//   x = lon + 180   (0..360, west→east)
//   y = 90  - lat    (0..180, north→south)
//
// viewBox is therefore "0 0 360 180".

export const WORLD_VIEWBOX = '0 0 360 180';

export function project(lon, lat) {
  return [lon + 180, 90 - lat];
}

// Each entry is one closed ring of [lon, lat] vertices.
export const LAND = [
  // North America
  [
    [-168, 66], [-160, 71], [-130, 70], [-95, 72], [-80, 68], [-62, 60],
    [-55, 52], [-66, 45], [-70, 42], [-74, 40], [-81, 31], [-81, 25],
    [-97, 18], [-105, 20], [-110, 23], [-117, 32], [-124, 40], [-125, 48],
    [-138, 59], [-150, 60], [-165, 60],
  ],
  // South America
  [
    [-81, 8], [-77, 1], [-80, -5], [-75, -14], [-71, -18], [-71, -30],
    [-73, -40], [-75, -46], [-69, -52], [-66, -55], [-62, -50], [-58, -40],
    [-57, -34], [-48, -25], [-40, -20], [-35, -8], [-44, -2], [-50, 0],
    [-52, 5], [-60, 8], [-70, 12], [-77, 8],
  ],
  // Africa
  [
    [-17, 15], [-16, 21], [-10, 30], [0, 36], [10, 34], [20, 32], [25, 32],
    [32, 31], [34, 28], [43, 12], [51, 12], [44, 5], [41, -5], [40, -15],
    [35, -22], [32, -26], [26, -34], [20, -35], [18, -34], [14, -22],
    [12, -16], [9, -1], [5, 4], [-4, 5], [-8, 4], [-12, 8], [-16, 12],
  ],
  // Europe
  [
    [-10, 36], [-9, 43], [-2, 43], [-9, 52], [-5, 58], [5, 60], [10, 64],
    [18, 69], [28, 71], [30, 60], [27, 57], [28, 45], [20, 40], [12, 38],
    [15, 42], [8, 44], [3, 43], [-2, 40], [-9, 38],
  ],
  // Asia (incl. a coarse Indian subcontinent + Siberia)
  [
    [28, 45], [33, 62], [50, 68], [80, 76], [140, 73], [180, 68], [170, 60],
    [160, 55], [140, 50], [135, 43], [128, 38], [122, 30], [120, 22],
    [110, 20], [105, 10], [100, 8], [95, 16], [88, 22], [85, 16], [80, 12],
    [76, 22], [78, 30], [70, 38], [60, 40], [52, 38], [48, 40], [40, 44],
  ],
  // Australia
  [
    [114, -22], [122, -18], [130, -12], [137, -12], [142, -11], [146, -18],
    [150, -25], [153, -28], [150, -37], [143, -39], [135, -35], [129, -32],
    [120, -34], [115, -34], [113, -26],
  ],
];

// Curated country-name labels at approximate [lon, lat] centroids. Kept short
// and to major countries so the map stays clean; they're rendered small and
// muted, and counter-scaled so they hold a constant size as you zoom.
export const COUNTRIES = [
  { name: 'USA', lon: -98, lat: 39 },
  { name: 'Canada', lon: -106, lat: 58 },
  { name: 'Mexico', lon: -102, lat: 23 },
  { name: 'Brazil', lon: -51, lat: -10 },
  { name: 'Argentina', lon: -64, lat: -36 },
  { name: 'Chile', lon: -71, lat: -32 },
  { name: 'Colombia', lon: -73, lat: 4 },
  { name: 'UK', lon: -2, lat: 54 },
  { name: 'France', lon: 2, lat: 47 },
  { name: 'Spain', lon: -4, lat: 40 },
  { name: 'Germany', lon: 10, lat: 51 },
  { name: 'Italy', lon: 12, lat: 42 },
  { name: 'Poland', lon: 19, lat: 52 },
  { name: 'Sweden', lon: 16, lat: 62 },
  { name: 'Norway', lon: 9, lat: 61 },
  { name: 'Finland', lon: 26, lat: 64 },
  { name: 'Russia', lon: 92, lat: 62 },
  { name: 'Ukraine', lon: 32, lat: 49 },
  { name: 'Turkey', lon: 35, lat: 39 },
  { name: 'Egypt', lon: 30, lat: 27 },
  { name: 'Nigeria', lon: 8, lat: 9 },
  { name: 'Kenya', lon: 38, lat: 1 },
  { name: 'South Africa', lon: 25, lat: -29 },
  { name: 'Saudi Arabia', lon: 45, lat: 24 },
  { name: 'India', lon: 79, lat: 22 },
  { name: 'China', lon: 104, lat: 36 },
  { name: 'Japan', lon: 138, lat: 37 },
  { name: 'Indonesia', lon: 113, lat: -2 },
  { name: 'Australia', lon: 134, lat: -25 },
  { name: 'New Zealand', lon: 172, lat: -42 },
];

// Precompute SVG path `d` strings in viewBox space.
export const LAND_PATHS = LAND.map((ring) => {
  const pts = ring.map(([lon, lat]) => {
    const [x, y] = project(lon, lat);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `M${pts.join('L')}Z`;
});
