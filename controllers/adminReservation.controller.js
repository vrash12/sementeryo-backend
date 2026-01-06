"use strict";

const pool = require("../config/database");

/**
 * ✅ REQUIRED DB COLUMNS (run once in Postgres)
 *
 * NOTE: This version is "WITHOUT RECEIPT".
 * No payment_receipt_url, no payment_uploaded_at, and no receipt checks.
 *
 * -- If your users.id is UUID, set payment_validated_by/payment_approved_by to UUID instead of TEXT.
 *
 * ALTER TABLE plot_reservations
 *   ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'unpaid',
 *   ADD COLUMN IF NOT EXISTS payment_validated_at TIMESTAMPTZ,
 *   ADD COLUMN IF NOT EXISTS payment_validated_by TEXT,
 *   ADD COLUMN IF NOT EXISTS payment_approved_at TIMESTAMPTZ,
 *   ADD COLUMN IF NOT EXISTS payment_approved_by TEXT,
 *   ADD COLUMN IF NOT EXISTS payment_notes TEXT;
 *
 * -- Optional: keep payment_status clean with a CHECK constraint if you want
 * -- (not required)
 */

function isPrivileged(user) {
  const role = String(user?.role || "").toLowerCase();
  return role === "admin" || role === "staff";
}

function requirePrivileged(req, res) {
  if (!isPrivileged(req.user)) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

/**
 * ✅ Admin creates a reservation (status = pending)
 * - plot becomes reserved immediately (same as your current behavior)
 * - payment_status starts as 'unpaid'
 */
async function reservePlotAsAdmin(req, res, next) {
  const client = await pool.connect();
  try {
    if (!isPrivileged(req.user)) return res.status(403).json({ error: "Forbidden" });

    const { plot_id, visitor_user_id, notes } = req.body || {};
    if (!plot_id) return res.status(400).json({ error: "plot_id is required" });
    if (!visitor_user_id) return res.status(400).json({ error: "visitor_user_id is required" });

    await client.query("BEGIN");

    // Verify visitor user exists and is a visitor
    const v = await client.query(
      `SELECT id, role FROM users WHERE id::text = $1 LIMIT 1`,
      [String(visitor_user_id)]
    );
    if (!v.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Visitor user not found" });
    }
    if (String(v.rows[0].role || "").toLowerCase() !== "visitor") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "visitor_user_id must be a visitor" });
    }

    // Lock plot row
    const p = await client.query(
      `SELECT id, status, plot_name, uid FROM plots WHERE id::text = $1 FOR UPDATE`,
      [String(plot_id)]
    );
    if (!p.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Plot not found" });
    }

    const plot = p.rows[0];
    const plotStatus = String(plot.status || "").toLowerCase();
    if (plotStatus !== "available") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Plot is currently ${plot.status}` });
    }

    // Create reservation
    const ins = await client.query(
      `
      INSERT INTO plot_reservations (plot_id, user_id, status, notes, payment_status)
      VALUES ($1, $2, 'pending', $3, 'unpaid')
      RETURNING *;
      `,
      [String(plot_id), String(visitor_user_id), notes || null]
    );

    // Reserve plot immediately
    await client.query(
      `UPDATE plots SET status = 'reserved', updated_at = NOW() WHERE id::text = $1`,
      [String(plot_id)]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      data: {
        reservation: ins.rows[0],
        plot: { id: plot.id, uid: plot.uid, plot_name: plot.plot_name, status: "reserved" },
      },
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    next(err);
  } finally {
    client.release();
  }
}

/**
 * ✅ Admin list: includes plot + visitor info + payment fields
 */
async function getAllReservations(req, res, next) {
  try {
    if (!isPrivileged(req.user)) return res.status(403).json({ error: "Forbidden" });

    const { rows } = await pool.query(
      `
      SELECT
        pr.*,

        p.uid AS plot_uid,
        p.plot_name,
        p.status AS plot_status,

        (u.first_name || ' ' || u.last_name) AS reserved_for_name,
        u.email AS reserved_for_email

      FROM plot_reservations pr
      LEFT JOIN plots p ON p.id::text = pr.plot_id::text
      LEFT JOIN users u ON u.id::text = pr.user_id::text
      ORDER BY pr.id DESC
      `
    );

    return res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * ✅ Admin marks payment as "validated"
 * No receipt required.
 */
async function validatePaymentAsAdmin(req, res) {
  try {
    if (!requirePrivileged(req, res)) return;

    const { id } = req.params;
    const { payment_notes } = req.body || {};

    if (!id) return res.status(400).json({ success: false, message: "Reservation ID required" });

    const cur = await pool.query(
      `
      SELECT id, status, payment_status
      FROM plot_reservations
      WHERE id::text = $1
      LIMIT 1
      `,
      [String(id)]
    );

    if (!cur.rows.length) {
      return res.status(404).json({ success: false, message: "Reservation not found" });
    }

    const row = cur.rows[0];
    const status = String(row.status || "").toLowerCase();

    if (["rejected", "cancelled", "canceled", "completed"].includes(status)) {
      return res.status(409).json({
        success: false,
        message: `Cannot validate payment: reservation is ${status}.`,
      });
    }

    const validatorId = req.user?.id != null ? String(req.user.id) : null;

    const upd = await pool.query(
      `
      UPDATE plot_reservations
      SET payment_status = 'validated',
          payment_validated_at = NOW(),
          payment_validated_by = $2,
          payment_notes = COALESCE($3, payment_notes),
          updated_at = NOW()
      WHERE id::text = $1
      RETURNING *;
      `,
      [String(id), validatorId, payment_notes || null]
    );

    return res.json({ success: true, message: "Payment validated", data: upd.rows[0] });
  } catch (err) {
    console.error("validatePaymentAsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

/**
 * ✅ Admin marks payment as "approved"
 * No receipt required.
 */
async function approvePaymentAsAdmin(req, res) {
  try {
    if (!requirePrivileged(req, res)) return;

    const { id } = req.params;
    const { payment_notes } = req.body || {};

    if (!id) return res.status(400).json({ success: false, message: "Reservation ID required" });

    const cur = await pool.query(
      `
      SELECT id, status, payment_status
      FROM plot_reservations
      WHERE id::text = $1
      LIMIT 1
      `,
      [String(id)]
    );

    if (!cur.rows.length) {
      return res.status(404).json({ success: false, message: "Reservation not found" });
    }

    const row = cur.rows[0];
    const status = String(row.status || "").toLowerCase();

    if (["rejected", "cancelled", "canceled", "completed"].includes(status)) {
      return res.status(409).json({
        success: false,
        message: `Cannot approve payment: reservation is ${status}.`,
      });
    }

    const approverId = req.user?.id != null ? String(req.user.id) : null;

    const upd = await pool.query(
      `
      UPDATE plot_reservations
      SET payment_status = 'approved',
          payment_approved_at = NOW(),
          payment_approved_by = $2,
          payment_notes = COALESCE($3, payment_notes),
          updated_at = NOW()
      WHERE id::text = $1
      RETURNING *;
      `,
      [String(id), approverId, payment_notes || null]
    );

    return res.json({ success: true, message: "Payment approved", data: upd.rows[0] });
  } catch (err) {
    console.error("approvePaymentAsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function rejectReservationAsAdmin(req, res, next) {
  const client = await pool.connect();
  try {
    if (!isPrivileged(req.user)) return res.status(403).json({ error: "Forbidden" });

    const id = req.params?.id;
    if (!id) return res.status(400).json({ error: "Missing reservation id" });

    await client.query("BEGIN");

    const r = await client.query(
      `SELECT * FROM plot_reservations WHERE id::text = $1 FOR UPDATE`,
      [String(id)]
    );
    if (!r.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Reservation not found" });
    }

    const reservation = r.rows[0];
    const status = String(reservation.status || "").toLowerCase();
    if (status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Reservation is already ${reservation.status}` });
    }

    const p = await client.query(
      `SELECT id, status FROM plots WHERE id::text = $1 FOR UPDATE`,
      [String(reservation.plot_id)]
    );
    if (!p.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Plot not found" });
    }

    const upd = await client.query(
      `
      UPDATE plot_reservations
      SET status = 'rejected', updated_at = NOW()
      WHERE id::text = $1
      RETURNING *;
      `,
      [String(id)]
    );

    const otherActive = await client.query(
      `
      SELECT 1
      FROM plot_reservations
      WHERE plot_id::text = $1
        AND id::text <> $2
        AND status IN ('pending', 'approved')
      LIMIT 1
      `,
      [String(reservation.plot_id), String(id)]
    );

    const plotStatus = String(p.rows[0].status || "").toLowerCase();
    if (!otherActive.rows.length && plotStatus !== "occupied") {
      await client.query(
        `UPDATE plots SET status = 'available', updated_at = NOW() WHERE id::text = $1`,
        [String(reservation.plot_id)]
      );
    }

    await client.query("COMMIT");
    return res.json({ success: true, data: upd.rows[0] });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    next(err);
  } finally {
    client.release();
  }
}

