// backend/scripts/seed_cemetery_layout.js
const path = require("path");
const pool = require(path.join(__dirname, "..", "config", "database"));

// ============================================================================
// COORDINATES (Mapped from CemeteryMap.jsx)
// ============================================================================

// ---- MAIN ROADS (Yellow Lines) ----

// Road A
const ROAD_A_START = { lat: 15.494204941386018, lng: 120.554605304102 };
const ROAD_A_END   = { lat: 15.494854814113388, lng: 120.55545786787883 };

// Road B
const ROAD_B_START = { lat: 15.494137563161392, lng: 120.55462785871107 };
const ROAD_B_END   = { lat: 15.49525256129744,  lng: 120.5560871411545 };

// Road C
const ROAD_C_START = { lat: 15.494943558259884, lng: 120.554547927049 };
const ROAD_C_END   = { lat: 15.494164967630882, lng: 120.55516242804077 };

// Road D
const ROAD_D_START = { lat: 15.494168622992797, lng: 120.55515484160878 };
const ROAD_D_END   = { lat: 15.494557918667045, lng: 120.55565175290458 };

// Road E
const ROAD_E_START = { lat: 15.495384027246267, lng: 120.55497087063283 };
const ROAD_E_END   = { lat: 15.494561574022015, lng: 120.55565933933656 };

// Road F
const ROAD_F_START = { lat: 15.494793688944096, lng: 120.55462379138424 };
const ROAD_F_END   = { lat: 15.495996295868565, lng: 120.55585848319174 };

// Road G
const ROAD_G_START = { lat: 15.49552293014835,  lng: 120.55535777867995 };
const ROAD_G_END   = { lat: 15.494981939426166, lng: 120.55578641208778 };

// Road H
const ROAD_H_START = { lat: 15.494952775409871, lng: 120.55455808467482 };
const ROAD_H_END   = { lat: 15.496135295447349, lng: 120.5557848630519 };

// Road I (New)
const ROAD_I_START = { lat: 15.495619645834816, lng: 120.55545629246764 };
const ROAD_I_END   = { lat: 15.495078147745525, lng: 120.55588678699803 };

// Road J (New)
const ROAD_J_START = { lat: 15.49572949610942, lng: 120.55553273542162 };
const ROAD_J_END   = { lat: 15.495155689325069, lng: 120.55600078087679 };

// Road K (New)
const ROAD_K_START = { lat: 15.495817376287063, lng: 120.55563600046474 };
const ROAD_K_END   = { lat: 15.49522547672178, lng: 120.55607051830849 };


// ---- BASE GEOFENCE (S-Section) ----
const BASE_BR = { lat: 15.494519, lng: 120.554952 };
const BASE_BL = { lat: 15.494804, lng: 120.554709 };
const BASE_TL = { lat: 15.495190, lng: 120.555092 };
const BASE_TR = { lat: 15.494837, lng: 120.555382 };

// ---- EXTRA_GEOFENCE_POLYGON_1 (N-Section) ----
const EXTRA1_BL = { lat: 15.495250, lng: 120.555145 };
const EXTRA1_BR = { lat: 15.494827, lng: 120.555488 };
const EXTRA1_TR = { lat: 15.495007, lng: 120.555737 };
const EXTRA1_TL = { lat: 15.495466, lng: 120.555366 };

// ---- EXTRA_GEOFENCE_POLYGON_2 (G-Section) ----
const EXTRA2_BL = { lat: 15.495573, lng: 120.555461 };
const EXTRA2_BR = { lat: 15.495091, lng: 120.555841 };
const EXTRA2_TL = { lat: 15.495510, lng: 120.555417 };
const EXTRA2_TR = { lat: 15.495057, lng: 120.555786 };

