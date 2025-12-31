// backend/controllers/admin.controller.js
"use strict";

const pool = require("../config/database");
const fs = require("fs");

/* ---------------- role helpers ---------------- */
function isPrivileged(user) {
  const role = String(user?.role || "").toLowerCase();
  return role === "admin" || role === "staff";
}

/* ---------------- tiny DB helpers (safe optional columns/tables) ---------------- */
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

/* =========================================================================================
   PHOTO UPLOAD HANDLER (multer already placed file in req.file)
   - updates plots.photo_url
========================================================================================= */
async function uploadPlotPhoto(req, res, next) {
  try {
    if (!isPrivileged(req.user))
      return res.status(403).json({ error: "Forbidden" });

    const identifier = req.params?.id;
    if (!identifier)
      return res.status(400).json({ error: "Missing plot identifier." });

    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded (photo)." });

    const hasPhotoUrl = await hasColumn("plots", "photo_url");
    if (!hasPhotoUrl) {
      return res.status(400).json({
        error:
          "plots.photo_url column is missing. Run migration: ALTER TABLE plots ADD COLUMN photo_url TEXT;",
      });
    }

    // We assume you serve /uploads statically from backend
    const photoUrl = `/uploads/plots/${file.filename}`;

    const { rows } = await pool.query(
      `
      UPDATE plots
      SET photo_url = $2,
          updated_at = NOW()
      WHERE id::text = $1 OR uid = $1
      RETURNING id::text AS id, uid, photo_url
      `,
      [String(identifier), photoUrl]
    );

    if (!rows.length) {
      try {
        fs.unlinkSync(file.path);
      } catch {}
      return res.status(404).json({ error: "Plot not found" });
    }

    return res.json({ ok: true, photo_url: rows[0].photo_url, plot: rows[0] });
  } catch (err) {
    next(err);
  }
}

