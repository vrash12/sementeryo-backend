// backend/controllers/visitor.controller.js
const pool = require("../config/database");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

/**
 * NOTE:
 * ✅ Search-by-name here DOES NOT use g.deceased_name.
 * It searches by plots.person_full_name.
 */

function sendBadRequest(res, message = "Invalid request") {
  return res.status(400).json({ success: false, message });
}

function isAdminUser(req) {
  const role = String(req.user?.role || "").toLowerCase();
  return role === "admin" || role === "superadmin";
}

function requireAdmin(req, res) {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return false;
  }
  if (!isAdminUser(req)) {
    res.status(403).json({ success: false, message: "Forbidden (admin only)" });
    return false;
  }
  return true;
}

// =============================== Upload: receipts ===============================
const receiptsDir = path.join(__dirname, "..", "uploads", "receipts");
if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true });

const receiptStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, receiptsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = ext || "";
    const name = `receipt_${Date.now()}_${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, name);
  },
});

function receiptFileFilter(_req, file, cb) {
  const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error("Invalid file type. Only JPG/PNG/WEBP/PDF allowed."));
  }
  cb(null, true);
}

const uploadReceipt = multer({
  storage: receiptStorage,
  fileFilter: receiptFileFilter,
  limits: { fileSize: 8 * 1024 * 1024 },
}).single("receipt");

// =============================== QR parsing helpers ===============================
function extractQrObject(qrToken) {
  if (!qrToken) return null;
  if (typeof qrToken === "object") return qrToken;

  const raw = String(qrToken).trim();
  if (!raw) return null;

  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function extractDeceasedNameFromQr(qrToken) {
  const obj = extractQrObject(qrToken);
  if (!obj || typeof obj !== "object") return "";

  const pickName = (o) =>
    o?.person_full_name ??
    o?.personFullName ??
    o?.person_name ??
    o?.personName ??
    o?.deceased_name ??
    o?.deceasedName ??
    o?.full_name ??
    o?.fullName ??
    o?.name;

  const direct = pickName(obj);
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;

    const hit = pickName(cur);
    if (typeof hit === "string" && hit.trim()) return hit.trim();

    for (const v of Object.values(cur)) {
      if (!v) continue;

      if (typeof v === "string") {
        const t = v.trim();
        if (t.startsWith("{") && t.endsWith("}")) {
          try {
            stack.push(JSON.parse(t));
          } catch {}
        }
      } else if (typeof v === "object") {
        stack.push(v);
      }
    }
  }

  return "";
}

// =============================== Name matching (NO deceased_name) ===============================
function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolvePersonFullName(row) {
  const fromQr = extractDeceasedNameFromQr(row?.qr_token);
  if (fromQr) return fromQr;

  const fromPlotJson = extractDeceasedNameFromQr(row?.plot);
  if (fromPlotJson) return fromPlotJson;

  const plotName = String(row?.plot_name || "").trim();
  if (plotName) return plotName;

  return "";
}

function matchesQuery(fullName, q) {
  const A = normalizeName(fullName);
  const B = normalizeName(q);
  if (!A || !B) return false;
  return A.includes(B);
}

// =============================== VISITOR: burial records search ===============================
async function getBurialRecords(req, res) {
  try {
    console.log("[HIT] visitor.controller.js getBurialRecords", req.query);

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const q = String(req.query?.q || "").trim();

    const limitRaw = req.query?.limit ? Number(req.query.limit) : 250;
    const offsetRaw = req.query?.offset ? Number(req.query.offset) : 0;

    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 5000)) : 250;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

    const params = [];
    let where = `
      WHERE p.status = 'occupied'
        AND NULLIF(TRIM(p.person_full_name), '') IS NOT NULL
    `;

    if (q) {
      params.push(`%${q}%`);
      where += ` AND p.person_full_name ILIKE $${params.length} `;
    }

    params.push(limit);
    params.push(offset);

    const sql = `
      SELECT
        p.id,
        p.uid,
        p.id::text AS plot_id,

        NULLIF(TRIM(p.person_full_name), '') AS person_full_name,
        NULL::text AS deceased_name,

        p.date_of_birth AS birth_date,
        p.date_of_death AS death_date,
        NULL::date AS burial_date,
        NULL::text AS qr_token,
        true AS is_active,
        p.created_at,
        p.updated_at,

        p.plot_name,
        p.status AS plot_status,
        p.uid AS plot_uid,

        NULLIF(TRIM(p.photo_url), '') AS photo_url,

        CASE
          WHEN COALESCE(p.coordinates, p.geom) IS NULL THEN NULL
          ELSE ST_Y(ST_PointOnSurface(COALESCE(p.coordinates::geometry, p.geom::geometry)))
        END AS lat,
        CASE
          WHEN COALESCE(p.coordinates, p.geom) IS NULL THEN NULL
          ELSE ST_X(ST_PointOnSurface(COALESCE(p.coordinates::geometry, p.geom::geometry)))
        END AS lng

      FROM plots p
      ${where}
      ORDER BY p.id DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length};
    `;

    const { rows } = await pool.query(sql, params);

    console.log(`[OK] visitor burial-records q="${q}" returned=${rows.length}`);

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getBurialRecords error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ✅ Robust: return deceased names related to this family_contact (visitor)
async function getMyDeceasedNames(req, res) {
  try {
    const { family_contact } = req.params;
    if (!family_contact) return sendBadRequest(res, "family_contact is required");

    const role = String(req.user?.role || "").toLowerCase();
    if (role === "visitor" && String(req.user?.id) !== String(family_contact)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const toSet = (rows) => new Set((rows || []).map((r) => String(r.column_name || "").toLowerCase()));

    async function tableExists(regclassText) {
      const r = await pool.query(`SELECT to_regclass($1) AS reg;`, [regclassText]);
      return Boolean(r.rows?.[0]?.reg);
    }

    async function getCols(tableName) {
      const r = await pool.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        `,
        [tableName]
      );
      return toSet(r.rows);
    }

    const pickFirst = (colsSet, candidates) => candidates.find((c) => colsSet.has(c)) || null;

    const sources = [];

    if (await tableExists("public.maintenance_requests")) {
      const cols = await getCols("maintenance_requests");
      const nameCol = pickFirst(cols, ["deceased_name", "person_full_name", "full_name", "name"]);
      const famCol = pickFirst(cols, ["family_contact", "familycontact", "user_id", "userid"]);
      const plotCol = pickFirst(cols, ["plot_id", "plotid", "grave_plot_id", "graveplotid"]);

      if (nameCol && famCol) {
        sources.push({ table: "maintenance_requests", nameCol, famCol, plotCol });
      }
    }

    if (await tableExists("public.burial_requests")) {
      const cols = await getCols("burial_requests");
      const nameCol = pickFirst(cols, ["deceased_name", "person_full_name", "full_name", "name"]);
      const famCol = pickFirst(cols, ["family_contact", "familycontact", "user_id", "userid"]);
      const plotCol = pickFirst(cols, ["plot_id", "plotid", "grave_plot_id", "graveplotid"]);

      if (nameCol && famCol) {
        sources.push({ table: "burial_requests", nameCol, famCol, plotCol });
      }
    }

    if (await tableExists("public.plots")) {
      const cols = await getCols("plots");
      const nameCol = pickFirst(cols, ["person_full_name", "deceased_name", "full_name", "name"]);
      const famCol = pickFirst(cols, ["family_contact", "familycontact", "user_id", "userid"]);
      const idCol = pickFirst(cols, ["id"]);

      if (nameCol && famCol && idCol) {
        sources.push({ table: "plots", nameCol, famCol, plotCol: "id" });
      }
    }

    if (!sources.length) {
      return res.json({ success: true, data: [] });
    }

    const parts = sources.map((s) => {
      const plotSel = s.plotCol ? `"${s.plotCol}"::text AS plot_id` : `NULL::text AS plot_id`;
      return `
        SELECT
          NULLIF(TRIM("${s.nameCol}"), '') AS deceased_name,
          ${plotSel}
        FROM "${s.table}"
        WHERE "${s.famCol}" = $1
          AND NULLIF(TRIM("${s.nameCol}"), '') IS NOT NULL
      `;
    });

    const sql = `
      SELECT deceased_name, MAX(plot_id) AS plot_id
      FROM (
        ${parts.join(" UNION ALL ")}
      ) s
      GROUP BY deceased_name
      ORDER BY deceased_name ASC;
    `;

    const { rows } = await pool.query(sql, [family_contact]);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getMyDeceasedNames error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

