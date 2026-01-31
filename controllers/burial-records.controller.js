// backend/controllers/burial-records.controller.js
"use strict";

const pool = require("../config/database");

/**
 * Enable extra debug logs:
 *   DEBUG_BURIAL=1 npm run dev
 */
const DEBUG_BURIAL = process.env.DEBUG_BURIAL === "1";

function log(...args) {
  console.log("[BURIAL]", ...args);
}
function logDebug(...args) {
  if (DEBUG_BURIAL) console.log("[BURIAL DEBUG]", ...args);
}

/** simple uid generator for graves (MUST fit CHAR(5) if schema uses that) */
function genUid(len = 5) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function isGraveUidTaken(uid) {
  const { rows } = await pool.query(`SELECT 1 FROM graves WHERE uid = $1 LIMIT 1`, [uid]);
  return rows.length > 0;
}

async function ensureGraveUid(provided) {
  const u = typeof provided === "string" ? provided.trim() : "";

  // Only accept provided if it looks like a 5-char uid (avoids CHAR(5) errors)
  if (u && u.length === 5) return u;

  // generate unique-ish uid (5 chars)
  for (let attempt = 0; attempt < 20; attempt++) {
    const cand = genUid(5);
    // eslint-disable-next-line no-await-in-loop
    if (!(await isGraveUidTaken(cand))) return cand;
  }

  // fallback
  return genUid(5);
}

