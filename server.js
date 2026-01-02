// backend/server.js
"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");

// ✅ Always load backend/.env (works even if you run from monorepo root)
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { notFound, errorHandler } = require("./middleware/errorHandler");
const pool = require("./config/database");

const adminRoutes = require("./routes/admin.routes");
const visitorRoutes = require("./routes/visitor.routes");
const plotRoutes = require("./routes/plot.routes");
const authRoutes = require("./routes/auth.routes"); // ✅ fixes /api/auth/login 404

/**
 * ✅ Serve uploads from backend/uploads
 * URLs like: /uploads/plots/<filename>
 */
const UPLOADS_DIR = path.join(__dirname, "uploads");

// Optional combined router (if you have backend/routes/index.js)
let api = null;
try {
  api = require("./routes");
} catch (e) {
  console.log("[SERVER] ./routes index not found (ok):", e.message);
}

const app = express();

/* ------------------------------- Debug ---------------------------------- */
console.log("[SERVER] NODE_ENV:", process.env.NODE_ENV);
console.log("[SERVER] PORT:", process.env.PORT);
console.log("[SERVER] JWT_SECRET loaded?", !!process.env.JWT_SECRET);

process.on("unhandledRejection", (err) => {
  console.error("[FATAL] unhandledRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err);
});

/* ----------------------------- Middleware -------------------------------- */
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false,
  })
);

// ✅ CORS (dev-safe / Cloud Run safe)
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ✅ Exact request logs (helps diagnose path / host / origin issues)
app.use((req, res, next) => {
  const start = Date.now();

  console.log(`--> ${req.method} ${req.originalUrl}`);
  console.log("    host:", req.headers.host);
  console.log("    origin:", req.headers.origin);
  console.log("    referer:", req.headers.referer);

  res.on("finish", () => {
    console.log(
      `<-- ${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`
    );
  });

  next();
});

// morgan (optional)
app.use(morgan("dev"));

/* ----------------------------- Static Files ------------------------------ */
app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    setHeaders(res) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  })
);

/* ------------------------------ Health ----------------------------------- */
// Health endpoint for Cloud Run
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// Root DB test (optional)
app.get("/", async (_req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS now");
    res.json({
      ok: true,
      message: "✅ API + DB connection working",
      time: result.rows[0].now,
    });
  } catch (err) {
    console.error("DB health check error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ------------------------------ Routes ----------------------------------- */
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/visitor", visitorRoutes);
app.use("/api/plot", plotRoutes);

// Optional combined router
if (api) app.use("/api", api);

/* -------------------------- Route Dump Helper ---------------------------- */
function dumpRoutes(app) {
  const routes = [];

  const walk = (stack, prefix = "") => {
    stack.forEach((layer) => {
      if (layer.route && layer.route.path) {
        const methods = Object.keys(layer.route.methods)
          .filter((m) => layer.route.methods[m])
          .map((m) => m.toUpperCase())
          .join(", ");
        routes.push({ methods, path: prefix + layer.route.path });
      } else if (layer.name === "router" && layer.handle?.stack) {
        walk(layer.handle.stack, prefix);
      }
    });
  };

  if (app._router?.stack) walk(app._router.stack, "");
  console.log("=== REGISTERED ROUTES (best-effort) ===");
  console.table(routes);
}

if (String(process.env.DUMP_ROUTES || "") === "1") {
  dumpRoutes(app);
}

/* --------------------------- 404 pre-logger ------------------------------ */
app.use((req, _res, next) => {
  console.warn("!!! 404 ROUTE NOT FOUND !!!");
  console.warn("method:", req.method);
  console.warn("url:", req.originalUrl);
  console.warn("host:", req.headers.host);
  console.warn("origin:", req.headers.origin);
  next();
});

app.get("/api/debug/db", async (_req, res) => {
  try {
    const db = await pool.query(
      "SELECT current_database() AS db, current_schema() AS schema"
    );

    const users = await pool.query(
      "SELECT to_regclass('public.users') AS users_table"
    );

    const plots = await pool.query(
      "SELECT to_regclass('public.plots') AS plots_table"
    );

    res.json({
      ok: true,
      database: db.rows[0],
      tables: {
        users: users.rows[0].users_table,
        plots: plots.rows[0].plots_table,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


/* --------------------------- Error Handlers ------------------------------ */
app.use(notFound);
app.use(errorHandler);

/* ------------------------------ Listen ----------------------------------- */
/**
 * ✅ Cloud Run requires listening on process.env.PORT (usually 8080)
 * ✅ MUST bind to 0.0.0.0 (not localhost)
 */
const PORT = Number(process.env.PORT) || 8080;

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on 0.0.0.0:${PORT}`);
});

server.on("error", (err) => {
  console.error("[LISTEN ERROR]", err);
});