// ---- EXTRA_GEOFENCE_POLYGON_3 (E-Section) ----
const EXTRA3_BL = { lat: 15.494860, lng: 120.554651 };
const EXTRA3_BR = { lat: 15.495257, lng: 120.555061 };
const EXTRA3_TL = { lat: 15.494942, lng: 120.554601 };
const EXTRA3_TR = { lat: 15.495347, lng: 120.554962 };

// ---- EXTRA_GEOFENCE_POLYGON_4 (W-Section) ----
const EXTRA4_BL = { lat: 15.4943905, lng: 120.5550505 };
const EXTRA4_BR = { lat: 15.4942253, lng: 120.5551791 };
const EXTRA4_TL = { lat: 15.4947143, lng: 120.5554745 };
const EXTRA4_TR = { lat: 15.4945557, lng: 120.5555986 };

// ---- EXTRA_GEOFENCE_POLYGON_5 (H-Section) ----
const EXTRA5_BL = { lat: 15.495673, lng: 120.555543 };
const EXTRA5_BR = { lat: 15.495177, lng: 120.555952 };
const EXTRA5_TL = { lat: 15.495627, lng: 120.555499 };
const EXTRA5_TR = { lat: 15.495127, lng: 120.555889 };

// ---- EXTRA_GEOFENCE_POLYGON_6 (Z-Section) ----
const EXTRA6_BL = { lat: 15.495711403125703, lng: 120.55557900352841 };
const EXTRA6_BR = { lat: 15.49520350661523,  lng: 120.55599943977671 };
const EXTRA6_TL = { lat: 15.495769559138362, lng: 120.55564002377788 };
const EXTRA6_TR = { lat: 15.49524033884679,  lng: 120.55604302567154 };

// ---- EXTRA_GEOFENCE_POLYGON_7 (NEW SECTION FROM YOUR FOUR POINTS) ----
// bottom left:  15.494787, 120.555570
// bottom right: 15.494463, 120.555830
// top left:     15.495124, 120.555991
// top right:    15.494817, 120.556267
const EXTRA7_BL = { lat: 15.494787, lng: 120.555570 };
const EXTRA7_BR = { lat: 15.494463, lng: 120.555830 };
const EXTRA7_TL = { lat: 15.495124, lng: 120.555991 };
const EXTRA7_TR = { lat: 15.494817, lng: 120.556267 };

// ============================================================================
// CONFIGURATION
// ============================================================================

const GRAVE_COLS = 8;
const ROAD_COUNT_PER_SECTION = GRAVE_COLS - 1;
const TOTAL_UNITS = GRAVE_COLS * 2 + ROAD_COUNT_PER_SECTION;

const BASE_ROWS  = 12;
const EXTRA1_ROWS = 10;
const EXTRA2_ROWS = 2;
const EXTRA3_ROWS = 4;
const EXTRA4_ROWS = 10;
const EXTRA5_ROWS = 2;
const EXTRA6_ROWS = 2; // Z-Section
const EXTRA7_ROWS = 4; // 🔹 New section rows (adjust if you like)

// ============================================================================
// HELPERS
// ============================================================================

const fix = (n) => Number(n.toFixed(8));

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function interp(p0, p1, t) {
  return {
    lat: lerp(p0.lat, p1.lat, t),
    lng: lerp(p0.lng, p1.lng, t),
  };
}

function positionAtQuad(BL, BR, TL, TR, u, vBottomToTop) {
  const left = interp(BL, TL, vBottomToTop);
  const right = interp(BR, TR, vBottomToTop);
  return {
    lat: left.lat + (right.lat - left.lat) * u,
    lng: left.lng + (right.lng - left.lng) * u,
  };
}

