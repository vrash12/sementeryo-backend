// backend/controllers/plot.controller.js
"use strict";

const pool = require("../config/database");

/**
 * Utility: build a WHERE clause safely for optional filters.
 * Supports:
 *  - status
 *  - section (matches section_name OR plot_name OR plot_code)
 */
function buildFilters(req) {
  const { status = null, section = null } = req.query;

  const filters = [];
  const params = [];

  if (status) {
    params.push(status);
    filters.push(`status = $${params.length}`);
  }

  if (section) {
    params.push(section);
    // tolerate older schemas: plot_name / plot_code / section_name
    filters.push(
      `(COALESCE(section_name::text, plot_name::text, plot_code::text) = $${params.length})`
    );
  }

  return {
    whereSQL: filters.length ? `WHERE ${filters.join(" AND ")}` : "",
    params,
  };
}

/* =========================================================================================
   Table + Column detection (cached)
   IMPORTANT: Avoid calling jsonb_* functions on geometry columns.
========================================================================================= */

const _colTypeCache = new Map();
const _tableExistsCache = new Map();

async function tableExists(table) {
  const key = String(table);
  if (_tableExistsCache.has(key)) return _tableExistsCache.get(key);

  const { rows } = await pool.query(`SELECT to_regclass($1) AS reg;`, [
    `public.${key}`,
  ]);
  const ok = Boolean(rows?.[0]?.reg);
  _tableExistsCache.set(key, ok);
  return ok;
}

/**
 * Returns { data_type, udt_name } for a column, or null if missing.
 * - geometry/geography appear as data_type='USER-DEFINED', udt_name='geometry'|'geography'
 * - jsonb appears as data_type='jsonb', udt_name='jsonb'
 */
async function getColumnType(table, column) {
  const key = `${String(table)}.${String(column)}`;
  if (_colTypeCache.has(key)) return _colTypeCache.get(key);

  const { rows } = await pool.query(
    `
    SELECT data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
    `,
    [String(table), String(column)]
  );

  const out = rows[0]
    ? { data_type: rows[0].data_type, udt_name: rows[0].udt_name }
    : null;

  _colTypeCache.set(key, out);
  return out;
}

/* =========================================================================================
   Geometry conversion helpers
========================================================================================= */

function sqlToGeometryFromJsonb(expr, { defaultSrid = 4326 } = {}) {
  // expr MUST be jsonb here
  return `
    CASE
      WHEN ${expr} IS NULL THEN NULL

      -- GeoJSON object: {"type":"Polygon",...}
      WHEN jsonb_typeof(${expr}) = 'object' AND (${expr} ? 'type') THEN
        ST_SetSRID(ST_GeomFromGeoJSON(${expr}::text), ${defaultSrid})

      -- object lat/lng: {"lat":..,"lng":..}
      WHEN jsonb_typeof(${expr}) = 'object' AND (${expr} ? 'lat') AND (${expr} ? 'lng') THEN
        ST_SetSRID(
          ST_MakePoint((${expr}->>'lng')::double precision, (${expr}->>'lat')::double precision),
          ${defaultSrid}
        )

      -- object latitude/longitude
      WHEN jsonb_typeof(${expr}) = 'object' AND (${expr} ? 'latitude') AND (${expr} ? 'longitude') THEN
        ST_SetSRID(
          ST_MakePoint((${expr}->>'longitude')::double precision, (${expr}->>'latitude')::double precision),
          ${defaultSrid}
        )

      -- array [lng, lat]
      WHEN jsonb_typeof(${expr}) = 'array'
           AND jsonb_array_length(${expr}) = 2 THEN
        ST_SetSRID(
          ST_MakePoint((${expr}->>0)::double precision, (${expr}->>1)::double precision),
          ${defaultSrid}
        )

      -- polygon coords [[[lng,lat]...]]
      WHEN jsonb_typeof(${expr}) = 'array' THEN
        ST_SetSRID(
          ST_GeomFromGeoJSON(
            jsonb_build_object('type','Polygon','coordinates', ${expr})::text
          ),
          ${defaultSrid}
        )

      ELSE NULL
    END
  `;
}

function sqlToGeometryFromText(expr, { defaultSrid = 4326 } = {}) {
  // expr is text/varchar containing GeoJSON string
  return `ST_SetSRID(ST_GeomFromGeoJSON(${expr}), ${defaultSrid})`;
}

/**
 * Build a SAFE SQL expression that returns a PostGIS geometry for a given column.
 * We only emit jsonb_* calls if the column is actually jsonb (checked via information_schema).
 */
