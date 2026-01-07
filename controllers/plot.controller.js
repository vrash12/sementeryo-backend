"use strict";

const pool = require("../config/database");

const ALLOWED_TABLES = new Set([
  "plots",
  "road_plots",
  "building_plots",
]);

/* ---------------- tiny DB helpers (safe optional columns) ---------------- */
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

// Convert an existing column to geometry (only if the column exists).
// Works for geometry/geography columns (casts to geometry).
async function sqlColumnToGeometry(tableName, columnName) {
  if (!(await hasColumn(tableName, columnName))) return null;
  return `${columnName}::geometry`;
}

async function colOrNull(tableName, columnName, castSql = "") {
  if (!(await hasColumn(tableName, columnName))) return "NULL";
  return `${columnName}${castSql}`;
}

async function coalesceText(tableName, columns) {
  const parts = [];
  for (const c of columns) {
    if (await hasColumn(tableName, c)) parts.push(`${c}::text`);
  }
  return parts.length ? `COALESCE(${parts.join(", ")})` : "NULL";
}

/**
 * Utility: build a WHERE clause safely for optional filters.
 * Supports:
 *  - status (if column exists)
 *  - section (matches COALESCE(section_name, plot_name, plot_code) if any exist)
 */
async function buildFilters(tableName, req) {
  const { status = null, section = null } = req.query;

  const filters = [];
  const params = [];

  if (status && (await hasColumn(tableName, "status"))) {
    params.push(status);
    filters.push(`status = $${params.length}`);
  }

  if (section) {
    const sectionExpr = await coalesceText(tableName, [
      "section_name",
      "plot_name",
      "plot_code",
    ]);

    if (sectionExpr !== "NULL") {
      params.push(section);
      filters.push(`(${sectionExpr} = $${params.length})`);
    }
  }

  return {
    whereSQL: filters.length ? `WHERE ${filters.join(" AND ")}` : "",
    params,
  };
}

/**
 * Utility: ensures polygon output for graves/plots on the map.
 * - If geometry is polygon -> use it
 * - If point/line -> buffer it to polygon
 */
function sqlGeomAsPolygon(geomExpr) {
  return `
    CASE
      WHEN ${geomExpr} IS NULL THEN NULL
      WHEN GeometryType(${geomExpr}) IN ('POLYGON','MULTIPOLYGON') THEN ${geomExpr}
      WHEN GeometryType(${geomExpr}) IN ('POINT','MULTIPOINT') THEN ST_Buffer(${geomExpr}::geography, 0.8)::geometry
      WHEN GeometryType(${geomExpr}) IN ('LINESTRING','MULTILINESTRING') THEN ST_Buffer(${geomExpr}::geography, 0.8)::geometry
      ELSE ${geomExpr}
    END
  `;
}

/**
 * Utility: ensures line output for roads.
 * - If polygon -> boundary(line)
 * - If already line -> as-is
 * - If point -> null
 */
function sqlGeomAsLine(geomExpr) {
  return `
    CASE
      WHEN ${geomExpr} IS NULL THEN NULL
      WHEN GeometryType(${geomExpr}) IN ('LINESTRING','MULTILINESTRING') THEN ${geomExpr}
      WHEN GeometryType(${geomExpr}) IN ('POLYGON','MULTIPOLYGON') THEN ST_Boundary(${geomExpr})
      ELSE NULL
    END
  `;
}

/**
 * Build COALESCE(...) for geometry columns, but only using columns that exist.
 */
async function buildBaseGeomExpr(tableName, columnsInPriorityOrder) {
  const parts = [];
  for (const col of columnsInPriorityOrder) {
    const expr = await sqlColumnToGeometry(tableName, col);
    if (expr) parts.push(expr);
  }
  return parts.length ? `COALESCE(${parts.join(", ")})` : "NULL";
}

