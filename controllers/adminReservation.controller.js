// backend/controllers/adminReservation.controller.js
"use strict";


const pool = require("../config/database");


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
 * - Plot becomes reserved immediately
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

    // Create reservation, NO payment fields
    const ins = await client.query(
      `
      INSERT INTO plot_reservations (plot_id, user_id, status, notes)
      VALUES ($1, $2, 'pending', $3)
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
 * ✅ Admin list: includes plot + visitor info
 * Note: This returns pr.* so if old payment columns still exist in DB,
 * they may still appear in the JSON, but nothing in this controller uses them.
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
 * ✅ Approve reservation (NO PAYMENT)
 * Rules:
 * - Reservation must be pending
 * - Plot must not be occupied
 * - No other active reservation on same plot
 * - Approving reservation sets status = approved
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

    // 3) Lock plot and ensure not occupied
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

    // 4) Extra safety: no other active reservation on same plot
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

    // 5) Approve reservation
    const upd = await client.query(
      `
      UPDATE plot_reservations
      SET
        status = 'approved',
        notes = COALESCE($2, notes),
        updated_at = NOW()
      WHERE id::text = $1
      RETURNING *;
      `,
      [String(id), notes || null]
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
  rejectReservationAsAdmin,
  cancelReservationAsAdmin,
  approveReservationAsAdmin,
};
