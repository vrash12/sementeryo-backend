// backend/routes/plot.routes.js
const router = require("express").Router();

const {
  getPlotsGeoJSON,
  getPlotById,
  getRoadPlotsGeoJSON,
  getRoadPlotById,
  getBuildingPlotsGeoJSON,
  getBuildingPlotById,
} = require("../controllers/plot.controller");

/**
 * IMPORTANT:
 * Your frontend Reservation.jsx calls:
 *   GET /api/plot/
 *   GET /api/plot/road-plots
 *
 * So we must define them here.
 */

// Main plots (graves)
router.get("/", getPlotsGeoJSON);
router.get("/:id", getPlotById);

// Roads (returns LineString/MultiLineString FeatureCollection)
router.get("/road-plots", getRoadPlotsGeoJSON);
router.get("/road-plots/:id", getRoadPlotById);

// Buildings (optional, but useful for map layers)
router.get("/building-plots", getBuildingPlotsGeoJSON);
router.get("/building-plots/:id", getBuildingPlotById);

module.exports = router;