async function buildIdWhere(tableName, raw, isNumeric) {
  // Numeric => always prefer id = $1
  if (isNumeric) return { where: "id = $1", bind: [Number(raw)] };

  // Non-numeric => match any existing identifier columns, else fallback to id::text
  const ors = [];

  if (await hasColumn(tableName, "uid")) ors.push("uid::text = $1");
  if (await hasColumn(tableName, "plot_code")) ors.push("plot_code::text = $1");
  if (await hasColumn(tableName, "plot_name")) ors.push("plot_name::text = $1");

  if (!ors.length && (await hasColumn(tableName, "id"))) {
    ors.push("id::text = $1");
  }

  return {
    where: ors.length ? `(${ors.join(" OR ")})` : "id::text = $1",
    bind: [raw],
  };
}

/* =========================================================================================
   PLOTS (GRAVES)
========================================================================================= */

async function getPlotsGeoJSON(req, res, next) {
  try {
    const tableName = "plots";
    const { whereSQL, params } = await buildFilters(tableName, req);

    const baseGeom = await buildBaseGeomExpr(tableName, [
      "plot_boundary",
      "coordinates",
      "geom",
      "geometry",
    ]);

    // Safe selects (NULL if column missing)
    const uidExpr = await colOrNull(tableName, "uid", "::text");
    const plotNameExpr = await coalesceText(tableName, ["plot_name", "plot_code"]);
    const plotCodeExpr = await coalesceText(tableName, ["plot_code", "plot_name"]);
    const plotTypeExpr = await colOrNull(tableName, "plot_type", "::text");
    const sectionExpr = await colOrNull(tableName, "section_name", "::text");
    const sizeExpr = await colOrNull(tableName, "size_sqm");
    const priceExpr = await colOrNull(tableName, "price");
    const statusExpr = await colOrNull(tableName, "status", "::text");
    const createdExpr = await colOrNull(tableName, "created_at");
    const updatedExpr = await colOrNull(tableName, "updated_at");

    const sql = `
      WITH base AS (
        SELECT
          id,
          ${uidExpr}        AS uid,
          ${plotNameExpr}   AS plot_name,
          ${plotTypeExpr}   AS plot_type,
          ${sectionExpr}    AS section_name,
          ${sizeExpr}       AS size_sqm,
          ${priceExpr}      AS price,
          ${statusExpr}     AS status,
          ${createdExpr}    AS created_at,
          ${updatedExpr}    AS updated_at,
          ${sqlGeomAsPolygon(baseGeom)} AS geom,
          ${plotCodeExpr}   AS plot_code
        FROM ${tableName}
        ${whereSQL}
      ),
      feats AS (
        SELECT
          id,
          json_build_object(
            'type','Feature',
            'id', id,
            'geometry', ST_AsGeoJSON(geom)::json,
            'properties', json_build_object(
              'id', id,
              'uid', uid,
              'plot_name', plot_name,
              'plot_code', plot_code,
              'plot_type', plot_type,
              'section_name', section_name,
              'size_sqm', size_sqm,
              'price', price,
              'status', status,
              'created_at', created_at,
              'updated_at', updated_at
            )
          ) AS f
        FROM base
        WHERE geom IS NOT NULL
      )
      SELECT json_build_object(
        'type','FeatureCollection',
        'features', COALESCE(json_agg(f ORDER BY id), '[]'::json)
      ) AS geojson
      FROM feats;
    `;

    const { rows } = await pool.query(sql, params);
    return res.json(rows[0]?.geojson ?? { type: "FeatureCollection", features: [] });
  } catch (err) {
    next(err);
  }
}