// Section Positioners
function positionAtBase(u, v)   { return positionAtQuad(BASE_BL,   BASE_BR,   BASE_TL,   BASE_TR,   u, v); }
function positionAtExtra1(u, v) { return positionAtQuad(EXTRA1_BL, EXTRA1_BR, EXTRA1_TL, EXTRA1_TR, u, v); }
function positionAtExtra2(u, v) { return positionAtQuad(EXTRA2_BL, EXTRA2_BR, EXTRA2_TL, EXTRA2_TR, u, v); }
function positionAtExtra3(u, v) { return positionAtQuad(EXTRA3_BL, EXTRA3_BR, EXTRA3_TL, EXTRA3_TR, u, v); }
function positionAtExtra4(u, v) { return positionAtQuad(EXTRA4_BL, EXTRA4_BR, EXTRA4_TL, EXTRA4_TR, u, v); }
function positionAtExtra5(u, v) { return positionAtQuad(EXTRA5_BL, EXTRA5_BR, EXTRA5_TL, EXTRA5_TR, u, v); }
function positionAtExtra6(u, v) { return positionAtQuad(EXTRA6_BL, EXTRA6_BR, EXTRA6_TL, EXTRA6_TR, u, v); }
function positionAtExtra7(u, v) { return positionAtQuad(EXTRA7_BL, EXTRA7_BR, EXTRA7_TL, EXTRA7_TR, u, v); } // 🔹 new section

function buildHorizontalBoundaries() {
  const boundaries = [0];
  const totalGridCols = GRAVE_COLS * 2 - 1;
  for (let gridCol = 0; gridCol < totalGridCols; gridCol++) {
    const widthUnits = gridCol % 2 === 0 ? 2 : 1; // grave columns get "2", road gaps get "1"
    boundaries.push(boundaries[boundaries.length - 1] + widthUnits / TOTAL_UNITS);
  }
  return boundaries;
}

// ============================================================================
// BUILDERS
// ============================================================================

function buildGravePlots(rows, posFunc, prefix) {
  const graves = [];
  const boundaries = buildHorizontalBoundaries();

  for (let col = 1; col <= GRAVE_COLS; col++) {
    const gridCol = 2 * (col - 1);
    const uLeft = boundaries[gridCol];
    const uRight = boundaries[gridCol + 1];

    for (let row = 0; row < rows; row++) {
      const vBottom = (rows - (row + 1)) / rows;
      const vTop = (rows - row) / rows;

      let plotName = `${prefix}${row * GRAVE_COLS + col}`;
      if (prefix === "S") {
        if (col <= 6) plotName = `S${col + 6 * row}`;
        else if (col === 7) plotName = `S${72 + (row + 1)}`;
        else if (col === 8) plotName = `S${84 + (row + 1)}`;
      }

      const pTL = posFunc(uLeft,  vTop);
      const pTR = posFunc(uRight, vTop);
      const pBR = posFunc(uRight, vBottom);
      const pBL = posFunc(uLeft,  vBottom);

      graves.push(createGraveObj(plotName, pTL, pTR, pBR, pBL, prefix));
    }
  }
  return graves;
}

function createGraveObj(name, pTL, pTR, pBR, pBL, prefix) {
  const wkt = `POLYGON((${[
    `${fix(pTL.lng)} ${fix(pTL.lat)}`,
    `${fix(pTR.lng)} ${fix(pTR.lat)}`,
    `${fix(pBR.lng)} ${fix(pBR.lat)}`,
    `${fix(pBL.lng)} ${fix(pBL.lat)}`,
    `${fix(pTL.lng)} ${fix(pTL.lat)}`,
  ].join(", ")}))`;

  return {
    uid: `${prefix}${String(name.slice(1)).padStart(4, "0")}`,
    plot_name: name,
    plot_type: "grave_double",
    size_sqm: 2.5,
    status: "available",
    wkt,
  };
}

// ---- ROAD GENERATION ----

function makeLineWkt(pBottom, pTop) {
  return `LINESTRING(${fix(pBottom.lng)} ${fix(pBottom.lat)}, ${fix(pTop.lng)} ${fix(pTop.lat)})`;
}