/* ---------------- geometry/date helpers ---------------- */
function parseLatLngFromString(s) {
  if (!s || typeof s !== "string") return null;
  const t = s.trim();

  // "POINT(lng lat)"
  const mPoint = t.match(
    /^POINT\s*\(\s*([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s*\)$/i
  );
  if (mPoint) {
    const lng = Number(mPoint[1]);
    const lat = Number(mPoint[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }

  // "lat lng" or "lat, lng"
  const mPair = t.match(
    /^\s*([+-]?\d+(?:\.\d+)?)\s*,?\s+([+-]?\d+(?:\.\d+)?)\s*$/
  );
  if (mPair) {
    const lat = Number(mPair[1]);
    const lng = Number(mPair[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }

  return null;
}

function genUid5() {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 5; i++)
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function normDate(v) {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, 10) : null;
}

/* =========================================================================================
   PLOTS CRUD (plots, road_plots, building_plots)
========================================================================================= */
function makePlotHandlers(tableName, opts = { includePersonal: false }) {
  const includePersonal = !!opts.includePersonal;

  const isUidTaken = async (uid) => {
    const { rows } = await pool.query(
      `SELECT 1 FROM ${tableName} WHERE uid = $1 LIMIT 1`,
      [uid]
    );
    return rows.length > 0;
  };

  const add = async (req, res, next) => {
    try {
      if (!isPrivileged(req.user))
        return res.status(403).json({ error: "Forbidden" });

      const {
        uid: uidRaw,
        plot_name,
        plot_type,
        size_sqm,
        price,
        status: statusRaw,
        latitude,
        longitude,
        coordinates: coordinatesRaw,

        // personal fields
        person_full_name,
        date_of_birth,
        date_of_death,
        next_of_kin_name,
        contact_phone,
        contact_email,
        notes,

        // optional enhancements
        photo_url,
        qr_token,
      } = req.body || {};

      let latLng = null;
      if (
        latitude != null &&
        longitude != null &&
        String(latitude).trim() !== "" &&
        String(longitude).trim() !== ""
      ) {
        const lat = Number(latitude);
        const lng = Number(longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) latLng = { lat, lng };
      }
      if (
        !latLng &&
        typeof coordinatesRaw === "string" &&
        coordinatesRaw.trim() !== ""
      ) {
        latLng = parseLatLngFromString(coordinatesRaw);
      }

      const status =
        statusRaw && String(statusRaw).trim() !== ""
          ? String(statusRaw).trim()
          : "available";

      let uid = typeof uidRaw === "string" && uidRaw.length === 5 ? uidRaw : null;
      if (uid && (await isUidTaken(uid))) uid = null;

      if (!uid) {
        for (let tries = 0; tries < 10; tries++) {
          const cand = genUid5();
          if (!(await isUidTaken(cand))) {
            uid = cand;
            break;
          }
        }
        if (!uid)
          return res.status(500).json({ error: "Failed to generate uid" });
      }

      const cols = [
        "uid",
        "plot_name",
        "plot_type",
        "size_sqm",
        "status",
        "price",
        "created_at",
        "updated_at",
      ];

      const params = [];
      const addParam = (v) => {
        params.push(v);
        return `$${params.length}`;
      };

      const vals = [
        addParam(uid),
        addParam(plot_name ?? null),
        addParam(plot_type ?? null),
        addParam(size_sqm ?? null),
        addParam(status),
        addParam(price ?? null),
        "NOW()",
        "NOW()",
      ];

      if (includePersonal) {
        cols.push(
          "person_full_name",
          "date_of_birth",
          "date_of_death",
          "next_of_kin_name",
          "contact_phone",
          "contact_email",
          "notes"
        );
        vals.push(
          addParam(String(person_full_name ?? "").trim() || null),
          addParam(normDate(date_of_birth)),
          addParam(normDate(date_of_death)),
          addParam(String(next_of_kin_name ?? "").trim() || null),
          addParam(String(contact_phone ?? "").trim() || null),
          addParam(String(contact_email ?? "").trim() || null),
          addParam(typeof notes === "undefined" ? null : notes)
        );

        if (await hasColumn(tableName, "photo_url")) {
          cols.push("photo_url");
          vals.push(addParam(String(photo_url ?? "").trim() || null));
        }
        if (await hasColumn(tableName, "qr_token")) {
          cols.push("qr_token");
          vals.push(addParam(String(qr_token ?? "").trim() || null));
        }
      }

      if (latLng) {
        cols.push("coordinates");
        const pLng = addParam(Number(latLng.lng));
        const pLat = addParam(Number(latLng.lat));
        vals.push(`ST_SetSRID(ST_MakePoint(${pLng}, ${pLat}), 4326)`);
      }

      const sql = `
        INSERT INTO ${tableName} (${cols.join(", ")})
        VALUES (${vals.join(", ")})
        RETURNING *
      `;

      const { rows } = await pool.query(sql, params);
      return res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  };

  const edit = async (req, res, next) => {
    try {
      if (!isPrivileged(req.user))
        return res.status(403).json({ error: "Forbidden" });

      const id = req.body?.id ?? req.params?.id;
      if (!id) return res.status(400).json({ error: "id is required" });

      const {
        uid,
        plot_name,
        plot_type,
        size_sqm,
        status,
        price,
        latitude,
        longitude,
        coordinates: coordinatesRaw,

        // personal fields
        person_full_name,
        date_of_birth,
        date_of_death,
        next_of_kin_name,
        contact_phone,
        contact_email,
        notes,

        // optional enhancements
        photo_url,
        qr_token,
      } = req.body || {};

      let latLng = null;
      if (
        latitude != null &&
        longitude != null &&
        String(latitude).trim() !== "" &&
        String(longitude).trim() !== ""
      ) {
        const lat = Number(latitude);
        const lng = Number(longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) latLng = { lat, lng };
      }
      if (
        !latLng &&
        typeof coordinatesRaw === "string" &&
        coordinatesRaw.trim() !== ""
      ) {
        latLng = parseLatLngFromString(coordinatesRaw);
      }

      const sets = [];
      const params = [];
      let i = 1;

      const addSet = (col, val) => {
        if (typeof val !== "undefined") {
          sets.push(`${col} = $${i++}`);
          params.push(val);
        }
      };

      addSet("uid", uid);
      addSet("plot_name", plot_name);
      addSet("plot_type", plot_type);
      addSet("size_sqm", size_sqm);
      addSet("status", status);
      addSet("price", price);

      if (includePersonal) {
        if (typeof person_full_name !== "undefined")
          addSet("person_full_name", String(person_full_name ?? "").trim() || null);
        if (typeof date_of_birth !== "undefined")
          addSet("date_of_birth", normDate(date_of_birth));
        if (typeof date_of_death !== "undefined")
          addSet("date_of_death", normDate(date_of_death));
        if (typeof next_of_kin_name !== "undefined")
          addSet("next_of_kin_name", String(next_of_kin_name ?? "").trim() || null);
        if (typeof contact_phone !== "undefined")
          addSet("contact_phone", String(contact_phone ?? "").trim() || null);
        if (typeof contact_email !== "undefined")
          addSet("contact_email", String(contact_email ?? "").trim() || null);
        if (typeof notes !== "undefined") addSet("notes", notes);

        if (await hasColumn(tableName, "photo_url")) {
          if (typeof photo_url !== "undefined") {
            addSet("photo_url", String(photo_url ?? "").trim() || null);
          }
        }
        if (await hasColumn(tableName, "qr_token")) {
          if (typeof qr_token !== "undefined") {
            addSet("qr_token", String(qr_token ?? "").trim() || null);
          }
        }
      }

      if (latLng) {
        sets.push(`coordinates = ST_SetSRID(ST_MakePoint($${i}, $${i + 1}), 4326)`);
        params.push(Number(latLng.lng), Number(latLng.lat));
        i += 2;
      }

      sets.push("updated_at = NOW()");
      if (sets.length === 1)
        return res.status(400).json({ error: "No updatable fields provided" });

      const sql = `UPDATE ${tableName} SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`;
      params.push(id);

      const { rows } = await pool.query(sql, params);
      if (!rows.length) return res.status(404).json({ error: "Not found" });
      return res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  };

  const del = async (req, res, next) => {
    try {
      if (!isPrivileged(req.user))
        return res.status(403).json({ error: "Forbidden" });

      const raw = req.params?.id ?? req.body?.id;
      if (!raw) return res.status(400).json({ error: "id (or uid) is required" });

      const sql = `
        DELETE FROM ${tableName}
        WHERE id::text = $1 OR uid = $1
        RETURNING id, uid, plot_name
      `;

      const { rows } = await pool.query(sql, [String(raw)]);
      if (!rows.length) return res.status(404).json({ error: "Not found" });

      return res.json({
        ok: true,
        deleted_id: rows[0].id,
        deleted_uid: rows[0].uid,
        plot_name: rows[0].plot_name,
      });
    } catch (err) {
      if (err && err.code === "23503") {
        return res.status(409).json({
          error: "Cannot delete: referenced by other records.",
          code: "FK_CONSTRAINT",
        });
      }
      next(err);
    }
  };

  return { add, edit, del };
}

const BPlotsHandlers = makePlotHandlers("plots", { includePersonal: true });
const RoadHandlers = makePlotHandlers("road_plots", { includePersonal: false });
const BuildingHandlers = makePlotHandlers("building_plots", { includePersonal: false });

const addPlots = BPlotsHandlers.add;
const editPlots = BPlotsHandlers.edit;
const deletePlots = BPlotsHandlers.del;

const addRoadPlots = RoadHandlers.add;
const editRoadPlots = RoadHandlers.edit;
const deleteRoadPlots = RoadHandlers.del;

const addBuildingPlots = BuildingHandlers.add;
const editBuildingPlots = BuildingHandlers.edit;
const deleteBuildingPlots = BuildingHandlers.del;

/* =========================================================================================
   GRAVES helpers
========================================================================================= */
async function isGraveUidTaken(uid) {
  const { rows } = await pool.query(`SELECT 1 FROM graves WHERE uid = $1 LIMIT 1`, [uid]);
  return rows.length > 0;
}

async function ensureGraveUid(uidRaw) {
  const u = typeof uidRaw === "string" ? uidRaw.trim() : "";
  if (u && u.length === 5 && !(await isGraveUidTaken(u))) return u;

  for (let tries = 0; tries < 10; tries++) {
    const cand = genUid5();
    if (!(await isGraveUidTaken(cand))) return cand;
  }
  throw new Error("Failed to generate unique grave uid");
}

async function plotHasAnyGrave(client, plotId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM graves WHERE plot_id::text = $1`,
    [String(plotId)]
  );
  return (rows?.[0]?.n ?? 0) > 0;
}

/**
 * ✅ Keep plots table in sync for visitor search UI (person_full_name, date_of_birth, date_of_death)
 * (only updates columns if they exist)
 */
async function updatePlotPersonFields(client, plotId, deceasedName, birthDate, deathDate) {
  const sets = [];
  const params = [String(plotId)];
  let i = 2;

  const pushIf = async (col, val) => {
    if (await hasColumn("plots", col)) {
      sets.push(`${col} = $${i++}`);
      params.push(val);
    }
  };

  await pushIf("person_full_name", String(deceasedName || "").trim() || null);
  await pushIf("date_of_birth", normDate(birthDate));
  await pushIf("date_of_death", normDate(deathDate));

  if (!sets.length) return;

  await client.query(
    `UPDATE plots SET ${sets.join(", ")}, updated_at = NOW() WHERE id::text = $1`,
    params
  );
}

/* =========================================================================================
   ADMIN: Burial Records (graves)
========================================================================================= */
async function getBurialRecords(req, res, next) {
  try {
    if (!isPrivileged(req.user))
      return res.status(403).json({ error: "Forbidden" });

    const limit = req.query?.limit ? Number(req.query.limit) : null;
    const offset = req.query?.offset ? Number(req.query.offset) : null;

    let sql = `
      SELECT
        g.*,
        u.first_name || ' ' || u.last_name AS family_contact_name,
        p.plot_name AS plot_name,
        p.status    AS plot_status,
        p.uid       AS plot_uid
      FROM graves g
      LEFT JOIN users u ON g.family_contact = u.id
      LEFT JOIN plots p ON p.id::text = g.plot_id::text
      ORDER BY g.id DESC
    `;

    const params = [];
    if (Number.isFinite(limit) && limit > 0) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
      if (Number.isFinite(offset) && offset >= 0) {
        params.push(offset);
        sql += ` OFFSET $${params.length}`;
      }
    }

    const { rows } = await pool.query(sql, params);
    return res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function addBurialRecord(req, res, next) {
  const client = await pool.connect();
  try {
    if (!isPrivileged(req.user))
      return res.status(403).json({ error: "Forbidden" });

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

    const plotLock = await client.query(
      `SELECT id, status FROM plots WHERE id::text = $1 FOR UPDATE`,
      [String(plot_id)]
    );

    if (!plotLock.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Plot not found" });
    }

    const currentStatus = String(plotLock.rows[0].status || "").toLowerCase();
    if (currentStatus === "occupied") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Plot is already occupied" });
    }

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
        headstone_type ?? null,
        memorial_text ?? null,
        photo_url ?? null,
        typeof is_active === "boolean" ? is_active : true,
      ]
    );

    await client.query(
      `UPDATE plots SET status = 'occupied', updated_at = NOW() WHERE id::text = $1`,
      [String(plot_id)]
    );

    // ✅ keep plots person fields synced (for visitor search/UI)
    await updatePlotPersonFields(client, plot_id, deceased_name, birth_date, death_date);

    await client.query("COMMIT");
    return res.status(201).json(ins.rows[0]);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    next(err);
  } finally {
    client.release();
  }
}

async function editBurialRecord(req, res, next) {
  const client = await pool.connect();
  try {
    if (!isPrivileged(req.user))
      return res.status(403).json({ error: "Forbidden" });

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

    if (!cur.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Burial record not found" });
    }

    const oldPlotId = cur.rows[0].plot_id;
    const newPlotId = plot_id ? String(plot_id) : null;

    if (newPlotId && String(oldPlotId) !== String(newPlotId)) {
      const lockNew = await client.query(
        `SELECT id, status FROM plots WHERE id::text = $1 FOR UPDATE`,
        [String(newPlotId)]
      );
      if (!lockNew.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "New plot not found" });
      }
      const sNew = String(lockNew.rows[0].status || "").toLowerCase();
      if (sNew === "occupied") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "New plot is already occupied" });
      }

      await client.query(`SELECT id FROM plots WHERE id::text = $1 FOR UPDATE`, [
        String(oldPlotId),
      ]);
    }

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
        newPlotId,
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

    const finalPlotId = updated.rows[0]?.plot_id;

    if (finalPlotId) {
      await client.query(
        `UPDATE plots SET status='occupied', updated_at=NOW() WHERE id::text=$1`,
        [String(finalPlotId)]
      );
    }

    if (oldPlotId && finalPlotId && String(oldPlotId) !== String(finalPlotId)) {
      const stillUsed = await plotHasAnyGrave(client, oldPlotId);
      if (!stillUsed) {
        await client.query(
          `UPDATE plots SET status='available', updated_at=NOW() WHERE id::text=$1`,
          [String(oldPlotId)]
        );
      }
    }

    await client.query("COMMIT");
    return res.json(updated.rows[0]);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    next(err);
  } finally {
    client.release();
  }
}

async function deleteBurialRecord(req, res, next) {
  const client = await pool.connect();
  try {
    if (!isPrivileged(req.user))
      return res.status(403).json({ error: "Forbidden" });

    const identifier = req.params?.id;
    if (!identifier)
      return res.status(400).json({ error: "Missing record identifier." });

    await client.query("BEGIN");

    // find record first to know plot_id for cleanup
    const cur = await client.query(
      `SELECT id, uid, plot_id FROM graves WHERE id::text = $1 OR uid = $1 LIMIT 1`,
      [String(identifier)]
    );
    if (!cur.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Record not found." });
    }

    const plotId = cur.rows[0].plot_id;

    const del = await client.query(
      `DELETE FROM graves WHERE id::text = $1 OR uid = $1 RETURNING *;`,
      [String(identifier)]
    );

    // if that plot no longer has graves, revert plot status to available
    if (plotId) {
      const stillUsed = await plotHasAnyGrave(client, plotId);
      if (!stillUsed) {
        await client.query(
          `UPDATE plots SET status='available', updated_at=NOW() WHERE id::text=$1`,
          [String(plotId)]
        );
      }
    }

    await client.query("COMMIT");
    return res.json({ success: true, deleted: del.rows[0] });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    next(err);
  } finally {
    client.release();
  }
}

/* =========================================================================================
   ✅ ADMIN: Burial Requests -> Confirm -> Create Grave
========================================================================================= */
async function getBurialRequestsAsAdmin(req, res, next) {
  try {
    if (!isPrivileged(req.user)) return res.status(403).json({ error: "Forbidden" });

    if (!(await hasTable("burial_requests"))) {
      return res.json({ success: true, data: [] });
    }

    const hasPlotId = await hasColumn("burial_requests", "plot_id");

    const sql = hasPlotId
      ? `
        SELECT
          br.*,
          u.first_name || ' ' || u.last_name AS family_contact_name,
          u.email AS family_contact_email,
          p.plot_name,
          p.uid AS plot_uid,
          p.status AS plot_status
        FROM burial_requests br
        LEFT JOIN users u ON u.id::text = br.family_contact::text
        LEFT JOIN plots p ON p.id::text = br.plot_id::text
        ORDER BY br.created_at DESC, br.id DESC
      `
      : `
        SELECT
          br.*,
          u.first_name || ' ' || u.last_name AS family_contact_name,
          u.email AS family_contact_email
        FROM burial_requests br
        LEFT JOIN users u ON u.id::text = br.family_contact::text
        ORDER BY br.created_at DESC, br.id DESC
      `;

    const { rows } = await pool.query(sql);
    return res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

async function confirmBurialRequestAsAdmin(req, res, next) {
  const client = await pool.connect();
  try {
    if (!isPrivileged(req.user)) return res.status(403).json({ error: "Forbidden" });

    if (!(await hasTable("burial_requests"))) {
      return res.status(400).json({ error: "burial_requests table is missing." });
    }

    const hasPlotId = await hasColumn("burial_requests", "plot_id");
    if (!hasPlotId) {
      return res.status(400).json({
        error: "burial_requests.plot_id is missing. Please add plot_id column.",
      });
    }

    const id = req.params?.id;
    if (!id) return res.status(400).json({ error: "Missing burial request id." });

    await client.query("BEGIN");

    const brRes = await client.query(
      `SELECT * FROM burial_requests WHERE id::text = $1 FOR UPDATE`,
      [String(id)]
    );
    if (!brRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Burial request not found" });
    }

    const br = brRes.rows[0];
    const brStatus = String(br.status || "").toLowerCase();

    if (["confirmed", "completed"].includes(brStatus)) {
      await client.query("ROLLBACK");
      return res.json({ success: true, message: "Already confirmed", data: br });
    }
    if (["canceled", "cancelled", "rejected"].includes(brStatus)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Cannot confirm a ${brStatus} request.` });
    }

    const plotId = String(br.plot_id || "").trim();
    if (!plotId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Burial request has no plot_id." });
    }

    // lock plot
    const plotLock = await client.query(
      `SELECT id, status FROM plots WHERE id::text = $1 FOR UPDATE`,
      [plotId]
    );
    if (!plotLock.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Plot not found" });
    }

    const plotStatus = String(plotLock.rows[0].status || "").toLowerCase();
    if (plotStatus === "occupied") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Plot is already occupied" });
    }

    // Ensure approved reservation exists (if table exists)
    if (await hasTable("plot_reservations")) {
      const ok = await client.query(
        `
        SELECT 1
        FROM plot_reservations
        WHERE plot_id::text = $1
          AND user_id::text = $2
          AND LOWER(status) = 'approved'
        LIMIT 1
        `,
        [plotId, String(br.family_contact)]
      );

      if (!ok.rows.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "No approved reservation found for this user+plot. Cannot confirm burial.",
        });
      }
    }

    // create grave record
    const graveUid = await ensureGraveUid(null);

    const ins = await client.query(
      `
      INSERT INTO graves
        (uid, plot_id, deceased_name, birth_date, death_date, burial_date,
         family_contact, headstone_type, memorial_text, photo_url, is_active,
         created_at, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,true, NOW(), NOW())
      RETURNING *;
      `,
      [
        graveUid,
        plotId,
        String(br.deceased_name || "").trim(),
        normDate(br.birth_date),
        normDate(br.death_date),
        normDate(br.burial_date),
        br.family_contact ? String(br.family_contact) : null,
      ]
    );

    // occupy plot + sync person fields
    await client.query(
      `UPDATE plots SET status = 'occupied', updated_at = NOW() WHERE id::text = $1`,
      [plotId]
    );
    await updatePlotPersonFields(client, plotId, br.deceased_name, br.birth_date, br.death_date);

    // update burial_request -> confirmed (+ optional columns)
    const sets = [`status = 'confirmed'`, `updated_at = NOW()`];
    const params = [String(id)];
    let i = 2;

    if (await hasColumn("burial_requests", "grave_id")) {
      sets.push(`grave_id = $${i++}`);
      params.push(String(ins.rows[0].id));
    }
    if (await hasColumn("burial_requests", "confirmed_at")) {
      sets.push(`confirmed_at = NOW()`);
    }
    if (await hasColumn("burial_requests", "confirmed_by")) {
      sets.push(`confirmed_by = $${i++}`);
      params.push(String(req.user?.id ?? req.user?.email ?? "admin"));
    }

    const brUpd = await client.query(
      `UPDATE burial_requests SET ${sets.join(", ")} WHERE id::text = $1 RETURNING *`,
      params
    );

    // optional: mark reservation completed
    if (await hasTable("plot_reservations")) {
      const prSets = [`status = 'completed'`];
      if (await hasColumn("plot_reservations", "updated_at")) prSets.push(`updated_at = NOW()`);

      await client.query(
        `
        UPDATE plot_reservations
        SET ${prSets.join(", ")}
        WHERE plot_id::text = $1
          AND user_id::text = $2
          AND LOWER(status) = 'approved'
        `,
        [plotId, String(br.family_contact)]
      );
    }

    await client.query("COMMIT");
    return res.json({
      success: true,
      message: "Burial confirmed. Grave record created.",
      burial_request: brUpd.rows[0],
      grave: ins.rows[0],
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

/* =========================================================================================
   ADMIN: users / metrics / plot details
========================================================================================= */
async function getVisitorUsers(req, res, next) {
  try {
    if (!isPrivileged(req.user))
      return res.status(403).json({ error: "Forbidden" });

    const { rows } = await pool.query(
      `
      SELECT
        id,
        username,
        email,
        first_name,
        last_name,
        phone,
        address,
        is_active,
        role,
        password_str
      FROM users
      WHERE role = $1
      ORDER BY last_name ASC, first_name ASC
      `,
      ["visitor"]
    );
    return res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function dashboardMetrics(req, res, next) {
  try {
    if (!isPrivileged(req.user))
      return res.status(403).json({ error: "Forbidden" });

    // ✅ make burial_schedules optional (avoid crash if table missing)
    const hasBurialSchedules = await hasTable("burial_schedules");

    const pendingBurialsExpr = hasBurialSchedules
      ? `(SELECT COUNT(*) FROM burial_schedules WHERE status = 'pending')`
      : `0`;

    const countsQuery = `
      SELECT
        (SELECT COUNT(*) FROM users WHERE role = 'visitor') AS total_visitors,
        (SELECT COUNT(*) FROM graves) AS total_deceased,
        (SELECT COUNT(*) FROM plots) AS total_plots,
        (SELECT COUNT(*) FROM plots WHERE status = 'available') AS available_plots,
        (SELECT COUNT(*) FROM maintenance_requests WHERE status NOT IN ('completed', 'closed')) AS active_maintenance,
        ${pendingBurialsExpr} AS pending_burials
    `;

    const plotStatsQuery = `
      SELECT status, COUNT(*) as count
      FROM plots
      GROUP BY status
    `;

    // optional upcoming burials
    let upcomingBurials = { rows: [] };
    if (hasBurialSchedules) {
      const hasPlotCode = await hasColumn("plots", "plot_code");
      const plotLabelSql = hasPlotCode
        ? `COALESCE(p.plot_code::text, p.plot_name::text) AS plot_label`
        : `p.plot_name::text AS plot_label`;

      const upcomingBurialsQuery = `
        SELECT
          bs.id,
          bs.deceased_name,
          bs.scheduled_date,
          bs.scheduled_time,
          bs.burial_type,
          bs.status,
          ${plotLabelSql}
        FROM burial_schedules bs
        LEFT JOIN plots p ON bs.plot_id = p.id
        WHERE bs.scheduled_date >= CURRENT_DATE
        ORDER BY bs.scheduled_date ASC, bs.scheduled_time ASC
        LIMIT 5
      `;
      upcomingBurials = await pool.query(upcomingBurialsQuery);
    }

    const recentMaintenanceQuery = `
      SELECT
        mr.id,
        mr.request_type,
        mr.category,
        mr.priority,
        mr.status,
        mr.created_at,
        u.first_name || ' ' || u.last_name as requester_name
      FROM maintenance_requests mr
      LEFT JOIN users u ON mr.requester_id = u.id
      ORDER BY mr.created_at DESC
      LIMIT 5
    `;

    const [counts, plotStats, recentMaintenance] = await Promise.all([
      pool.query(countsQuery),
      pool.query(plotStatsQuery),
      pool.query(recentMaintenanceQuery),
    ]);

    return res.json({
      counts: counts.rows[0],
      plot_stats: plotStats.rows,
      upcoming_burials: upcomingBurials.rows,
      recent_maintenance: recentMaintenance.rows,
    });
  } catch (err) {
    next(err);
  }
}

async function getPlotDetails(req, res, next) {
  try {
    if (!isPrivileged(req.user))
      return res.status(403).json({ error: "Forbidden" });

    const identifier = req.params?.id;
    if (!identifier)
      return res.status(400).json({ error: "Missing plot identifier." });

    const extras = [];
    if (await hasColumn("plots", "photo_url")) extras.push("photo_url");
    if (await hasColumn("plots", "qr_token")) extras.push("qr_token");

    const extraSql = extras.length ? `,\n        ${extras.join(",\n        ")}` : "";

    const { rows } = await pool.query(
      `
      SELECT
        id::text AS id,
        uid,
        plot_name,
        plot_type,
        size_sqm,
        status,
        person_full_name,
        date_of_birth,
        date_of_death,
        next_of_kin_name,
        contact_phone,
        contact_email,
        notes,
        price
        ${extraSql},
        CASE WHEN coordinates IS NULL THEN NULL ELSE ST_Y(ST_PointOnSurface(coordinates::geometry)) END AS lat,
        CASE WHEN coordinates IS NULL THEN NULL ELSE ST_X(ST_PointOnSurface(coordinates::geometry)) END AS lng
      FROM plots
      WHERE id::text = $1 OR uid = $1
      LIMIT 1
      `,
      [String(identifier)]
    );

    if (!rows.length) return res.status(404).json({ error: "Plot not found" });
    return res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  dashboardMetrics,

  addPlots,
  editPlots,
  deletePlots,
  getPlotDetails,

  addRoadPlots,
  editRoadPlots,
  deleteRoadPlots,

  addBuildingPlots,
  editBuildingPlots,
  deleteBuildingPlots,

  // ✅ burial records
  getBurialRecords,
  addBurialRecord,
  editBurialRecord,
  deleteBurialRecord,

  // ✅ burial requests (admin)
  getBurialRequestsAsAdmin,
  confirmBurialRequestAsAdmin,

  // ✅ photo upload
  uploadPlotPhoto,

  // ✅ users
  getVisitorUsers,
};
