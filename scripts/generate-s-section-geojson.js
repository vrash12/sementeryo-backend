// scripts/generate-s-section-geojson.js

// ---- config ----
const ROWS = 12;

// We have 8 plot columns, but 3 road stripes between them
// So the whole width is split into 11 equal "sub columns"
const TOTAL_SUBCOLS = 11;

// Which sub-column indices are plots vs roads (0-based)
const PLOT_SUBCOL_INDICES = [0, 1, 3, 4, 6, 7, 9, 10];
const ROAD_SUBCOL_INDICES = [2, 5, 8];

// Corner coordinates you provided
const TL = { lat: 15.495190, lng: 120.555092 }; // top-left
const TR = { lat: 15.494837, lng: 120.555382 }; // top-right
const BL = { lat: 15.494804, lng: 120.554709 }; // bottom-left
const BR = { lat: 15.494519, lng: 120.554952 }; // bottom-right

// ---- helpers ----
function lerp(a, b, t) {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
}

// Build a (ROWS+1) x (TOTAL_SUBCOLS+1) grid of corner points
function buildGrid() {
  const grid = [];
  for (let r = 0; r <= ROWS; r++) {
    const tRow = r / ROWS;
    const leftOnRow = lerp(TL, BL, tRow);
    const rightOnRow = lerp(TR, BR, tRow);

    const row = [];
    for (let c = 0; c <= TOTAL_SUBCOLS; c++) {
      const s = c / TOTAL_SUBCOLS;
      row.push(lerp(leftOnRow, rightOnRow, s));
    }
    grid.push(row);
  }
  return grid;
}

function cellPolygon(grid, r, c) {
  const p00 = grid[r][c];
  const p10 = grid[r + 1][c];
  const p11 = grid[r + 1][c + 1];
  const p01 = grid[r][c + 1];
  // GeoJSON uses [lng, lat]
  return [
    [p00.lng, p00.lat],
    [p01.lng, p01.lat],
    [p11.lng, p11.lat],
    [p10.lng, p10.lat],
    [p00.lng, p00.lat], // close ring
  ];
}

// ---- generate plots ----
const grid = buildGrid();
const features = [];

// Generate S1..S96
let sIndex = 1;
for (let r = 0; r < ROWS; r++) {
  for (const subCol of PLOT_SUBCOL_INDICES) {
    const name = `S${sIndex++}`;
    const coords = cellPolygon(grid, r, subCol);
    features.push({
      type: "Feature",
      properties: {
        plot_name: name,
        kind: "plot",
        status: "available",   // default; adjust later
        plot_type: "single",   // or whatever fits your schema
      },
      geometry: {
        type: "Polygon",
        coordinates: [coords],
      },
    });
  }
}

// Generate 3 vertical road polygons spanning full height
ROAD_SUBCOL_INDICES.forEach((subCol, i) => {
  const topCoords = cellPolygon(grid, 0, subCol)[0]; // just to get shape
  const bottomCoords = cellPolygon(grid, ROWS - 1, subCol)[2];

  const pTopLeft = grid[0][subCol];
  const pTopRight = grid[0][subCol + 1];
  const pBottomRight = grid[ROWS][subCol + 1];
  const pBottomLeft = grid[ROWS][subCol];

  const poly = [
    [pTopLeft.lng, pTopLeft.lat],
    [pTopRight.lng, pTopRight.lat],
    [pBottomRight.lng, pBottomRight.lat],
    [pBottomLeft.lng, pBottomLeft.lat],
    [pTopLeft.lng, pTopLeft.lat],
  ];

  features.push({
    type: "Feature",
    properties: {
      name: `S-road-${i + 1}`,
      kind: "road",
    },
    geometry: {
      type: "Polygon",
      coordinates: [poly],
    },
  });
});

const fc = {
  type: "FeatureCollection",
  features,
};

console.log(JSON.stringify(fc, null, 2));
