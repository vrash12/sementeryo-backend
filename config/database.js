const path = require("path");
const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config({
  path: path.resolve(__dirname, "..", ".env"),
  override: true,
});

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const parsed = new URL(DATABASE_URL);
console.log("[db] using DATABASE_URL");
console.log("[db] parsed config:", {
  username: parsed.username,
  host: parsed.hostname,
  port: parsed.port,
  database: parsed.pathname,
});

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: false,
});

pool.on("connect", () => console.log("✅ Connected to PostgreSQL"));
pool.on("error", (err) => console.error("❌ PostgreSQL error:", err));

module.exports = pool;