// 1. Manually defined Main Roads + two extra for the new section
function buildMainRoads() {
  const roads = [
    {
      uid: "M0001",
      plot_name: "Main Road A",
      plot_type: "road_main",
      status: "available",
      wkt: makeLineWkt(ROAD_A_START, ROAD_A_END),
    },
    {
      uid: "M0002",
      plot_name: "Main Road B",
      plot_type: "road_main",
      status: "available",
      wkt: makeLineWkt(ROAD_B_START, ROAD_B_END),
    },
    {
      uid: "M0003",
      plot_name: "Main Road C",
      plot_type: "road_main",
      status: "available",
      wkt: makeLineWkt(ROAD_C_START, ROAD_C_END),
    },
    {
      uid: "M0004",
      plot_name: "Main Road D",
      plot_type: "road_main",
      status: "available",
      wkt: makeLineWkt(ROAD_D_START, ROAD_D_END),
    },
    {
      uid: "M0005",
      plot_name: "Main Road E",
      plot_type: "road_main",
      status: "available",
      wkt: makeLineWkt(ROAD_E_START, ROAD_E_END),
    },
    {
      uid: "M0006",
      plot_name: "Main Road F",
      plot_type: "road_main",
      status: "available",
      wkt: makeLineWkt(ROAD_F_START, ROAD_F_END),
    },
    {
      uid: "M0007",
      plot_name: "Main Road G",
      plot_type: "road_main",
      status: "available",
      wkt: makeLineWkt(ROAD_G_START, ROAD_G_END),
    },
    {
      uid: "M0008",
      plot_name: "Main Road H",
      plot_type: "road_main",
      status: "available",
      wkt: makeLineWkt(ROAD_H_START, ROAD_H_END),
    },
    {
      uid: "M0009",
      plot_name: "Main Road I",
      plot_type: "road_main",
      status: "available",
      wkt: makeLineWkt(ROAD_I_START, ROAD_I_END),
    },
    {
      uid: "M0010",
      plot_name: "Main Road J",
      plot_type: "road_main",
      status: "available",
      wkt: makeLineWkt(ROAD_J_START, ROAD_J_END),
    },
    {
      uid: "M0011",
      plot_name: "Main Road K",
      plot_type: "road_main",
      status: "available",
      wkt: makeLineWkt(ROAD_K_START, ROAD_K_END),
    },
  ];

  // 🔹 Extra cross-roads inside the NEW (EXTRA7) section
  const midPoint = (a, b) => ({
    lat: (a.lat + b.lat) / 2,
    lng: (a.lng + b.lng) / 2,
  });

  const bottomCenter = midPoint(EXTRA7_BL, EXTRA7_BR);
  const topCenter    = midPoint(EXTRA7_TL, EXTRA7_TR);
  const leftCenter   = midPoint(EXTRA7_BL, EXTRA7_TL);
  const rightCenter  = midPoint(EXTRA7_BR, EXTRA7_TR);

  roads.push(
    {
      uid: "M0012",
      plot_name: "New Section N-S Road",
      plot_type: "road_main",
      status: "available",
      wkt: makeLineWkt(bottomCenter, topCenter),
    },
    {
      uid: "M0013",
      plot_name: "New Section E-W Road",
      plot_type: "road_main",
      status: "available",
      wkt: makeLineWkt(leftCenter, rightCenter),
    }
  );

  return roads;
}