async function sqlColumnToGeometry(table, column, { defaultSrid = 4326 } = {}) {
  const t = await getColumnType(table, column);
  if (!t) return null;

  const udt = String(t.udt_name || "").toLowerCase();
  const dt = String(t.data_type || "").toLowerCase();

  if (udt === "geometry") return column;
  if (udt === "geography") return `${column}::geometry`;

  if (udt === "jsonb" || dt === "jsonb") {
    return sqlToGeometryFromJsonb(column, { defaultSrid });
  }

  if (dt === "text" || dt === "character varying" || dt === "varchar") {
    return sqlToGeometryFromText(column, { defaultSrid });
  }

  return null;
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
 * Build COALESCE(geom, plot_boundary, coordinates) but only with columns that exist
 * and in a type-safe way.
 */
async function buildBaseGeomExpr(table, columnsInPriorityOrder) {
  const parts = [];
  for (const col of columnsInPriorityOrder) {
    const expr = await sqlColumnToGeometry(table, col);
    if (expr) parts.push(expr);
  }
  return parts.length ? `COALESCE(${parts.join(", ")})` : "NULL";
}

/* =========================================================================================
   PLOTS (GRAVES)
========================================================================================= */

async function getPlotsGeoJSON(req, res, next) {
  const { whereSQL, params } = buildFilters(req);

  try {
    // If plots table missing, return empty instead of crashing
    if (!(await tableExists("plots"))) {
      return res.json({ type: "FeatureCollection", features: [] });
    }

    const baseGeom = await buildBaseGeomExpr("plots", [
      "geom",
      "plot_boundary",
      "coordinates",
    ]);

    const sql = `
      WITH base AS (
        SELECT
          id,
          uid,
          COALESCE(plot_name::text, plot_code::text) AS plot_name,
          plot_type,
          section_name,
          size_sqm,
          price,
          status,
          created_at,
          updated_at,
          ${sqlGeomAsPolygon(baseGeom)} AS geom
        FROM plots
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
              'plot_code', plot_name,
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
    if (!(await tableExists("plots"))) {
      return res.status(404).json({ ok: false, error: "Plot not found" });
    }

    const baseGeom = await buildBaseGeomExpr("plots", [
      "geom",
      "plot_boundary",
      "coordinates",
    ]);

    const sql = `
      SELECT json_build_object(
        'type','Feature',
        'id', id,
        'geometry', ST_AsGeoJSON(${sqlGeomAsPolygon(baseGeom)})::json,
        'properties', json_build_object(
          'id', id,
          'uid', uid,
          'plot_name', COALESCE(plot_name::text, plot_code::text),
          'plot_code', COALESCE(plot_code::text, plot_name::text),
          'plot_type', plot_type,
          'section_name', section_name,
          'size_sqm', size_sqm,
          'price', price,
          'status', status,
          'created_at', created_at,
          'updated_at', updated_at
        )
      ) AS feature
      FROM plots
      WHERE ${
        isNumeric
          ? "id = $1"
          : "(uid::text = $1 OR plot_code::text = $1 OR plot_name::text = $1)"
      }
      LIMIT 1;
    `;

    const bind = [isNumeric ? Number(raw) : raw];
    const { rows } = await pool.query(sql, bind);

    if (!rows.length || !rows[0].feature) {
      return res.status(404).json({ ok: false, error: "Plot not found" });
    }

    return res.json(rows[0].feature);
  } catch (err) {
    next(err);
  }
}

/* =========================================================================================
   FACTORIES (ROAD/BUILDING)
========================================================================================= */

const ALLOWED_TABLES = new Set(["road_plots", "building_plots"]);

function makeGetPlotsGeoJSON(table, geomMode = "polygon") {
  const safeTable = ALLOWED_TABLES.has(table) ? table : null;

  return async (req, res, next) => {
    if (!safeTable) return res.status(500).json({ error: "Invalid table config" });

    const { whereSQL, params } = buildFilters(req);

    try {
      // If table missing on Render (common), return empty instead of 500
      if (!(await tableExists(safeTable))) {
        return res.json({ type: "FeatureCollection", features: [] });
      }

      const baseGeom = await buildBaseGeomExpr(safeTable, [
        "geom",
        "plot_boundary",
        "coordinates",
      ]);

      const geomExpr =
        geomMode === "line" ? sqlGeomAsLine(baseGeom) : sqlGeomAsPolygon(baseGeom);

      const sql = `
        WITH base AS (
          SELECT
            id,
            uid,
            COALESCE(plot_name::text, plot_code::text) AS plot_name,
            plot_type,
            section_name,
            size_sqm,
            price,
            status,
            created_at,
            updated_at,
            ${geomExpr} AS geom
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
                'plot_code', plot_name,
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
    if (!safeTable) return res.status(500).json({ error: "Invalid table config" });

    const raw = String(req.params.id || "").trim();
    if (!raw) return res.status(400).json({ ok: false, error: "Invalid plot id" });

    const isNumeric = /^\d+$/.test(raw);

    try {
      if (!(await tableExists(safeTable))) {
        return res.status(404).json({ ok: false, error: "Plot not found" });
      }

      const baseGeom = await buildBaseGeomExpr(safeTable, [
        "geom",
        "plot_boundary",
        "coordinates",
      ]);

      const geomExpr =
        geomMode === "line" ? sqlGeomAsLine(baseGeom) : sqlGeomAsPolygon(baseGeom);

      const sql = `
        SELECT json_build_object(
          'type','Feature',
          'id', id,
          'geometry', ST_AsGeoJSON(${geomExpr})::json,
          'properties', json_build_object(
            'id', id,
            'uid', uid,
            'plot_name', COALESCE(plot_name::text, plot_code::text),
            'plot_code', COALESCE(plot_code::text, plot_name::text),
            'plot_type', plot_type,
            'section_name', section_name,
            'size_sqm', size_sqm,
            'price', price,
            'status', status,
            'created_at', created_at,
            'updated_at', updated_at
          )
        ) AS feature
        FROM ${safeTable}
        WHERE ${
          isNumeric
            ? "id = $1"
            : "(uid::text = $1 OR plot_code::text = $1 OR plot_name::text = $1)"
        }
        LIMIT 1;
      `;

      const bind = [isNumeric ? Number(raw) : raw];
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

/* =========================================================================================
   EXPORTS
========================================================================================= */

module.exports = {
  getPlotsGeoJSON,
  getPlotById,

  getRoadPlotsGeoJSON,
  getRoadPlotById,

  getBuildingPlotsGeoJSON,
  getBuildingPlotById,
};
