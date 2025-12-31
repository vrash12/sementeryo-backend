// backend/controllers/road-plots.controller.js
const pool = require("../config/database");

/**
 * GET /api/plot/road-plots
 *
 * Expects a table that stores road geometry as GeoJSON JSONB.
 * Example table name: road_plots
 * Columns:
 *   id, uid, name, geometry(jsonb), properties(jsonb), is_active(boolean)
 *
 * Returns:
 *   { type:"FeatureCollection", features:[...] }
 */
async function getRoadPlots(req, res, next) {
  try {
    const sql = `
      SELECT id, uid, name, geometry, properties
      FROM road_plots
      WHERE COALESCE(is_active, true) = true
      ORDER BY id ASC
    `;

    const { rows } = await pool.query(sql);

    const features = rows
      .map((r) => {
        const geom = r.geometry;
        if (!geom || typeof geom !== "object") return null;

        return {
          type: "Feature",
          geometry: geom,
          properties: {
            id: r.id,
            uid: r.uid,
            name: r.name,
            ...(r.properties && typeof r.properties === "object" ? r.properties : {}),
          },
        };
      })
      .filter(Boolean);

    return res.json({ type: "FeatureCollection", features });
  } catch (err) {
    console.error("[ROADPLOTS] ERROR:", err);
    next(err);
  }
}

module.exports = { getRoadPlots };
