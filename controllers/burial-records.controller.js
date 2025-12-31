// backend/controllers/burial-records.controller.js
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

/** simple uid generator for graves */
function genUid(len = 8) {
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
  if (u) return u;

  // generate unique-ish uid
  for (let attempt = 0; attempt < 12; attempt++) {
    const cand = genUid(8);
    // eslint-disable-next-line no-await-in-loop
    if (!(await isGraveUidTaken(cand))) return cand;
  }
  // fallback
  return genUid(12);
}

function normDate(v) {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, 10) : null;
}

/* ============================================================
 * GET burial records (admin list + visitor filtered list)
 * - If you pass :id param OR ?family_contact= it will filter
 * - Otherwise returns all graves
 * - Includes plot fields (plot_name, plot_status, plot_uid)
 * ============================================================ */
async function getBurialRecords(req, res, next) {
  try {
    const familyId = req.params?.id || req.query?.family_contact || null;
    const limit = req.query?.limit ? Number(req.query.limit) : null;
    const offset = req.query?.offset ? Number(req.query.offset) : null;

    // ✅ always log when endpoint is hit
    log(
      `getBurialRecords HIT :: user=${req.user?.id ?? "anon"} role=${req.user?.role ?? "none"} :: familyId=${
        familyId ?? "none"
      } :: query=`,
      req.query
    );

    if (DEBUG_BURIAL) {
      const c1 = await pool.query(`SELECT COUNT(*)::int AS n FROM graves`);
      const c2 = await pool.query(`SELECT COUNT(*)::int AS n FROM plots`);
      logDebug("graves count =", c1.rows?.[0]?.n);
      logDebug("plots  count =", c2.rows?.[0]?.n);

      const sample = await pool.query(
        `SELECT id, uid, plot_id, deceased_name FROM graves ORDER BY id DESC LIMIT 5`
      );
      logDebug("graves sample =", sample.rows);
    }

    let sql = `
      SELECT
        g.*,

        u.first_name || ' ' || u.last_name AS family_contact_name,

        p.plot_name AS plot_name,
        p.status    AS plot_status,
        p.uid       AS plot_uid

      FROM graves g
      LEFT JOIN users u ON g.family_contact = u.id

      -- ✅ IMPORTANT: cast to text so join matches even if types differ
      LEFT JOIN plots p ON p.id::text = g.plot_id::text
    `;

    const params = [];

    if (familyId) {
      params.push(String(familyId));
      // ✅ cast both sides to text so filter works even if types differ
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

    if (DEBUG_BURIAL) {
      const preview = rows.slice(0, 8).map((r) => ({
        id: r.id,
        uid: r.uid,
        plot_id: r.plot_id,
        plot_name: r.plot_name,
        plot_status: r.plot_status,
        deceased_name: r.deceased_name ? String(r.deceased_name).slice(0, 40) : null,
      }));
      logDebug("preview =", preview);

      const missingPlot = rows.filter((r) => !r.plot_name && !r.plot_status).length;
      logDebug("missing plot join rows =", missingPlot);
    }

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

    // lock plot to avoid race
    const plotLock = await client.query(
      `SELECT id, status, plot_name FROM plots WHERE id::text = $1 FOR UPDATE`,
      [String(plot_id)]
    );
    logDebug("plot lock =", plotLock.rows);

    // insert grave
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

    // mark plot occupied
    await client.query(
      `UPDATE plots SET status = 'occupied', updated_at = NOW() WHERE id::text = $1`,
      [String(plot_id)]
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
 * - Updates graves
 * - If plot_id changes, occupy new plot
 * - Optionally frees old plot if it has no more graves
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

    // find current record
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

    // occupy new plot
    if (newPlotId) {
      await client.query(
        `UPDATE plots SET status='occupied', updated_at=NOW() WHERE id::text=$1`,
        [String(newPlotId)]
      );
    }

    // free old plot if it changed and no other graves use it
    if (oldPlotId && newPlotId && String(oldPlotId) !== String(newPlotId)) {
      const check = await client.query(
        `SELECT COUNT(*)::int AS n FROM graves WHERE plot_id::text = $1`,
        [String(oldPlotId)]
      );
      if ((check.rows?.[0]?.n ?? 0) === 0) {
        await client.query(
          `UPDATE plots SET status='available', updated_at=NOW() WHERE id::text=$1`,
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
 * - Deletes grave by id or uid (based on param)
 * - Optionally frees plot if no other graves exist for that plot
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

    // get plot_id first
    const cur = await client.query(
      `SELECT id, uid, plot_id FROM graves WHERE id::text=$1 OR uid=$1 LIMIT 1`,
      [String(identifier)]
    );
    if (cur.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Record not found." });
    }

    const plotId = cur.rows[0].plot_id;

    // delete
    const del = await client.query(
      `DELETE FROM graves WHERE id::text=$1 OR uid=$1 RETURNING *`,
      [String(identifier)]
    );

    // free plot if no more graves
    if (plotId) {
      const check = await client.query(
        `SELECT COUNT(*)::int AS n FROM graves WHERE plot_id::text = $1`,
        [String(plotId)]
      );
      if ((check.rows?.[0]?.n ?? 0) === 0) {
        await client.query(
          `UPDATE plots SET status='available', updated_at=NOW() WHERE id::text=$1`,
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