/* =============================== Burial Request (visitor) ===============================
   ✅ REQUIRE approved reservation
   ✅ AUTO-ASSIGN plot_id to that reserved plot
   ✅ (optional) reservation_id if column exists
=============================================================================== */
async function createBurialRequest(req, res) {
  try {
    const { deceased_name, birth_date, death_date, burial_date, family_contact } = req.body || {};

    if (!deceased_name || !birth_date || !death_date || !burial_date || !family_contact) {
      return sendBadRequest(
        res,
        "All fields are required: deceased_name, birth_date, death_date, burial_date, family_contact"
      );
    }

    const role = String(req.user?.role || "").toLowerCase();
    if (role === "visitor" && String(req.user?.id) !== String(family_contact)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const hasPlotId = await hasColumn("burial_requests", "plot_id");
    if (!hasPlotId) {
      return res.status(400).json({
        success: false,
        message:
          "burial_requests.plot_id column is missing. Please add plot_id column.",
      });
    }

    // ✅ Find latest APPROVED reservation for this user
    const approved = await pool.query(
      `
      SELECT
        r.id::text AS reservation_id,
        r.plot_id::text AS plot_id,
        p.status AS plot_status
      FROM plot_reservations r
      JOIN plots p ON p.id = r.plot_id
      WHERE r.user_id::text = $1
        AND LOWER(r.status) = 'approved'
      ORDER BY r.updated_at DESC NULLS LAST, r.created_at DESC
      LIMIT 1
      `,
      [String(family_contact)]
    );

    if (!approved.rows.length) {
      return res.status(409).json({
        success: false,
        message: "No approved reservation found. Please wait for admin approval before submitting a burial request.",
      });
    }

    const plot_id = approved.rows[0].plot_id;
    const reservation_id = approved.rows[0].reservation_id;
    const plotStatus = String(approved.rows[0].plot_status || "").toLowerCase();

    if (plotStatus === "occupied") {
      return res.status(409).json({ success: false, message: "Reserved plot is already occupied." });
    }

    // ✅ prevent duplicate pending/approved burial request for same plot
    const dup = await pool.query(
      `
      SELECT 1
      FROM burial_requests
      WHERE plot_id::text = $1
        AND LOWER(status) IN ('pending','approved')
      LIMIT 1
      `,
      [String(plot_id)]
    );
    if (dup.rows.length) {
      return res.status(409).json({
        success: false,
        message: "A burial request is already pending for your reserved plot.",
      });
    }

    const hasReservationId = await hasColumn("burial_requests", "reservation_id");

    const cols = [
      "deceased_name",
      "birth_date",
      "death_date",
      "burial_date",
      "family_contact",
      "plot_id",
      "status",
      "created_at",
      "updated_at",
    ];

    const params = [
      String(deceased_name).trim(),
      birth_date,
      death_date,
      burial_date,
      family_contact,
      String(plot_id),
    ];

    const vals = ["$1", "$2", "$3", "$4", "$5", "$6"];

    if (hasReservationId) {
      cols.splice(6, 0, "reservation_id");
      vals.push(`$${params.length + 1}`);
      params.push(String(reservation_id));
    }

    const sql = `
      INSERT INTO burial_requests (${cols.join(", ")})
      VALUES (${vals.join(", ")}, 'pending', NOW(), NOW())
      RETURNING *;
    `;

    const { rows } = await pool.query(sql, params);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("createBurialRequest error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function createMaintenanceRequest(req, res) {
  try {
    const { deceased_name, family_contact, description, priority, preferred_date, preferred_time } =
      req.body || {};

    if (!deceased_name || !String(deceased_name).trim()) {
      return sendBadRequest(res, "deceased_name is required");
    }

    const role = String(req.user?.role || "").toLowerCase();
    if (role === "visitor" && String(req.user?.id) !== String(family_contact)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const safeDescription =
      String(description || "").trim() || `Maintenance request for ${String(deceased_name).trim()}`;

    const request_type = "maintenance";
    const safePriority = String(priority || "medium").toLowerCase();

    const sql = `
      INSERT INTO maintenance_requests
        (request_type, deceased_name, family_contact, description, priority, preferred_date, preferred_time, status, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW(), NOW())
      RETURNING *;
    `;

    const values = [
      request_type,
      String(deceased_name).trim(),
      family_contact,
      safeDescription,
      safePriority,
      preferred_date || null,
      preferred_time || null,
    ];

    const { rows } = await pool.query(sql, values);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("createMaintenanceRequest error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function getMyMaintenanceSchedule(req, res) {
  try {
    const { family_contact } = req.params;
    if (!family_contact) return sendBadRequest(res, "family_contact is required");

    const role = String(req.user?.role || "").toLowerCase();
    if (role === "visitor" && String(req.user?.id) !== String(family_contact)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const sql = `
      SELECT
        mr.*,
        (u.first_name || ' ' || u.last_name) AS assigned_staff_name
      FROM maintenance_requests mr
      LEFT JOIN users u ON u.id = mr.assigned_staff_id
      WHERE mr.family_contact = $1
      ORDER BY mr.created_at DESC;
    `;

    const { rows } = await pool.query(sql, [family_contact]);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getMyMaintenanceSchedule error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function requestMaintenanceReschedule(req, res) {
  try {
    const { id } = req.params;
    const { preferred_date, preferred_time, reason } = req.body || {};

    if (!id) return sendBadRequest(res, "id is required");
    if (!preferred_date || !preferred_time) {
      return sendBadRequest(res, "preferred_date and preferred_time are required");
    }

    const cur = await pool.query(`SELECT * FROM maintenance_requests WHERE id = $1 LIMIT 1`, [id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, message: "Not found" });

    const row = cur.rows[0];

    const role = String(req.user?.role || "").toLowerCase();
    if (role === "visitor" && String(req.user?.id) !== String(row.family_contact)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const status = String(row.status || "").toLowerCase();
    if (["completed", "closed", "cancelled", "canceled"].includes(status)) {
      return res.status(409).json({
        success: false,
        message: `Cannot reschedule when status is "${status}"`,
      });
    }

    const note = String(reason || "").trim();
    const rescheduleNote = note ? `\nReschedule reason: ${note}` : "";

    const upd = await pool.query(
      `
      UPDATE maintenance_requests
      SET
        preferred_date = $2,
        preferred_time = $3,
        status = 'reschedule_requested',
        description = description || '',
        updated_at = NOW()
      WHERE id = $1
      RETURNING *;
      `,
      [id, preferred_date, preferred_time]
    );

    if (rescheduleNote) {
      await pool.query(
        `
        UPDATE maintenance_requests
        SET description = COALESCE(description,'') || $2,
            updated_at = NOW()
        WHERE id = $1
        `,
        [id, rescheduleNote]
      );
    }

    return res.json({ success: true, message: "Reschedule requested", data: upd.rows[0] });
  } catch (err) {
    console.error("requestMaintenanceReschedule error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function submitMaintenanceFeedback(req, res) {
  try {
    const { id } = req.params;
    const { rating, feedback_text } = req.body || {};

    if (!id) return sendBadRequest(res, "id is required");

    const r = Number(rating);
    if (!Number.isFinite(r) || r < 1 || r > 5) {
      return sendBadRequest(res, "rating must be 1 to 5");
    }

    const cur = await pool.query(`SELECT * FROM maintenance_requests WHERE id = $1 LIMIT 1`, [id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, message: "Not found" });

    const row = cur.rows[0];

    const role = String(req.user?.role || "").toLowerCase();
    if (role === "visitor" && String(req.user?.id) !== String(row.family_contact)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const status = String(row.status || "").toLowerCase();
    if (status !== "completed") {
      return res.status(409).json({
        success: false,
        message: "Feedback is only allowed after completion.",
      });
    }

    const upd = await pool.query(
      `
      UPDATE maintenance_requests
      SET feedback_rating = $2,
          feedback_text = $3,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *;
      `,
      [id, r, String(feedback_text || "").trim() || null]
    );

    return res.json({ success: true, message: "Feedback saved", data: upd.rows[0] });
  } catch (err) {
    console.error("submitMaintenanceFeedback error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function getBurialRequests(req, res) {
  try {
    const { family_contact } = req.params;
    if (!family_contact) return sendBadRequest(res, "family_contact is required");

    const sql = `SELECT * FROM burial_requests WHERE family_contact = $1 ORDER BY created_at DESC`;
    const { rows } = await pool.query(sql, [family_contact]);

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getBurialRequests error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function getMaintenanceRequests(req, res) {
  try {
    const { family_contact } = req.params;
    if (!family_contact) return sendBadRequest(res, "family_contact is required");

    const sql = `SELECT * FROM maintenance_requests WHERE family_contact = $1 ORDER BY created_at DESC`;
    const { rows } = await pool.query(sql, [family_contact]);

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getMaintenanceRequests error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// =============================== Dashboard ===============================
async function getDashboardStats(req, res) {
  try {
    const visitorsQuery = pool.query(`SELECT COUNT(*) AS count FROM visit_logs`);
    const gravesQuery = pool.query(`SELECT COUNT(*) AS count FROM plots`);
    const requestsQuery = pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM maintenance_requests WHERE status = 'completed') +
        (SELECT COUNT(*) FROM burial_schedules WHERE status = 'completed') AS total
    `);

    const familiesQuery = pool.query(`SELECT COUNT(DISTINCT family_contact) AS count FROM graves`);
    const yearsQuery = pool.query(`SELECT MIN(created_at) as first_date FROM plots`);

    const [visitorsRes, gravesRes, requestsRes, familiesRes, yearsRes] = await Promise.all([
      visitorsQuery,
      gravesQuery,
      requestsQuery,
      familiesQuery,
      yearsQuery,
    ]);

    const currentYear = new Date().getFullYear();
    const firstYear = yearsRes.rows[0].first_date
      ? new Date(yearsRes.rows[0].first_date).getFullYear()
      : 2000;
    const yearsOfService = Math.max(1, currentYear - firstYear);

    const stats = {
      visitors: parseInt(visitorsRes.rows[0].count || 0, 10),
      graves: parseInt(gravesRes.rows[0].count || 0, 10),
      requests: parseInt(requestsRes.rows[0].total || 0, 10),
      families: parseInt(familiesRes.rows[0].count || 0, 10),
      years: yearsOfService,
    };

    return res.status(200).json({ success: true, data: stats });
  } catch (err) {
    console.error("getDashboardStats error:", err);
    return res.status(500).json({ success: false, message: "Server error fetching stats" });
  }
}

// =============================== Reservations (user) ===============================
/**
 * ✅ NEW FLOW:
 * - Pending reservation does NOT lock plot
 * - Plot locks ONLY on admin approval
 */
async function reservePlot(req, res) {
  const client = await pool.connect();
  try {
    const { plot_id, notes } = req.body;
    const user_id = req.user?.id;

    if (!plot_id) return res.status(400).json({ success: false, message: "Plot ID is required" });
    if (!user_id) return res.status(401).json({ success: false, message: "Unauthorized" });

    await client.query("BEGIN");

    const checkSql = `SELECT id, status FROM plots WHERE id = $1 FOR UPDATE`;
    const { rows: plotRows } = await client.query(checkSql, [plot_id]);

    if (plotRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Plot not found" });
    }

    const plot = plotRows[0];
    const s = String(plot.status || "").toLowerCase();
    if (s === "occupied" || s === "reserved") {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: `Plot is locked (${plot.status})` });
    }

    // prevent same-user duplicate active reservation
    const dup = await client.query(
      `
      SELECT 1
      FROM plot_reservations
      WHERE plot_id = $1
        AND user_id = $2
        AND LOWER(status) IN ('pending','approved')
      LIMIT 1
      `,
      [plot_id, user_id]
    );
    if (dup.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "You already have an active reservation for this plot." });
    }

    const insertResSql = `
      INSERT INTO plot_reservations (plot_id, user_id, status, notes)
      VALUES ($1, $2, 'pending', $3)
      RETURNING *;
    `;
    const { rows: resRows } = await client.query(insertResSql, [plot_id, user_id, notes || null]);

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Reservation submitted (pending admin approval)",
      data: resRows[0],
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("reservePlot error:", err);
    return res.status(500).json({ success: false, message: "Server error processing reservation" });
  } finally {
    client.release();
  }
}

async function getMyReservations(req, res) {
  try {
    const user_id = req.user?.id;
    if (!user_id) return res.status(401).json({ success: false, message: "Unauthorized" });

    const sql = `
      SELECT 
        r.*, 
        p.plot_code, 
        p.section_name, 
        p.price, 
        p.size_sqm
      FROM plot_reservations r
      JOIN plots p ON r.plot_id = p.id
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC
    `;
    const { rows } = await pool.query(sql, [user_id]);

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getMyReservations error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function cancelReservation(req, res) {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const user_id = req.user?.id;

    if (!id) return res.status(400).json({ success: false, message: "Reservation ID required" });
    if (!user_id) return res.status(401).json({ success: false, message: "Unauthorized" });

    await client.query("BEGIN");

    const checkSql = `SELECT * FROM plot_reservations WHERE id = $1 AND user_id = $2 FOR UPDATE`;
    const { rows } = await client.query(checkSql, [id, user_id]);

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Reservation not found or access denied" });
    }

    const reservation = rows[0];
    const status = String(reservation.status).toLowerCase();
    if (status === "cancelled") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Already cancelled" });
    }

    await client.query(
      `UPDATE plot_reservations SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // ✅ Only release plot if it was actually locked (reserved) and no other active approved reservation exists
    const plotRow = await client.query(`SELECT status FROM plots WHERE id = $1 FOR UPDATE`, [
      reservation.plot_id,
    ]);
    const plotStatus = String(plotRow.rows?.[0]?.status || "").toLowerCase();

    if (plotStatus === "reserved") {
      const active = await client.query(
        `
        SELECT COUNT(*)::int AS cnt
        FROM plot_reservations
        WHERE plot_id = $1
          AND id <> $2
          AND LOWER(status) = 'approved'
        `,
        [reservation.plot_id, id]
      );
      const activeCnt = active.rows?.[0]?.cnt || 0;

      if (activeCnt === 0) {
        await client.query(`UPDATE plots SET status = 'available', updated_at = NOW() WHERE id = $1`, [
          reservation.plot_id,
        ]);
      }
    }

    await client.query("COMMIT");
    return res.json({ success: true, message: "Reservation cancelled" });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("cancelReservation error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  } finally {
    client.release();
  }
}

async function uploadReservationReceipt(req, res) {
  try {
    const reservationId = req.params.id;
    const user_id = req.user?.id;

    if (!reservationId) {
      return res.status(400).json({ success: false, message: "Reservation ID is required" });
    }
    if (!user_id) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    uploadReceipt(req, res, async (err) => {
      if (err) {
        return res.status(400).json({ success: false, message: err.message || "Upload error" });
      }
      if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded (receipt)" });
      }

      const checkSql = `SELECT * FROM plot_reservations WHERE id = $1 AND user_id = $2`;
      const check = await pool.query(checkSql, [reservationId, user_id]);

      // cleanup uploaded file if reservation not found
      if (check.rows.length === 0) {
        try { fs.unlinkSync(req.file.path); } catch {}
        return res
          .status(404)
          .json({ success: false, message: "Reservation not found or access denied" });
      }

      const reservation = check.rows[0];
      const status = String(reservation.status || "").toLowerCase();
      const payStatus = String(reservation.payment_status || "").toLowerCase();

      // 🚫 disallow uploads for closed states
      if (["rejected", "cancelled", "canceled", "completed"].includes(status)) {
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(409).json({
          success: false,
          message: `Cannot upload receipt because reservation is ${status}.`,
        });
      }

      // 🚫 if already accepted, block replacing receipt (optional but safer)
      if (payStatus === "accepted") {
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(409).json({
          success: false,
          message: "Payment is already accepted. Receipt can no longer be changed.",
        });
      }

      // optional: delete old receipt file to avoid orphan files
      const oldUrl = String(reservation.payment_receipt_url || "").trim();
      if (oldUrl) {
        const oldName = oldUrl.split("/").pop();
        if (oldName) {
          const oldPath = path.join(receiptsDir, oldName);
          try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch {}
        }
      }

      const receiptUrl = `/uploads/receipts/${req.file.filename}`;

      const updateSql = `
        UPDATE plot_reservations
        SET 
          payment_receipt_url = $1,
          payment_status = 'submitted',
          payment_uploaded_at = NOW(),
          updated_at = NOW()
        WHERE id = $2 AND user_id = $3
        RETURNING *;
      `;
      const updated = await pool.query(updateSql, [receiptUrl, reservationId, user_id]);

      return res.json({
        success: true,
        message: "Receipt uploaded. Waiting for admin approval.",
        data: updated.rows[0],
      });
    });
  } catch (e) {
    console.error("uploadReservationReceipt error:", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// =============================== Admin: reservations ===============================
async function getReservationsAsAdmin(req, res) {
  try {
    if (!requireAdmin(req, res)) return;

    const sql = `
      SELECT
        r.*,
        u.email AS reserved_for_email,
        COALESCE(u.full_name, u.name, u.username, u.email, ('User #' || u.id::text)) AS reserved_for_name,
        p.uid AS plot_uid,
        COALESCE(p.plot_name, p.plot_code, p.section_name, ('Plot #' || p.id::text)) AS plot_name,
        p.plot_code,
        p.section_name,
        p.price AS plot_price,
        p.size_sqm AS plot_size_sqm,
        p.status AS plot_status
      FROM plot_reservations r
      LEFT JOIN users u ON u.id = r.user_id
      LEFT JOIN plots p ON p.id = r.plot_id
      ORDER BY r.created_at DESC, r.id DESC;
    `;

    const { rows } = await pool.query(sql);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getReservationsAsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function approveReservationAsAdmin(req, res) {
  const client = await pool.connect();
  try {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;
    if (!id) return sendBadRequest(res, "Reservation ID required");

    await client.query("BEGIN");

    const rSql = `SELECT * FROM plot_reservations WHERE id = $1 FOR UPDATE`;
    const rRes = await client.query(rSql, [id]);
    if (!rRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Reservation not found" });
    }

    const reservation = rRes.rows[0];
    const current = String(reservation.status || "").toLowerCase();

    if (current === "approved") {
      await client.query("ROLLBACK");
      return res.json({ success: true, message: "Already approved", data: reservation });
    }

    if (["rejected", "cancelled", "canceled", "completed"].includes(current)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: `Cannot approve a ${current} reservation`,
      });
    }

    // ✅ NEW: REQUIRE receipt BEFORE approval
    const receiptUrl = String(reservation.payment_receipt_url || "").trim();
    const payStatus = String(reservation.payment_status || "").toLowerCase();

    if (!receiptUrl) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Cannot approve reservation: no receipt uploaded yet.",
      });
    }

    // optional: also require payment_status to be submitted/accepted
    // (if your DB always has payment_status, keep this enabled)
    if (payStatus && !["submitted", "accepted"].includes(payStatus)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Cannot approve reservation: receipt is not submitted/valid yet.",
      });
    }

    // lock plot row
    const pSql = `SELECT id, status FROM plots WHERE id = $1 FOR UPDATE`;
    const pRes = await client.query(pSql, [reservation.plot_id]);
    if (!pRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Plot not found" });
    }

    const plotStatus = String(pRes.rows[0].status || "").toLowerCase();
    if (plotStatus === "occupied" || plotStatus === "reserved") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: `Cannot approve: plot is locked (${pRes.rows[0].status}).`,
      });
    }

    // approve reservation
    const updSql = `
      UPDATE plot_reservations
      SET status = 'approved', updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `;
    const upd = await client.query(updSql, [id]);

    // ✅ LOCK plot ONLY on approval
    await client.query(`UPDATE plots SET status = 'reserved', updated_at = NOW() WHERE id = $1`, [
      reservation.plot_id,
    ]);

    // ✅ Optional: reject other pending reservations for same plot
    await client.query(
      `
      UPDATE plot_reservations
      SET status = 'rejected', updated_at = NOW()
      WHERE plot_id = $1
        AND id <> $2
        AND LOWER(status) = 'pending'
      `,
      [reservation.plot_id, id]
    );

    await client.query("COMMIT");
    return res.json({ success: true, message: "Reservation approved", data: upd.rows[0] });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("approveReservationAsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  } finally {
    client.release();
  }
}


async function rejectReservationAsAdmin(req, res) {
  const client = await pool.connect();
  try {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;
    if (!id) return sendBadRequest(res, "Reservation ID required");

    await client.query("BEGIN");

    const rSql = `SELECT * FROM plot_reservations WHERE id = $1 FOR UPDATE`;
    const rRes = await client.query(rSql, [id]);
    if (!rRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Reservation not found" });
    }

    const reservation = rRes.rows[0];
    const current = String(reservation.status || "").toLowerCase();

    if (current === "rejected") {
      await client.query("ROLLBACK");
      return res.json({ success: true, message: "Already rejected", data: reservation });
    }

    if (current === "cancelled" || current === "canceled") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: `Cannot reject a ${current} reservation`,
      });
    }

    const pSql = `SELECT id, status FROM plots WHERE id = $1 FOR UPDATE`;
    const pRes = await client.query(pSql, [reservation.plot_id]);
    if (!pRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Plot not found" });
    }

    const updSql = `
      UPDATE plot_reservations
      SET status = 'rejected', updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `;
    const upd = await client.query(updSql, [id]);

    const activeSql = `
      SELECT COUNT(*)::int AS cnt
      FROM plot_reservations
      WHERE plot_id = $1
        AND id <> $2
        AND LOWER(status) IN ('pending', 'approved')
    `;
    const active = await client.query(activeSql, [reservation.plot_id, id]);
    const activeCnt = active.rows?.[0]?.cnt || 0;

    if (activeCnt === 0) {
      await client.query(`UPDATE plots SET status = 'available', updated_at = NOW() WHERE id = $1`, [
        reservation.plot_id,
      ]);
    }

    await client.query("COMMIT");
    return res.json({ success: true, message: "Reservation rejected", data: upd.rows[0] });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("rejectReservationAsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  } finally {
    client.release();
  }
}

async function cancelReservationAsAdmin(req, res) {
  const client = await pool.connect();
  try {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;
    if (!id) return sendBadRequest(res, "Reservation ID required");

    await client.query("BEGIN");

    const rSql = `SELECT * FROM plot_reservations WHERE id = $1 FOR UPDATE`;
    const rRes = await client.query(rSql, [id]);
    if (!rRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Reservation not found" });
    }

    const reservation = rRes.rows[0];
    const current = String(reservation.status || "").toLowerCase();

    if (current === "cancelled" || current === "canceled") {
      await client.query("ROLLBACK");
      return res.json({ success: true, message: "Already cancelled", data: reservation });
    }

    const pSql = `SELECT id, status FROM plots WHERE id = $1 FOR UPDATE`;
    const pRes = await client.query(pSql, [reservation.plot_id]);
    if (!pRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Plot not found" });
    }

    const updSql = `
      UPDATE plot_reservations
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `;
    const upd = await client.query(updSql, [id]);

    const activeSql = `
      SELECT COUNT(*)::int AS cnt
      FROM plot_reservations
      WHERE plot_id = $1
        AND id <> $2
        AND LOWER(status) IN ('pending', 'approved')
    `;
    const active = await client.query(activeSql, [reservation.plot_id, id]);
    const activeCnt = active.rows?.[0]?.cnt || 0;

    if (activeCnt === 0) {
      await client.query(`UPDATE plots SET status = 'available', updated_at = NOW() WHERE id = $1`, [
        reservation.plot_id,
      ]);
    }

    await client.query("COMMIT");
    return res.json({ success: true, message: "Reservation cancelled", data: upd.rows[0] });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("cancelReservationAsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  } finally {
    client.release();
  }
}

async function acceptPaymentAsAdmin(req, res) {
  try {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;
    if (!id) return sendBadRequest(res, "Reservation ID required");

    const sql = `
      UPDATE plot_reservations
      SET
        payment_status = 'accepted',
        payment_verified_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `;
    const { rows } = await pool.query(sql, [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Reservation not found" });
    }

    return res.json({ success: true, message: "Payment accepted", data: rows[0] });
  } catch (err) {
    console.error("acceptPaymentAsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function rejectPaymentAsAdmin(req, res) {
  try {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;
    if (!id) return sendBadRequest(res, "Reservation ID required");

    const sql = `
      UPDATE plot_reservations
      SET
        payment_status = 'rejected',
        payment_verified_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `;
    const { rows } = await pool.query(sql, [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Reservation not found" });
    }

    return res.json({ success: true, message: "Payment rejected", data: rows[0] });
  } catch (err) {
    console.error("rejectPaymentAsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// =============================== Cancel requests ===============================
async function cancelBurialRequest(req, res) {
  try {
    const { id } = req.params;
    if (!id) return sendBadRequest(res, "id is required");

    const sql = `
      UPDATE burial_requests
      SET status = 'canceled'
      WHERE id = $1
      RETURNING *;
    `;
    const { rows } = await pool.query(sql, [id]);
    if (!rows.length) return sendBadRequest(res, "Request not found");

    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("cancelBurialRequest error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// =============================== Deceased Family (Visitor) ===============================
const _hasColumnCache = new Map();
async function hasColumn(tableName, columnName) {
  const key = `${String(tableName)}.${String(columnName)}`;
  if (_hasColumnCache.has(key)) return _hasColumnCache.get(key);

  const { rows } = await pool.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1
    `,
    [String(tableName), String(columnName)]
  );

  const ok = rows.length > 0;
  _hasColumnCache.set(key, ok);
  return ok;
}

const _hasTableCache = new Map();
async function hasTable(tableName) {
  const key = String(tableName);
  if (_hasTableCache.has(key)) return _hasTableCache.get(key);

  const { rows } = await pool.query(`SELECT to_regclass($1) AS reg;`, [
    `public.${String(tableName)}`,
  ]);

  const ok = Boolean(rows?.[0]?.reg);
  _hasTableCache.set(key, ok);
  return ok;
}

async function getMyDeceasedFamily(req, res) {
  try {
    const { family_contact } = req.params;
    if (!family_contact) {
      return res.status(400).json({ success: false, message: "family_contact is required" });
    }

    const role = String(req.user?.role || "").toLowerCase();
    if (role === "visitor" && String(req.user?.id) !== String(family_contact)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const gHasQr = await hasColumn("graves", "qr_token");
    const pHasQr = await hasColumn("plots", "qr_token");
    const gHasPhoto = await hasColumn("graves", "photo_url");
    const pHasPhoto = await hasColumn("plots", "photo_url");

    const qrExpr =
      gHasQr && pHasQr
        ? "COALESCE(g.qr_token, p.qr_token) AS qr_token"
        : gHasQr
        ? "g.qr_token AS qr_token"
        : pHasQr
        ? "p.qr_token AS qr_token"
        : "NULL::text AS qr_token";

    const photoExpr =
      gHasPhoto && pHasPhoto
        ? "COALESCE(g.photo_url, p.photo_url) AS photo_url"
        : gHasPhoto
        ? "g.photo_url AS photo_url"
        : pHasPhoto
        ? "p.photo_url AS photo_url"
        : "NULL::text AS photo_url";

    const gravesSql = `
      SELECT
        ('grave-' || g.id::text) AS id,
        g.uid,
        g.deceased_name,
        g.birth_date,
        g.death_date,
        g.burial_date,
        g.headstone_type,
        g.memorial_text,
        p.plot_name,
        ${qrExpr},
        ${photoExpr},
        g.is_active,
        g.created_at,
        g.updated_at,
        'confirmed'::text AS record_status,
        'graves'::text AS record_source
      FROM graves g
      LEFT JOIN plots p ON p.id::text = g.plot_id::text
      WHERE g.family_contact::text = $1
    `;

    let requestsSql = `SELECT NULL WHERE false`;
    if (await hasTable("burial_requests")) {
      requestsSql = `
        SELECT
          ('req-' || br.id::text) AS id,
          NULL::text AS uid,
          br.deceased_name,
          br.birth_date,
          br.death_date,
          br.burial_date,
          NULL::text AS headstone_type,
          NULL::text AS memorial_text,
          NULL::text AS plot_name,
          NULL::text AS qr_token,
          NULL::text AS photo_url,
          true AS is_active,
          br.created_at,
          br.updated_at,
          COALESCE(br.status, 'pending')::text AS record_status,
          'burial_requests'::text AS record_source
        FROM burial_requests br
        WHERE br.family_contact::text = $1
      `;
    }

    const finalSql = `
      SELECT *
      FROM (
        ${gravesSql}
        UNION ALL
        ${requestsSql}
      ) x
      ORDER BY x.created_at DESC NULLS LAST;
    `;

    const { rows } = await pool.query(finalSql, [String(family_contact)]);
    return res.json(rows);
  } catch (err) {
    console.error("getMyDeceasedFamily error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function cancelMaintenanceRequest(req, res) {
  try {
    const { id } = req.params;
    if (!id) return sendBadRequest(res, "id is required");

    const sql = `
      UPDATE maintenance_requests
      SET status = 'cancelled'
      WHERE id = $1
      RETURNING *;
    `;
    const { rows } = await pool.query(sql, [id]);
    if (!rows.length) return sendBadRequest(res, "Request not found");

    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("cancelMaintenanceRequest error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = {
  // visitor search
  getBurialRecords,

  // requests
  createBurialRequest,
  createMaintenanceRequest,
  getMyDeceasedNames,
  getBurialRequests,
  getMaintenanceRequests,
  cancelBurialRequest,
  cancelMaintenanceRequest,

  // dashboard
  getDashboardStats,

  // deceased family
  getMyDeceasedFamily,

  // reservations (user)
  reservePlot,
  getMyReservations,
  cancelReservation,
  uploadReservationReceipt,

  // reservations (admin)
  getReservationsAsAdmin,
  approveReservationAsAdmin,
  rejectReservationAsAdmin,
  cancelReservationAsAdmin,
  acceptPaymentAsAdmin,
  rejectPaymentAsAdmin,

  // maintenance schedule
  getMyMaintenanceSchedule,
  requestMaintenanceReschedule,
  submitMaintenanceFeedback,
};
