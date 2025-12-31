// backend/controllers/plot.controller.js
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
 * Utility: ensures polygon output for graves/plots on the map.
 * - If plot_boundary exists -> use it
 * - Else use coordinates (for older schema)
 * - If that is POINT -> buffer it to polygon
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
 * - If boundary is polygon -> boundary(line)
 * - If already line -> as-is
 * - If point -> null (roads shouldn’t be points)
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
    const sql = `
      WITH base AS (
        SELECT
          id,
          uid,
          -- tolerate schemas: plot_name vs plot_code
          COALESCE(plot_name::text, plot_code::text) AS plot_name,
          plot_type,
          section_name,
          size_sqm,
          price,
          status,
          created_at,
          updated_at,
          ${sqlGeomAsPolygon("COALESCE(plot_boundary, coordinates)")} AS geom
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
    const sql = `
      SELECT json_build_object(
        'type','Feature',
        'id', id,
        'geometry', ST_AsGeoJSON(${sqlGeomAsPolygon("COALESCE(plot_boundary, coordinates)")})::json,
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

    const geomExpr =
      geomMode === "line"
        ? sqlGeomAsLine("COALESCE(plot_boundary, coordinates)")
        : sqlGeomAsPolygon("COALESCE(plot_boundary, coordinates)");

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

    const geomExpr =
      geomMode === "line"
        ? sqlGeomAsLine("COALESCE(plot_boundary, coordinates)")
        : sqlGeomAsPolygon("COALESCE(plot_boundary, coordinates)");

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