async function getPlotById(req, res, next) {
  const raw = String(req.params.id || "").trim();
  if (!raw) return res.status(400).json({ ok: false, error: "Invalid plot id" });

  const isNumeric = /^\d+$/.test(raw);

  try {
    const tableName = "plots";

    const baseGeom = await buildBaseGeomExpr(tableName, [
      "plot_boundary",
      "coordinates",
      "geom",
      "geometry",
    ]);

    const uidExpr = await colOrNull(tableName, "uid", "::text");
    const plotNameExpr = await coalesceText(tableName, ["plot_name", "plot_code"]);
    const plotCodeExpr = await coalesceText(tableName, ["plot_code", "plot_name"]);
    const plotTypeExpr = await colOrNull(tableName, "plot_type", "::text");
    const sectionExpr = await colOrNull(tableName, "section_name", "::text");
    const sizeExpr = await colOrNull(tableName, "size_sqm");
    const priceExpr = await colOrNull(tableName, "price");
    const statusExpr = await colOrNull(tableName, "status", "::text");
    const createdExpr = await colOrNull(tableName, "created_at");
    const updatedExpr = await colOrNull(tableName, "updated_at");

    const { where, bind } = await buildIdWhere(tableName, raw, isNumeric);

    const sql = `
      SELECT json_build_object(
        'type','Feature',
        'id', id,
        'geometry', ST_AsGeoJSON(${sqlGeomAsPolygon(baseGeom)})::json,
        'properties', json_build_object(
          'id', id,
          'uid', ${uidExpr},
          'plot_name', ${plotNameExpr},
          'plot_code', ${plotCodeExpr},
          'plot_type', ${plotTypeExpr},
          'section_name', ${sectionExpr},
          'size_sqm', ${sizeExpr},
          'price', ${priceExpr},
          'status', ${statusExpr},
          'created_at', ${createdExpr},
          'updated_at', ${updatedExpr}
        )
      ) AS feature
      FROM ${tableName}
      WHERE ${where}
      LIMIT 1;
    `;

    const { rows } = await pool.query(sql, bind);

    if (!rows.length || !rows[0].feature) {
      return res.status(404).json({ ok: false, error: "Plot not found" });
    }

    return res.json(rows[0].feature);
  } catch (err) {
    next(err);
  }
}

/* ---------------- FACTORIES (ROAD/BUILDING) ---------------- */

function makeGetPlotsGeoJSON(table, geomMode = "polygon") {
  const safeTable = ALLOWED_TABLES.has(table) ? table : null;

  return async (req, res, next) => {
    try {
      if (!safeTable) return res.status(500).json({ error: "Invalid table config" });

      const { whereSQL, params } = await buildFilters(safeTable, req);

      const baseGeom = await buildBaseGeomExpr(safeTable, [
        "plot_boundary",
        "coordinates",
        "geom",
        "geometry",
      ]);

      const geomExpr =
        geomMode === "line" ? sqlGeomAsLine(baseGeom) : sqlGeomAsPolygon(baseGeom);

      // Safe selects
      const uidExpr = await colOrNull(safeTable, "uid", "::text");
      const plotNameExpr = await coalesceText(safeTable, ["plot_name", "plot_code"]);
      const plotCodeExpr = await coalesceText(safeTable, ["plot_code", "plot_name"]);
      const plotTypeExpr = await colOrNull(safeTable, "plot_type", "::text");
      const sectionExpr = await colOrNull(safeTable, "section_name", "::text");
      const sizeExpr = await colOrNull(safeTable, "size_sqm");
      const priceExpr = await colOrNull(safeTable, "price");
      const statusExpr = await colOrNull(safeTable, "status", "::text");
      const createdExpr = await colOrNull(safeTable, "created_at");
      const updatedExpr = await colOrNull(safeTable, "updated_at");

      const sql = `
        WITH base AS (
          SELECT
            id,
            ${uidExpr}       AS uid,
            ${plotNameExpr}  AS plot_name,
            ${plotCodeExpr}  AS plot_code,
            ${plotTypeExpr}  AS plot_type,
            ${sectionExpr}   AS section_name,
            ${sizeExpr}      AS size_sqm,
            ${priceExpr}     AS price,
            ${statusExpr}    AS status,
            ${createdExpr}   AS created_at,
            ${updatedExpr}   AS updated_at,
            ${geomExpr}      AS geom
          FROM ${safeTable}
          ${whereSQL}
        ),
        feats AS (
          SELECT
            id,
            json_build_object(
              'type','Feature',
              'id', id,
              'geometry', ST_AsGeoJSON(geom)::json,
              'properties', json_build_object(
                'id', id,
                'uid', uid,
                'plot_name', plot_name,
                'plot_code', plot_code,
                'plot_type', plot_type,
                'section_name', section_name,
                'size_sqm', size_sqm,
                'price', price,
                'status', status,
                'created_at', created_at,
                'updated_at', updated_at
              )
            ) AS f
          FROM base
          WHERE geom IS NOT NULL
        )
        SELECT json_build_object(
          'type','FeatureCollection',
          'features', COALESCE(json_agg(f ORDER BY id), '[]'::json)
        ) AS geojson
        FROM feats;
      `;

      const { rows } = await pool.query(sql, params);
      return res.json(rows[0]?.geojson ?? { type: "FeatureCollection", features: [] });
    } catch (err) {
      next(err);
    }
  };
}

