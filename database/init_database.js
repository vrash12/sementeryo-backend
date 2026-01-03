// backend/database/init_database.js
"use strict";

const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

// Load .env from backend/.env first, then root .env
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("dotenv").config({ path: path.resolve(process.cwd(), ".env") });

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL in environment variables.");
  process.exit(1);
}

const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const looksLikeRender = /render\.com/i.test(DATABASE_URL);

// Render typically requires SSL
const ssl =
  isProd || looksLikeRender ? { rejectUnauthorized: false } : false;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl,
});

pool.on("connect", () => console.log("✅ Connected to PostgreSQL"));
pool.on("error", (err) => console.error("❌ Pool error:", err));

function readSqlFile(fileName) {
  const filePath = path.join(__dirname, fileName);
  if (!fs.existsSync(filePath)) throw new Error(`SQL file not found: ${filePath}`);
  return fs.readFileSync(filePath, "utf8");
}

async function runSqlTransactional(sql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ✅ IMPORTANT: force SIMPLE query mode
    // This avoids protocol issues with big multi-statement SQL scripts.
    await client.query({ text: sql, queryMode: "simple" });

    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function safeQuery(label, sql) {
  try {
    const res = await pool.query(sql);
    console.log(`✅ ${label}:`, res.rows);
    return res;
  } catch (e) {
    console.warn(`⚠️ ${label} failed: ${e.message}`);
    return null;
  }
}

async function initializeDatabase() {
  console.log("🗄️ Initializing Cemetery Database...");
  console.log("ENV NODE_ENV:", process.env.NODE_ENV || "(not set)");
  console.log("SSL enabled?:", !!ssl);

  // Print a redacted connection target (helps catch “wrong URL” mistakes)
  try {
    const u = new URL(DATABASE_URL);
    console.log("DB host:", u.hostname);
    console.log("DB port:", u.port || "(default)");
    console.log("DB name:", u.pathname?.replace("/", "") || "(unknown)");
  } catch {
    console.log("DB URL not parseable by URL() (still may be valid).");
  }

  try {
    // ✅ First: confirm connection works BEFORE applying SQL
    await safeQuery("Connection test (SELECT 1)", "SELECT 1 AS ok");
    await safeQuery("Server version", "SELECT version()");

    // ✅ Load your SQL
    const sqlText = readSqlFile("sample.sql");
    console.log("📄 Loaded backend/database/sample.sql");

    console.log("⚙️ Applying schema/seed SQL (transactional, simple mode)...");
    await runSqlTransactional(sqlText);
    console.log("✅ Schema/seed applied successfully");

    await safeQuery("PostGIS version", "SELECT PostGIS_Version() as version");
    await safeQuery(
      "users table exists?",
      "SELECT to_regclass('public.users') AS users_table"
    );
    await safeQuery(
      "plots table exists?",
      "SELECT to_regclass('public.plots') AS plots_table"
    );

    // Counts (will fail gracefully if tables don't exist)
    await safeQuery("Total users", "SELECT COUNT(*)::int AS total FROM users");
    await safeQuery("Total plots", "SELECT COUNT(*)::int AS total FROM plots");

    console.log("🎉 Cemetery database initialization complete!");
    process.exitCode = 0;
  } catch (error) {
    console.error("❌ Database initialization error:");
    console.error(error?.message || error);

    console.error(
      "\n🔎 If you still see 'invalid message format', it is almost always:\n" +
        "1) Wrong DB URL (internal URL used from your local PC)\n" +
        "2) SSL mismatch (connecting with SSL to a non-SSL/proxy port or vice versa)\n" +
        "3) You copied an endpoint that is not actually Postgres\n"
    );

    process.exitCode = 1;
  } finally {
    await pool.end();
    console.log("🔌 Pool closed.");
  }
}

initializeDatabase();
