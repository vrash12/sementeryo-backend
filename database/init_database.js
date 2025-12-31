// backend/database/init_database.js
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false,
});

async function initializeDatabase() {
  try {
    console.log("🗄️ Initializing Cemetery Database...");

    const schemaSQL = fs.readFileSync(
      path.join(__dirname, "improved_schema.sql"),
      "utf8"
    );

    await pool.query(schemaSQL);
    console.log("✅ Database schema created successfully");

    const testResult = await pool.query("SELECT PostGIS_Version() as version");
    console.log("✅ PostGIS version:", testResult.rows[0].version);

    const boundsResult = await pool.query("SELECT * FROM get_cemetery_bounds()");
    console.log("✅ Cemetery bounds:", boundsResult.rows[0]);

    const plotCount = await pool.query("SELECT COUNT(*) as total FROM plots");
    console.log("✅ Total plots inserted:", plotCount.rows[0].total);

    console.log("🎉 Cemetery database initialization complete!");
  } catch (error) {
    console.error("❌ Database initialization error:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

initializeDatabase();