function makeGetPlotById(table, geomMode = "polygon") {
  const safeTable = ALLOWED_TABLES.has(table) ? table : null;

  return async (req, res, next) => {
    const raw = String(req.params.id || "").trim();
    if (!raw) return res.status(400).json({ ok: false, error: "Invalid plot id" });

    const isNumeric = /^\d+$/.test(raw);

    try {
      if (!safeTable) return res.status(500).json({ error: "Invalid table config" });

      const baseGeom = await buildBaseGeomExpr(safeTable, [
        "plot_boundary",
        "coordinates",
        "geom",
        "geometry",
      ]);

      const geomExpr =
        geomMode === "line" ? sqlGeomAsLine(baseGeom) : sqlGeomAsPolygon(baseGeom);

      // Safe selects
      const uidExpr = await colOrNull(safeTable, "uid", "::text");
      const plotNameExpr = await coalesceText(safeTable, ["plot_name", "plot_code"]);
      const plotCodeExpr = await coalesceText(safeTable, ["plot_code", "plot_name"]);
      const plotTypeExpr = await colOrNull(safeTable, "plot_type", "::text");
      const sectionExpr = await colOrNull(safeTable, "section_name", "::text");
      const sizeExpr = await colOrNull(safeTable, "size_sqm");
      const priceExpr = await colOrNull(safeTable, "price");
      const statusExpr = await colOrNull(safeTable, "status", "::text");
      const createdExpr = await colOrNull(safeTable, "created_at");
      const updatedExpr = await colOrNull(safeTable, "updated_at");

      const { where, bind } = await buildIdWhere(safeTable, raw, isNumeric);

      const sql = `
        SELECT json_build_object(
          'type','Feature',
          'id', id,
          'geometry', ST_AsGeoJSON(${geomExpr})::json,
          'properties', json_build_object(
            'id', id,
            'uid', ${uidExpr},
            'plot_name', ${plotNameExpr},
            'plot_code', ${plotCodeExpr},
            'plot_type', ${plotTypeExpr},
            'section_name', ${sectionExpr},
            'size_sqm', ${sizeExpr},
            'price', ${priceExpr},
            'status', ${statusExpr},
            'created_at', ${createdExpr},
            'updated_at', ${updatedExpr}
          )
        ) AS feature
        FROM ${safeTable}
        WHERE ${where}
        LIMIT 1;
      `;

      const { rows } = await pool.query(sql, bind);

      if (!rows.length || !rows[0].feature) {
        return res.status(404).json({ ok: false, error: "Plot not found" });
      }

      return res.json(rows[0].feature);
    } catch (err) {
      next(err);
    }
  };
}

/* =========================================================================================
   ROAD + BUILDING
========================================================================================= */

const getRoadPlotsGeoJSON = makeGetPlotsGeoJSON("road_plots", "line");
const getRoadPlotById = makeGetPlotById("road_plots", "line");

const getBuildingPlotsGeoJSON = makeGetPlotsGeoJSON("building_plots", "polygon");
const getBuildingPlotById = makeGetPlotById("building_plots", "polygon");

module.exports = {
  getPlotsGeoJSON,
  getPlotById,

  getRoadPlotsGeoJSON,
  getRoadPlotById,

  getBuildingPlotsGeoJSON,
  getBuildingPlotById,
};