function normDate(v) {
  if (v === null || typeof v === "undefined") return null;

  // If node-postgres returned a JS Date (common for timestamp/date columns)
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const yyyy = v.getFullYear();
    const mm = String(v.getMonth() + 1).padStart(2, "0");
    const dd = String(v.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  const s = String(v).trim();
  if (!s) return null;

  // If already ISO-ish, keep date part
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // Last resort: parse and format
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/* ============================================================
 * GET burial records
 * - optional filter by family_contact (param or query)
 * - includes plot fields even if graves.plot_id stores plot uid
 * ============================================================ */
async function getBurialRecords(req, res, next) {
  try {
    const familyId = req.params?.id || req.query?.family_contact || null;
    const limit = req.query?.limit ? Number(req.query.limit) : null;
    const offset = req.query?.offset ? Number(req.query.offset) : null;

    log(
      `getBurialRecords HIT :: user=${req.user?.id ?? "anon"} role=${req.user?.role ?? "none"} :: familyId=${
        familyId ?? "none"
      } :: query=`,
      req.query
    );

    let sql = `
      SELECT
        g.*,
        u.first_name || ' ' || u.last_name AS family_contact_name,

        p.plot_name AS plot_name,
        p.status    AS plot_status,
        p.uid       AS plot_uid

      FROM graves g
      LEFT JOIN users u ON g.family_contact = u.id

      -- ✅ join supports either plots.id OR plots.uid stored in graves.plot_id
      LEFT JOIN plots p
        ON (p.id::text = g.plot_id::text OR p.uid::text = g.plot_id::text)
    `;

    const params = [];

    if (familyId) {
      params.push(String(familyId));
      sql += ` WHERE g.family_contact::text = $${params.length}`;
    }

    sql += ` ORDER BY g.id DESC`;

    if (Number.isFinite(limit) && limit > 0) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
      if (Number.isFinite(offset) && offset >= 0) {
        params.push(offset);
        sql += ` OFFSET $${params.length}`;
      }
    }

    logDebug("SQL =", sql.trim());
    logDebug("PARAMS =", params);

    const { rows } = await pool.query(sql, params);

    log(`getBurialRecords OK :: rows=${rows.length}`);
    return res.json(rows);
  } catch (err) {
    console.error("[BURIAL] getBurialRecords ERROR:", err);
    next(err);
  }
}

/* ============================================================
 * ADD burial record (admin)
 * - Inserts into graves
 * - Sets plot.status = 'occupied'
 * ============================================================ */
async function addBurialRecord(req, res, next) {
  const client = await pool.connect();
  try {
    const actor = req.user;
    if (!actor || String(actor.role).toLowerCase() !== "admin") {
      return res.status(403).json({ error: "Forbidden: admin only" });
    }

    log("addBurialRecord HIT body=", req.body);

    const {
      uid,
      plot_id,
      deceased_name,
      birth_date,
      death_date,
      burial_date,
      family_contact,
      headstone_type,
      memorial_text,
      photo_url,
      is_active,
    } = req.body || {};

    if (!plot_id || !String(deceased_name || "").trim()) {
      return res.status(400).json({ error: "plot_id and deceased_name are required" });
    }

    const graveUid = await ensureGraveUid(uid);

    await client.query("BEGIN");

    // ✅ lock plot using id OR uid
    const plotLock = await client.query(
      `SELECT id, uid, status, plot_name FROM plots WHERE id::text = $1 OR uid::text = $1 FOR UPDATE`,
      [String(plot_id)]
    );
    if (!plotLock.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Plot not found" });
    }

    const plotRow = plotLock.rows[0];

    // insert grave (store plot reference as given)
    const ins = await client.query(
      `
      INSERT INTO graves
        (uid, plot_id, deceased_name, birth_date, death_date, burial_date,
         family_contact, headstone_type, memorial_text, photo_url, is_active,
         created_at, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW(), NOW())
      RETURNING *;
      `,
      [
        graveUid,
        String(plot_id),
        String(deceased_name).trim(),
        normDate(birth_date),
        normDate(death_date),
        normDate(burial_date),
        family_contact ? String(family_contact) : null,
        headstone_type || null,
        memorial_text || null,
        photo_url || null,
        typeof is_active === "boolean" ? is_active : true,
      ]
    );

    // ✅ mark plot occupied by REAL numeric id (safest)
    await client.query(
      `UPDATE plots SET status = 'occupied', updated_at = NOW() WHERE id = $1`,
      [plotRow.id]
    );

    await client.query("COMMIT");

    log("addBurialRecord OK inserted id=", ins.rows?.[0]?.id);
    return res.status(201).json(ins.rows[0]);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("[BURIAL] addBurialRecord ERROR:", err);
    next(err);
  } finally {
    client.release();
  }
}

/* ============================================================
 * EDIT burial record (admin)
 * ============================================================ */
async function editBurialRecord(req, res, next) {
  const client = await pool.connect();
  try {
    const actor = req.user;
    if (!actor || String(actor.role).toLowerCase() !== "admin") {
      return res.status(403).json({ error: "Forbidden: admin only" });
    }

    log("editBurialRecord HIT body=", req.body);

    const {
      id,
      uid,
      plot_id,
      deceased_name,
      birth_date,
      death_date,
      burial_date,
      family_contact,
      headstone_type,
      memorial_text,
      photo_url,
      is_active,
    } = req.body || {};

    const identifier = id || uid;
    if (!identifier) return res.status(400).json({ error: "id or uid is required" });

    await client.query("BEGIN");

    const cur = await client.query(
      `SELECT id, uid, plot_id FROM graves WHERE id::text = $1 OR uid = $1 LIMIT 1`,
      [String(identifier)]
    );
    if (cur.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Burial record not found" });
    }

    const oldPlotId = cur.rows[0].plot_id;

    const updated = await client.query(
      `
      UPDATE graves SET
        plot_id        = COALESCE($2, plot_id),
        deceased_name  = COALESCE($3, deceased_name),
        birth_date     = COALESCE($4, birth_date),
        death_date     = COALESCE($5, death_date),
        burial_date    = COALESCE($6, burial_date),
        family_contact = COALESCE($7, family_contact),
        headstone_type = COALESCE($8, headstone_type),
        memorial_text  = COALESCE($9, memorial_text),
        photo_url      = COALESCE($10, photo_url),
        is_active      = COALESCE($11, is_active),
        updated_at     = NOW()
      WHERE id::text = $1 OR uid = $1
      RETURNING *;
      `,
      [
        String(identifier),
        plot_id ? String(plot_id) : null,
        deceased_name ? String(deceased_name).trim() : null,
        birth_date ? normDate(birth_date) : null,
        death_date ? normDate(death_date) : null,
        burial_date ? normDate(burial_date) : null,
        family_contact ? String(family_contact) : null,
        typeof headstone_type === "string" ? headstone_type : null,
        typeof memorial_text === "string" ? memorial_text : null,
        typeof photo_url === "string" ? photo_url : null,
        typeof is_active === "boolean" ? is_active : null,
      ]
    );

    const newPlotId = updated.rows[0]?.plot_id;

    // occupy new plot (id OR uid supported)
    if (newPlotId) {
      await client.query(
        `UPDATE plots SET status='occupied', updated_at=NOW() WHERE id::text=$1 OR uid::text=$1`,
        [String(newPlotId)]
      );
    }

    // free old plot if changed and no other graves use it
    if (oldPlotId && newPlotId && String(oldPlotId) !== String(newPlotId)) {
      const check = await client.query(
        `SELECT COUNT(*)::int AS n FROM graves WHERE plot_id::text = $1`,
        [String(oldPlotId)]
      );
      if ((check.rows?.[0]?.n ?? 0) === 0) {
        await client.query(
          `UPDATE plots SET status='available', updated_at=NOW() WHERE id::text=$1 OR uid::text=$1`,
          [String(oldPlotId)]
        );
      }
    }

    await client.query("COMMIT");

    log("editBurialRecord OK id=", updated.rows?.[0]?.id);
    return res.json(updated.rows[0]);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("[BURIAL] editBurialRecord ERROR:", err);
    next(err);
  } finally {
    client.release();
  }
}

/* ============================================================
 * DELETE burial record (admin)
 * ============================================================ */
async function deleteBurialRecord(req, res, next) {
  const client = await pool.connect();
  try {
    const actor = req.user;
    if (!actor || String(actor.role).toLowerCase() !== "admin") {
      return res.status(403).json({ error: "Forbidden: admin only" });
    }

    const identifier = req.params?.id;
    if (!identifier) return res.status(400).json({ error: "Missing record identifier." });

    log("deleteBurialRecord HIT identifier=", identifier);

    await client.query("BEGIN");

    const cur = await client.query(
      `SELECT id, uid, plot_id FROM graves WHERE id::text=$1 OR uid=$1 LIMIT 1`,
      [String(identifier)]
    );
    if (cur.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Record not found." });
    }

    const plotId = cur.rows[0].plot_id;

    const del = await client.query(
      `DELETE FROM graves WHERE id::text=$1 OR uid=$1 RETURNING *`,
      [String(identifier)]
    );

    if (plotId) {
      const check = await client.query(
        `SELECT COUNT(*)::int AS n FROM graves WHERE plot_id::text = $1`,
        [String(plotId)]
      );
      if ((check.rows?.[0]?.n ?? 0) === 0) {
        await client.query(
          `UPDATE plots SET status='available', updated_at=NOW() WHERE id::text=$1 OR uid::text=$1`,
          [String(plotId)]
        );
      }
    }

    await client.query("COMMIT");

    log("deleteBurialRecord OK deleted id=", del.rows?.[0]?.id);
    return res.json({ success: true, deleted: del.rows[0] });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("[BURIAL] deleteBurialRecord ERROR:", err);
    next(err);
  } finally {
    client.release();
  }
}

module.exports = {
  getBurialRecords,
  addBurialRecord,
  editBurialRecord,
  deleteBurialRecord,
};
