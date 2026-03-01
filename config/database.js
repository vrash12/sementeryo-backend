// backend/config/database.js
const path = require("path");
const { Pool } = require("pg");
const dotenv = require("dotenv");

// ✅ Load .env from backend/.env (NOT project root)
dotenv.config({
  path: path.resolve(__dirname, "..", ".env"), // backend/.env
  override: false, // don't clobber already-set env vars
});

const {
  NODE_ENV,
  DB_USER,
  DB_HOST,
  DB_NAME,
  DB_PASSWORD,
  DB_PORT,
  DATABASE_URL, // preferred (you have this in .env)
  DB_SSL,
} = process.env;

// ✅ Build config based on your .env (DATABASE_URL first)
const baseConfig = DATABASE_URL
  ? { connectionString: DATABASE_URL }
  : {
      user: DB_USER || "postgres",
      host: DB_HOST || "localhost",
      database: DB_NAME || "cemetery_db",
      password: String(DB_PASSWORD || ""),
      port: Number(DB_PORT) || 5432,
    };

// ✅ Debug (won't print password)
console.log("[db] env loaded from:", path.resolve(__dirname, "..", ".env"));
console.log("[db] using:", baseConfig.connectionString ? "DATABASE_URL" : "DB_*");
console.log("[db] config:", baseConfig.connectionString
  ? { connectionStringSet: true }
  : {
      user: baseConfig.user,
      host: baseConfig.host,
      database: baseConfig.database,
      port: baseConfig.port,
      passwordType: typeof baseConfig.password,
    }
);

// ✅ SSL handling (Render/managed DBs often require it)
const needsSSL =
  String(DB_SSL).toLowerCase() === "true" ||
  String(NODE_ENV).toLowerCase() === "production" ||
  (baseConfig.connectionString && /render\.com/i.test(baseConfig.connectionString)) ||
  /render\.com/i.test(DB_HOST || "");

const pool = new Pool({
  ...baseConfig,
  ssl: needsSSL ? { rejectUnauthorized: false } : false,
});

pool.on("connect", () => console.log("✅ Connected to PostgreSQL database"));
pool.on("error", (err) => console.error("❌ Database connection error:", err));

module.exports = pool;
