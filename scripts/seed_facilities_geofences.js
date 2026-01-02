// backend/scripts/seed_facilities_geofences.js
"use strict";

const path = require("path");
const pool = require(path.join(__dirname, "..", "config", "database"));

// ============================================================================
// FACILITIES / GEOFENCES INPUT
// ============================================================================

// Comfort Rooms (points)
const COMFORT_ROOM_1 = { lat: 15.495013, lng: 120.554517 };
const COMFORT_ROOM_2 = { lat: 15.494161, lng: 120.555232 };

// Parking Lot (polygon)
// Using your four points as a single quad polygon:
// TL -> TR -> BR -> BL -> TL
const PARKING_TL = { lat: 15.494962, lng: 120.554452 };
const PARKING_BL = { lat: 15.494736, lng: 120.554232 };
const PARKING_TR = { lat: 15.494451, lng: 120.554879 };
const PARKING_BR = { lat: 15.494264, lng: 120.554623 };

// ============================================================================
// SAFE DB HELPERS
// ============================================================================

const _hasColumnCache = new Map();
async function hasColumn(tableName, columnName) {
  const key = `${String(tableName)}.${String(columnName)}`;
  if (_hasColumnCache.has(key)) return _hasColumnCache.get(key);

  const { rows } = await pool.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
    `,
    [String(tableName), String(columnName)]
  );

  const ok = rows.length > 0;
  _hasColumnCache.set(key, ok);
  return ok;
}

const _hasTableCache = new Map();
async function hasTable(tableName) {
  const key = String(tableName);
  if (_hasTableCache.has(key)) return _hasTableCache.get(key);

  const { rows } = await pool.query(`SELECT to_regclass($1) AS reg;`, [
    `public.${String(tableName)}`,
  ]);

  const ok = Boolean(rows?.[0]?.reg);
  _hasTableCache.set(key, ok);
  return ok;
}

// ============================================================================
// GEOMETRY HELPERS
// ============================================================================

const fix = (n) => Number(Number(n).toFixed(8));

function polygonWkt(points) {
  // points: [{lat,lng}, ...] (not closed)
  const ring = [...points, points[0]];
  return `POLYGON((${ring
    .map((p) => `${fix(p.lng)} ${fix(p.lat)}`)
    .join(", ")}))`;
}

// ============================================================================
// BUILD FACILITIES
// ============================================================================

function buildFacilities() {
  return [
    {
      uid: "C0001", // 5 chars
      plot_code: "CR-1",
      plot_name: "Comfort Room 1",
      plot_type: "comfort_room",
      status: "available",
      kind: "point",
      point: COMFORT_ROOM_1,
    },
    {
      uid: "C0002",
      plot_code: "CR-2",
      plot_name: "Comfort Room 2",
      plot_type: "comfort_room",
      status: "available",
      kind: "point",
      point: COMFORT_ROOM_2,
    },
    {
      uid: "P0001",
      plot_code: "PARK-1",
      plot_name: "Parking Lot 1",
      plot_type: "parking_lot",
      status: "available",
      kind: "polygon",
      polygon: [PARKING_TL, PARKING_TR, PARKING_BR, PARKING_BL],
    },
  ];
}

// ============================================================================
// DB OPS
// ============================================================================

async function clearExistingFacilities(client, facilities) {
  // safest: delete by uid first
  const uids = facilities.map((f) => f.uid);
  await client.query(`DELETE FROM building_plots WHERE uid = ANY($1)`, [uids]);
}

async function insertFacilities(client, facilities) {
  const table = "building_plots";

  if (!(await hasTable(table))) {
    console.log("ℹ️ building_plots table not found — skipping facilities seeding.");
    return;
  }

  const hasPlotCode = await hasColumn(table, "plot_code");
  const hasBoundary = await hasColumn(table, "plot_boundary"); // optional recommended column
  const hasSizeSqm = await hasColumn(table, "size_sqm");
  const hasPrice = await hasColumn(table, "price");

  for (const f of facilities) {
    const cols = ["uid", "plot_name", "plot_type", "status", "created_at", "updated_at"];
    const params = [];
    const vals = [];

    const addParam = (v) => {
      params.push(v);
      return `$${params.length}`;
    };

    // base values
    vals.push(
      addParam(f.uid),
      addParam(f.plot_name),
      addParam(f.plot_type),
      addParam(f.status),
      "NOW()",
      "NOW()"
    );

    if (hasPlotCode) {
      cols.push("plot_code");
      vals.push(addParam(f.plot_code));
    }

    if (hasSizeSqm) {
      cols.push("size_sqm");
      const sqm = f.kind === "polygon" ? 40 : 1;
      vals.push(addParam(sqm));
    }

    if (hasPrice) {
      cols.push("price");
      vals.push(addParam(null)); // facilities typically don't have a price
    }

    if (f.kind === "point") {
      cols.push("coordinates");
      const pLng = addParam(f.point.lng);
      const pLat = addParam(f.point.lat);
      vals.push(`ST_SetSRID(ST_MakePoint(${pLng}, ${pLat}), 4326)`);

      // optional boundary null
      if (hasBoundary) {
        cols.push("plot_boundary");
        vals.push("NULL");
      }
    } else {
      const wkt = polygonWkt(f.polygon);

      if (hasBoundary) {
        // store polygon boundary + store a point marker in coordinates
        cols.push("plot_boundary");
        const pWkt = addParam(wkt);
        vals.push(`ST_SetSRID(ST_GeomFromText(${pWkt}), 4326)`);

        cols.push("coordinates");
        vals.push(`ST_PointOnSurface(ST_SetSRID(ST_GeomFromText(${pWkt}), 4326))`);
      } else {
        // fallback: store polygon in coordinates (ONLY if coordinates can accept POLYGON)
        cols.push("coordinates");
        const pWkt = addParam(wkt);
        vals.push(`ST_SetSRID(ST_GeomFromText(${pWkt}), 4326)`);
      }
    }

    const sql = `
      INSERT INTO ${table} (${cols.join(", ")})
      VALUES (${vals.join(", ")})
    `;

    try {
      await client.query(sql, params);
    } catch (e) {
      if (f.kind === "polygon" && !hasBoundary) {
        console.error(
          "\n❌ Parking lot polygon insert failed.\n" +
            "Your building_plots.coordinates column may be POINT-only.\n\n" +
            "✅ Recommended fix (add plot_boundary):\n" +
            "  ALTER TABLE building_plots ADD COLUMN plot_boundary geometry(POLYGON,4326);\n"
        );
      }
      throw e;
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const facilities = buildFacilities();

  try {
    console.log("🌱 Seeding Facilities Geofences...");

    if (!(await hasTable("building_plots"))) {
      console.log("ℹ️ building_plots table missing. Nothing to seed.");
      return;
    }

    await pool.query("BEGIN");
    await clearExistingFacilities(pool, facilities);
    await insertFacilities(pool, facilities);
    await pool.query("COMMIT");

    console.log("✅ Facilities seeding complete!");
  } catch (err) {
    try {
      await pool.query("ROLLBACK");
    } catch {}
    console.error("❌ Facilities seeding failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}