// 2. Auto-generated Section Roads (vertical within each section)
function buildSectionRoads() {
  const roads = [];
  const boundaries = buildHorizontalBoundaries();

  const generateSectionRoads = (posFunc, startIndex) => {
    const sectionRoads = [];
    for (let i = 0; i < ROAD_COUNT_PER_SECTION; i++) {
      const gridCol = 2 * i + 1;
      const uCenter = (boundaries[gridCol] + boundaries[gridCol + 1]) / 2;

      const bottom = posFunc(uCenter, 0);
      const top = posFunc(uCenter, 1);
      const index = startIndex + i;

      sectionRoads.push({
        uid: `R${String(index).padStart(4, "0")}`,
        plot_name: `ROAD_${index}`,
        plot_type: "road_vertical",
        status: "available",
        wkt: makeLineWkt(bottom, top),
      });
    }
    return sectionRoads;
  };

  const sections = [
    positionAtBase,
    positionAtExtra1,
    positionAtExtra2,
    positionAtExtra3,
    positionAtExtra4,
    positionAtExtra5,
    positionAtExtra6,
    positionAtExtra7, // 🔹 include new section in auto roads
  ];

  let roadCounter = 1;
  for (const posFunc of sections) {
    roads.push(...generateSectionRoads(posFunc, roadCounter));
    roadCounter += ROAD_COUNT_PER_SECTION;
  }

  return roads;
}

// ============================================================================
// DB OPERATIONS
// ============================================================================

async function clearExisting() {
  await pool.query("BEGIN");
  try {
    // Clear Roads
    await pool.query(
      "DELETE FROM road_plots WHERE uid LIKE 'R%' OR uid LIKE 'M%' OR plot_name LIKE 'ROAD_%' OR plot_name LIKE 'Main Road%'"
    );
    // Clear Graves (now including Y for the new section)
    await pool.query(
      "DELETE FROM plots WHERE plot_name ~ '^[SNEGWHZY][0-9]+$'"
    );
    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
}

async function insertGraves(graves) {
  const sql = `
    INSERT INTO plots (uid, plot_name, plot_type, size_sqm, status, created_at, updated_at, coordinates)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), ST_SetSRID(ST_GeomFromText($6), 4326))
  `;
  for (const g of graves) {
    await pool.query(sql, [
      g.uid,
      g.plot_name,
      g.plot_type,
      g.size_sqm,
      g.status,
      g.wkt,
    ]);
  }
}

async function insertRoads(roads) {
  const sql = `
    INSERT INTO road_plots (uid, plot_code, plot_name, plot_type, status, created_at, updated_at, coordinates)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), ST_SetSRID(ST_GeomFromText($6), 4326))
  `;
  for (const r of roads) {
    await pool.query(sql, [
      r.uid,
      r.plot_name,
      r.plot_name,
      r.plot_type,
      r.status,
      r.wkt,
    ]);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  try {
    console.log("🌱 Seeding Cemetery Layout...");

    const graves = [
      ...buildGravePlots(BASE_ROWS,   positionAtBase,   "S"),
      ...buildGravePlots(EXTRA1_ROWS, positionAtExtra1, "N"),
      ...buildGravePlots(EXTRA2_ROWS, positionAtExtra2, "G"),
      ...buildGravePlots(EXTRA3_ROWS, positionAtExtra3, "E"),
      ...buildGravePlots(EXTRA4_ROWS, positionAtExtra4, "W"),
      ...buildGravePlots(EXTRA5_ROWS, positionAtExtra5, "H"),
      ...buildGravePlots(EXTRA6_ROWS, positionAtExtra6, "Z"),
      ...buildGravePlots(EXTRA7_ROWS, positionAtExtra7, "Y"), // 🔹 new section with prefix Y
    ];

    const sectionRoads = buildSectionRoads();
    const mainRoads = buildMainRoads();
    const allRoads = [...mainRoads, ...sectionRoads];

    console.log(`Generated ${graves.length} graves.`);
    console.log(`Generated ${mainRoads.length} main roads (Yellow Lines).`);
    console.log(`Generated ${sectionRoads.length} section roads.`);

    console.log("Clearing old data...");
    await clearExisting();

    console.log("Inserting graves...");
    await insertGraves(graves);

    console.log("Inserting roads...");
    await insertRoads(allRoads);

    console.log("✅ Seeding complete!");
  } catch (err) {
    console.error("❌ Seeding failed:", err);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().then(() => process.exit(0));
}
