// backend/database/init_database.js
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(process.cwd(), ".env") });

/**
 * Uses Render's DATABASE_URL (or local .env) to:
 * 1) load backend/database/data.sql
 * 2) execute it (schema + functions + seed if included)
 * 3) verify PostGIS + key objects exist
 *
 * Run:
 *   node backend/database/init_database.js
 *
 * Tip (Render Shell):
 *   NODE_ENV=production node backend/database/init_database.js
 */

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL in environment variables.");
  console.error("   Set DATABASE_URL (Render Internal Database URL) then re-run.");
  process.exit(1);
}

const isProd = process.env.NODE_ENV === "production";

/**
 * Render Postgres typically requires SSL.
 * - In prod: use SSL with rejectUnauthorized:false
 * - In local dev: usually no SSL needed (unless you want it)
 */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : false,
  // Optional hardening:
  // max: 5,
  // idleTimeoutMillis: 30000,
  // connectionTimeoutMillis: 10000,
});

pool.on("connect", () => console.log("✅ Connected to PostgreSQL"));
pool.on("error", (err) => console.error("❌ Pool error:", err));

function readSqlFile(fileName) {
  const filePath = path.join(__dirname, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`SQL file not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

/**
 * If your data.sql contains multiple statements (it will),
 * pg can still run it in one query, BUT:
 * - if it contains psql meta-commands like \i, \c, \copy, it will fail.
 * Ensure data.sql is plain SQL only.
 */
async function runSql(sql) {
  // Wrap in a transaction so partial failures rollback
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function safeQuery(label, sql) {
  try {
    const res = await pool.query(sql);
    console.log(`✅ ${label}:`, res.rows?.[0] ?? res.rows);
    return res;
  } catch (e) {
    console.warn(`⚠️ ${label} check failed:`, e.message);
    return null;
  }
}

async function initializeDatabase() {
  console.log("🗄️ Initializing Cemetery Database...");

  try {
    // 1) Load SQL
    const schemaSQL = readSqlFile("sample.sql");
    console.log("📄 Loaded data.sql");

    // 2) Execute SQL
    console.log("⚙️ Applying schema/seed SQL (transactional)...");
    await runSql(schemaSQL);
    console.log("✅ Database schema/seed applied successfully");

    // 3) PostGIS check
    await safeQuery("PostGIS version", "SELECT PostGIS_Version() as version");

    // 4) Bounds function check (optional)
    await safeQuery("Cemetery bounds", "SELECT * FROM get_cemetery_bounds()");

    // 5) Plot count check (optional)
    await safeQuery("Total plots", "SELECT COUNT(*)::int as total FROM plots");

    console.log("🎉 Cemetery database initialization complete!");
    process.exitCode = 0;
  } catch (error) {
    console.error("❌ Database initialization error:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    // Always close pool
    await pool.end();
    console.log("🔌 Pool closed.");
  }
}

// Execute
initializeDatabase();
