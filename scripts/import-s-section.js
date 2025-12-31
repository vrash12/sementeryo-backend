// backend/scripts/import-s-section.js
const fs = require("fs");
const path = require("path");
const pool = require("../config/database");

const TABLE = "plots";

async function main() {
  try {
    const filePath = path.join(__dirname, "..", "data", "s-section.geojson");

    const buf = fs.readFileSync(filePath); // read raw bytes
    let raw;

    // Detect UTF-16 BOM and decode appropriately
    if (
      buf.length >= 2 &&
      ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
    ) {
      // UTF-16 file (what gives you the "��{" symptom)
      raw = buf.toString("utf16le");
    } else {
      // normal UTF-8
      raw = buf.toString("utf8");
    }

    // Strip optional BOM and trim whitespace
    raw = raw.replace(/^\uFEFF/, "").trim();

    let fc;
    try {
      fc = JSON.parse(raw);
    } catch (e) {
      console.error("First 200 chars of file:\n", raw.slice(0, 200));
      throw e;
    }

    if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
      throw new Error("Invalid GeoJSON file (expected FeatureCollection)");
    }

    console.log(`Importing ${fc.features.length} features from s-section.geojson…`);

    // Optional: clear existing S-section plots
    // await pool.query(`DELETE FROM ${TABLE} WHERE plot_name LIKE 'S%'`);

    for (const feature of fc.features) {
      const props = feature.properties || {};
      const geom = feature.geometry;

      if (!geom) {
        console.warn("Skipping feature with no geometry:", props.plot_name || props.name);
        continue;
      }

      const kind     = props.kind || "plot";
      const plotName = props.plot_name || props.name || null;
      const status   = props.status || "available";
      const plotType = props.plot_type || null;
      const sizeSqm  = props.size_sqm || null;

      const geomJson = JSON.stringify(geom);

      await pool.query(
        `
        INSERT INTO ${TABLE} (plot_name, status, plot_type, size_sqm, kind, geom)
        VALUES ($1, $2, $3, $4, $5,
                ST_SetSRID(ST_GeomFromGeoJSON($6), 4326))
        `,
        [plotName, status, plotType, sizeSqm, kind, geomJson]
      );

      console.log("Inserted", plotName || kind);
    }

    console.log("Done.");
  } catch (err) {
    console.error("Import failed:", err);
  } finally {
    await pool.end();
  }
}

main();