async function cancelReservationAsAdmin(req, res, next) {
  const client = await pool.connect();
  try {
    if (!isPrivileged(req.user)) return res.status(403).json({ error: "Forbidden" });

    const id = req.params?.id;
    if (!id) return res.status(400).json({ error: "Missing reservation id" });

    await client.query("BEGIN");

    const r = await client.query(
      `SELECT * FROM plot_reservations WHERE id::text = $1 FOR UPDATE`,
      [String(id)]
    );
    if (!r.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Reservation not found" });
    }

    const reservation = r.rows[0];
    const status = String(reservation.status || "").toLowerCase();
    if (!["pending", "approved"].includes(status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Cannot cancel ${reservation.status}` });
    }

    const p = await client.query(
      `SELECT id, status FROM plots WHERE id::text = $1 FOR UPDATE`,
      [String(reservation.plot_id)]
    );
    if (!p.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Plot not found" });
    }

    const upd = await client.query(
      `
      UPDATE plot_reservations
      SET status = 'cancelled', updated_at = NOW()
      WHERE id::text = $1
      RETURNING *;
      `,
      [String(id)]
    );

    const otherActive = await client.query(
      `
      SELECT 1
      FROM plot_reservations
      WHERE plot_id::text = $1
        AND id::text <> $2
        AND status IN ('pending', 'approved')
      LIMIT 1
      `,
      [String(reservation.plot_id), String(id)]
    );

    const plotStatus = String(p.rows[0].status || "").toLowerCase();
    if (!otherActive.rows.length && plotStatus !== "occupied") {
      await client.query(
        `UPDATE plots SET status = 'available', updated_at = NOW() WHERE id::text = $1`,
        [String(reservation.plot_id)]
      );
    }

    await client.query("COMMIT");
    return res.json({ success: true, data: upd.rows[0] });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    next(err);
  } finally {
    client.release();
  }
}

/**
 * ✅ Approve reservation (WITHOUT RECEIPT)
 * Rules in this version:
 * - Reservation must be pending
 * - Payment must be validated OR approved (your choice)
 * - Approving reservation sets status=approved and payment_status=approved
 * - Plot stays reserved
 */
async function approveReservationAsAdmin(req, res, next) {
  const client = await pool.connect();
  try {
    if (!isPrivileged(req.user)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const id = req.params?.id;
    if (!id) return res.status(400).json({ error: "Missing reservation id" });

    const { notes } = req.body || {};
    const approverId = req.user?.id != null ? String(req.user.id) : null;

    await client.query("BEGIN");

    // 1) Lock reservation
    const r = await client.query(
      `SELECT * FROM plot_reservations WHERE id::text = $1 FOR UPDATE`,
      [String(id)]
    );
    if (!r.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Reservation not found" });
    }

    const reservation = r.rows[0];

    // 2) Must still be pending
    const status = String(reservation.status || "").toLowerCase();
    if (status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Reservation is already ${reservation.status}` });
    }

    // 3) Payment must be validated (or already approved)
    const payStatus = String(reservation.payment_status || "unpaid").toLowerCase();
    if (!["validated", "approved"].includes(payStatus)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `Payment must be validated first. Current payment_status=${reservation.payment_status || "unpaid"}`,
      });
    }

    // 4) Lock plot and ensure not occupied
    const p = await client.query(
      `SELECT id, status FROM plots WHERE id::text = $1 FOR UPDATE`,
      [String(reservation.plot_id)]
    );
    if (!p.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Plot not found" });
    }

    const plotStatus = String(p.rows[0].status || "").toLowerCase();
    if (plotStatus === "occupied") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Plot is already occupied" });
    }

    // 5) Extra safety: no other active reservation on same plot
    const otherActive = await client.query(
      `
      SELECT 1
      FROM plot_reservations
      WHERE plot_id::text = $1
        AND id::text <> $2
        AND status IN ('pending', 'approved')
      LIMIT 1
      `,
      [String(reservation.plot_id), String(id)]
    );

    if (otherActive.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Another active reservation exists for this plot. Resolve it first.",
      });
    }

    // 6) Approve reservation + approve payment together
    const upd = await client.query(
      `
      UPDATE plot_reservations
      SET
        status = 'approved',
        payment_status = 'approved',
        payment_approved_at = NOW(),
        payment_approved_by = $2,
        notes = COALESCE($3, notes),
        updated_at = NOW()
      WHERE id::text = $1
      RETURNING *;
      `,
      [String(id), approverId, notes || null]
    );

    // Keep plot reserved
    await client.query(
      `UPDATE plots SET status = 'reserved', updated_at = NOW() WHERE id::text = $1`,
      [String(reservation.plot_id)]
    );

    await client.query("COMMIT");
    return res.json({ success: true, data: upd.rows[0] });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    next(err);
  } finally {
    client.release();
  }
}

module.exports = {
  reservePlotAsAdmin,
  getAllReservations,

  // ✅ payment flow (no receipt)
  validatePaymentAsAdmin,
  approvePaymentAsAdmin,

  rejectReservationAsAdmin,
  cancelReservationAsAdmin,
  approveReservationAsAdmin,
};
