"use strict";

const pool = require("../config/database");

function isPrivileged(user) {
  const role = String(user?.role || "").toLowerCase();
  return role === "admin" || role === "staff" || role === "superadmin";
}

/**
 * Safely coerce a value (text/number) into BIGINT for joins.
 * - If value is not purely numeric, returns NULL (no join match, but no crash).
 */
function safeBigintExpr(columnSql) {
  // columnSql should be something like: "mr.family_contact"
  return `
    CASE
      WHEN ${columnSql} IS NULL THEN NULL
      WHEN TRIM(${columnSql}::text) = '' THEN NULL
      WHEN TRIM(${columnSql}::text) ~ '^[0-9]+$' THEN TRIM(${columnSql}::text)::bigint
      ELSE NULL
    END
  `;
}

async function getMaintenanceRequests(req, res, next) {
  try {
    if (!isPrivileged(req.user)) return res.status(403).json({ error: "Forbidden" });

    const status = String(req.query?.status || "").trim();

    const sql = `
      SELECT
        mr.*,
        (v.first_name || ' ' || v.last_name) AS requester_name,
        (s.first_name || ' ' || s.last_name) AS assigned_staff_name
      FROM maintenance_requests mr
      LEFT JOIN users v
        ON v.id = ${safeBigintExpr("mr.family_contact")}
      LEFT JOIN users s
        ON s.id = ${safeBigintExpr("mr.assigned_staff_id")}
      ${status ? "WHERE LOWER(mr.status::text) = LOWER($1)" : ""}
      ORDER BY mr.created_at DESC;
    `;

    const { rows } = await pool.query(sql, status ? [status] : []);
    return res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
}

async function scheduleMaintenance(req, res, next) {
  try {
    if (!isPrivileged(req.user)) return res.status(403).json({ error: "Forbidden" });

    const { id } = req.params;
    const { scheduled_date, scheduled_time, assigned_staff_id } = req.body || {};

    if (!id) return res.status(400).json({ error: "Missing id" });
    if (!scheduled_date || !scheduled_time) {
      return res.status(400).json({ error: "scheduled_date and scheduled_time are required" });
    }

    // keep whatever your column type is (text/bigint) — we store as string if provided
    const staffVal =
      assigned_staff_id === undefined || assigned_staff_id === null || String(assigned_staff_id).trim() === ""
        ? null
        : String(assigned_staff_id).trim();

    const upd = await pool.query(
      `
      UPDATE maintenance_requests
      SET
        scheduled_date = $2,
        scheduled_time = $3,
        assigned_staff_id = $4,
        scheduled_by = $5,
        status = 'scheduled',
        updated_at = NOW()
      WHERE id = $1
      RETURNING *;
      `,
      [id, scheduled_date, scheduled_time, staffVal, req.user.id || null]
    );

    if (!upd.rows.length) return res.status(404).json({ error: "Not found" });
    return res.json({ ok: true, message: "Scheduled", data: upd.rows[0] });
  } catch (err) {
    next(err);
  }
}

async function completeMaintenance(req, res, next) {
  try {
    if (!isPrivileged(req.user)) return res.status(403).json({ error: "Forbidden" });

    const { id } = req.params;
    const { completion_notes } = req.body || {};

    if (!id) return res.status(400).json({ error: "Missing id" });

    const upd = await pool.query(
      `
      UPDATE maintenance_requests
      SET
        status = 'completed',
        completed_at = NOW(),
        completion_notes = $2,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *;
      `,
      [id, String(completion_notes || "").trim() || null]
    );

    if (!upd.rows.length) return res.status(404).json({ error: "Not found" });
    return res.json({ ok: true, message: "Completed", data: upd.rows[0] });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getMaintenanceRequests,
  scheduleMaintenance,
  completeMaintenance,
};
