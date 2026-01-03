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

/**
 * ✅ KEY FIX:
 * Your columns like plot_boundary / coordinates may be JSONB (not geometry).
 * This builds a safe SQL expression that returns a PostGIS geometry.
 *
 * Supported inputs:
 * - geometry: returned as-is
 * - geography: cast to geometry
 * - jsonb:
 *   - GeoJSON object: {"type":"Polygon",...} -> ST_GeomFromGeoJSON
 *   - coordinate array polygon: [[[lng,lat]...]] -> wrap as GeoJSON Polygon
 *   - coordinate array point: [lng,lat] -> ST_MakePoint
 *   - object lat/lng: {"lat":..,"lng":..} -> ST_MakePoint
 */
function sqlToGeometry(expr, { defaultSrid = 4326 } = {}) {
  return `
    CASE
      WHEN ${expr} IS NULL THEN NULL

      -- already geometry
      WHEN pg_typeof(${expr}) = 'geometry'::regtype THEN ${expr}

      -- geography -> geometry
      WHEN pg_typeof(${expr}) = 'geography'::regtype THEN ${expr}::geometry

      -- jsonb -> geometry
      WHEN pg_typeof(${expr}) = 'jsonb'::regtype THEN
        CASE
          WHEN jsonb_typeof(${expr}) = 'object' AND (${expr} ? 'type') THEN
            ST_SetSRID(ST_GeomFromGeoJSON(${expr}::text), ${defaultSrid})

          WHEN jsonb_typeof(${expr}) = 'object' AND (${expr} ? 'lat') AND (${expr} ? 'lng') THEN
            ST_SetSRID(
              ST_MakePoint((${expr}->>'lng')::double precision, (${expr}->>'lat')::double precision),
              ${defaultSrid}
            )

          WHEN jsonb_typeof(${expr}) = 'object' AND (${expr} ? 'latitude') AND (${expr} ? 'longitude') THEN
            ST_SetSRID(
              ST_MakePoint((${expr}->>'longitude')::double precision, (${expr}->>'latitude')::double precision),
              ${defaultSrid}
            )

          WHEN jsonb_typeof(${expr}) = 'array'
               AND jsonb_array_length(${expr}) = 2 THEN
            -- treat as [lng, lat]
            ST_SetSRID(
              ST_MakePoint((${expr}->>0)::double precision, (${expr}->>1)::double precision),
              ${defaultSrid}
            )

          WHEN jsonb_typeof(${expr}) = 'array' THEN
            -- treat as polygon coordinates [[[lng,lat]...]]
            ST_SetSRID(
              ST_GeomFromGeoJSON(
                jsonb_build_object('type','Polygon','coordinates', ${expr})::text
              ),
              ${defaultSrid}
            )

          ELSE NULL
        END

      -- text -> attempt GeoJSON
      WHEN pg_typeof(${expr}) = 'text'::regtype THEN
        ST_SetSRID(ST_GeomFromGeoJSON(${expr}), ${defaultSrid})

      ELSE NULL
    END
  `;
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

/* ---------------- PLOTS (GRAVES) ---------------- */

async function getPlotsGeoJSON(req, res, next) {
  const { whereSQL, params } = buildFilters(req);

  try {
    // ✅ IMPORTANT: convert each column to geometry FIRST, then COALESCE.
    const baseGeom = `COALESCE(
      ${sqlToGeometry("geom")},
      ${sqlToGeometry("plot_boundary")},
      ${sqlToGeometry("coordinates")}
    )`;

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
    const baseGeom = `COALESCE(
      ${sqlToGeometry("geom")},
      ${sqlToGeometry("plot_boundary")},
      ${sqlToGeometry("coordinates")}
    )`;

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
      WHERE ${isNumeric ? "id = $1" : "(uid::text = $1 OR plot_code::text = $1 OR plot_name::text = $1)"}
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

/* ---------------- FACTORIES (ROAD/BUILDING) ---------------- */

function makeGetPlotsGeoJSON(table, geomMode = "polygon") {
  return async (req, res, next) => {
    const { whereSQL, params } = buildFilters(req);

    // road_plots/building_plots usually don't have geom column; handle boundary/coords safely
    const baseGeom = `COALESCE(
      ${sqlToGeometry("plot_boundary")},
      ${sqlToGeometry("coordinates")}
    )`;

    const geomExpr =
      geomMode === "line"
        ? sqlGeomAsLine(baseGeom)
        : sqlGeomAsPolygon(baseGeom);

    try {
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
          FROM ${table}
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
  return async (req, res, next) => {
    const raw = String(req.params.id || "").trim();
    if (!raw) return res.status(400).json({ ok: false, error: "Invalid plot id" });

    const isNumeric = /^\d+$/.test(raw);

    const baseGeom = `COALESCE(
      ${sqlToGeometry("plot_boundary")},
      ${sqlToGeometry("coordinates")}
    )`;

    const geomExpr =
      geomMode === "line"
        ? sqlGeomAsLine(baseGeom)
        : sqlGeomAsPolygon(baseGeom);

    try {
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
        FROM ${table}
        WHERE ${isNumeric ? "id = $1" : "(uid::text = $1 OR plot_code::text = $1 OR plot_name::text = $1)"}
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

/* ---------------- ROAD + BUILDING ---------------- */

const getRoadPlotsGeoJSON = makeGetPlotsGeoJSON("road_plots", "line");
const getRoadPlotById = makeGetPlotById("road_plots", "line");

const getBuildingPlotsGeoJSON = makeGetPlotsGeoJSON("building_plots", "polygon");
const getBuildingPlotById = makeGetPlotById("building_plots", "polygon");

/* ---------------- EXPORTS ---------------- */

module.exports = {
  getPlotsGeoJSON,
  getPlotById,

  getRoadPlotsGeoJSON,
  getRoadPlotById,

  getBuildingPlotsGeoJSON,
  getBuildingPlotById,
};
