// backend/config/database.js
const path = require("path");
const { Pool } = require("pg");
const dotenv = require("dotenv");

// Load .env from project root (cemetery-mono/.env)
dotenv.config({
  path: path.resolve(__dirname, "..", "..", ".env"),
  override: false, // don't clobber already-set env vars
});

const {
  DB_USER,
  DB_HOST,
  DB_NAME,
  DB_PASSWORD,
  DB_PORT,
  DATABASE_URL, // optional
  DB_SSL,
} = process.env;

// Build base config
const baseConfig = DATABASE_URL
  ? { connectionString: DATABASE_URL }
  : {
      user: DB_USER || "cemetery_user",
      host: DB_HOST || "localhost",
      database: DB_NAME || "cemetery_db",

      // ✅ ALWAYS give pg a string for password.
      // If DB_PASSWORD is missing, fall back to your dev password.
      password:
        DB_PASSWORD === undefined || DB_PASSWORD === null
          ? "cemetery123"
          : String(DB_PASSWORD),

      port: Number(DB_PORT) || 5432,
    };

// Helpful debug (doesn't log the actual password)
console.log("[db] config:", {
  user: baseConfig.user,
  host: baseConfig.host,
  database: baseConfig.database,
  port: baseConfig.port,
  passwordType: typeof baseConfig.password,
});

// SSL handling (Render/Neon/etc)
const needsSSL =
  String(DB_SSL).toLowerCase() === "true" ||
  (baseConfig.connectionString &&
    /render\.com/i.test(baseConfig.connectionString)) ||
  /render\.com/i.test(DB_HOST || "");

const pool = new Pool({
  ...baseConfig,
  ssl: needsSSL ? { rejectUnauthorized: false } : false,
});

pool.on("connect", () =>
  console.log("✅ Connected to PostgreSQL database")
);
pool.on("error", (err) =>
  console.error("❌ Database connection error:", err)
);

module.exports = pool;
