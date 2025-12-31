// backend/controllers/staff.controller.js
const pool = require('../config/database');

/**
 * GET /staff/get-all-tickets
 * Optional query params:
 *   - type: "burial" | "maintenance" | "all"
 *   - status: "Pending" | "Approved" | "Canceled" | "all"
 *
 * Returns a unified list of tickets with consistent fields:
 * id, type, deceased_name, family_contact (user.id), family_contact_name, status, created_at,
 * birth_date, death_date, burial_date (dates may be null for maintenance)
 */

async function getAllTickets(req, res) {
  try {
    const { type = 'all', status = 'all' } = req.query;

    const where = [];
    const params = [];

    if (type !== 'all') {
      where.push('t.type = $' + (params.length + 1));
      params.push(type);
    }
    if (status !== 'all') {
      where.push('t.status = $' + (params.length + 1));
      params.push(status);
    }

    const sql = `
      SELECT *
      FROM (
        SELECT
          br.id,
          'burial'       AS type,
          br.deceased_name,
          br.family_contact,
          CONCAT(u.first_name, ' ', u.last_name) AS family_contact_name,
          br.status,
          br.created_at,
          br.birth_date,
          br.death_date,
          br.burial_date
        FROM burial_requests br
        LEFT JOIN users u ON u.id = br.family_contact

        UNION ALL

        SELECT
          mr.id,
          'maintenance'  AS type,
          mr.deceased_name,
          mr.family_contact,
          CONCAT(u.first_name, ' ', u.last_name) AS family_contact_name,
          mr.status,
          mr.created_at,
          NULL AS birth_date,
          NULL AS death_date,
          NULL AS burial_date
        FROM maintenance_requests mr
        LEFT JOIN users u ON u.id = mr.family_contact
      ) AS t
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY
        CASE t.status
          WHEN 'Pending'  THEN 0
          WHEN 'Approved' THEN 1
          WHEN 'Canceled' THEN 2
          ELSE 3
        END,
        t.created_at DESC
    `;

    const result = await pool.query(sql, params);
    const rows = Array.isArray(result) ? result[0] ?? result : result.rows ?? [];

    return res.json(rows);
  } catch (err) {
    console.error('[staff.controller] getAllTickets error:', err);
    return res.status(500).json({ message: 'Failed to fetch tickets' });
  }
}

async function changeTicketStatus(req, res) {
  try {
    const { id } = req.params;
    let { status, type } = req.body || {};

    if (!id) return res.status(400).json({ message: 'id is required' });
    if (!status) return res.status(400).json({ message: 'status is required' });

    // Normalize to lowercase and map "cancelled" -> "canceled"
    let normalized = String(status).toLowerCase();
    if (normalized === 'cancelled') normalized = 'canceled';

    if (!['pending', 'approved', 'canceled'].includes(normalized)) {
      return res.status(400).json({ message: 'Invalid status value' });
    }

    const updateOne = async (table) => {
      const sql = `
        UPDATE ${table}
           SET status = $1
         WHERE id = $2
     RETURNING id, deceased_name, family_contact, status, created_at,
               ${table === 'burial_requests'
                 ? 'birth_date, death_date, burial_date,'
                 : 'NULL AS birth_date, NULL AS death_date, NULL AS burial_date,'}
               '${table === 'burial_requests' ? 'burial' : 'maintenance'}'::text AS type
      `;
      const { rows } = await pool.query(sql, [normalized, id]);
      return rows?.[0] || null;
    };

    let updated = null;

    if (type === 'burial' || type === 'maintenance') {
      const table = type === 'burial' ? 'burial_requests' : 'maintenance_requests';
      updated = await updateOne(table);
    } else {
      // Unknown type: try burial first, then maintenance
      updated = await updateOne('burial_requests');
      if (!updated) updated = await updateOne('maintenance_requests');
    }

    if (!updated) return res.status(404).json({ message: 'Ticket not found' });

    // Attach requester name for UI
    const userSql = `SELECT CONCAT(first_name, ' ', last_name) AS family_contact_name FROM users WHERE id = $1`;
    const { rows: userRows } = await pool.query(userSql, [updated.family_contact]);
    updated.family_contact_name = userRows?.[0]?.family_contact_name ?? null;

    return res.json(updated);
  } catch (err) {
    console.error('[staff.controller] changeTicketStatus error:', err);
    return res.status(500).json({ message: 'Failed to change status' });
  }
}

async function getBurialSchedules(req, res) {
  try {
    const sql = `
      SELECT
        bs.id,
        bs.uid,
        bs.deceased_name,
        bs.family_contact,
        bs.birth_date,
        bs.death_date,
        bs.burial_date,
        bs.status,
        bs.approved_by,
        CONCAT(u.first_name, ' ', u.last_name) AS approved_by_name, -- ✅ full name
        bs.special_requirements,
        bs.memorial_text,
        bs.created_at,
        bs.updated_at,
        p.id        AS plot_id,
        p.plot_name AS plot_name
      FROM burial_schedules bs
      LEFT JOIN plots p
        ON p.id = bs.plot_id
      LEFT JOIN users u
        ON u.id = bs.approved_by          -- ✅ join with users
      ORDER BY
        CASE bs.status
          WHEN 'Pending'  THEN 0
          WHEN 'Approved' THEN 1
          WHEN 'Canceled' THEN 2
          ELSE 3
        END,
        bs.created_at DESC
    `;

    const { rows } = await pool.query(sql);
    return res.json(rows ?? []);
  } catch (err) {
    console.error('[staff.controller] getBurialSchedules error:', err);
    return res.status(500).json({ message: 'Failed to fetch burial schedules' });
  }
}


async function getAvailablePlots(req, res) {
  try {
    const sql = `
      SELECT p.id, p.plot_name
      FROM plots p
      LEFT JOIN graves g
        ON g.plot_id = p.id
      WHERE g.plot_id IS NULL
      ORDER BY p.plot_name ASC
    `;
    const { rows } = await pool.query(sql);
    return res.json(rows ?? []);
  } catch (err) {
    console.error('[staff.controller] getAvailablePlots error:', err);
    return res.status(500).json({ message: 'Failed to fetch available plots' });
  }
}


// ------------------------ helpers: common SELECT ------------------------
const SCHEDULE_SELECT = `
  SELECT
    bs.id,
    bs.uid,
    bs.deceased_name,
    bs.family_contact,
    CONCAT(u2.first_name, ' ', u2.last_name) AS family_contact_name,
    bs.birth_date,
    bs.death_date,
    bs.burial_date,
    bs.status,
    bs.approved_by,
    CONCAT(u1.first_name, ' ', u1.last_name) AS approved_by_name,
    bs.special_requirements,
    bs.memorial_text,
    bs.created_at,
    bs.updated_at,
    p.id        AS plot_id,
    p.plot_name AS plot_name
  FROM burial_schedules bs
  LEFT JOIN plots p      ON p.id  = bs.plot_id
  LEFT JOIN users u1     ON u1.id = bs.approved_by
  LEFT JOIN users u2     ON u2.id = bs.family_contact
`;

async function selectScheduleById(id) {
  const sql = `${SCHEDULE_SELECT} WHERE bs.id = $1`;
  const { rows } = await pool.query(sql, [id]);
  return rows?.[0] || null;
}

// ------------------------ CREATE ------------------------
/**
 * POST /staff/burial-schedules
 * Body:
 *   deceased_name, plot_id, family_contact, birth_date?, death_date?, burial_date?, 
 *   approved_by (user.id), special_requirements?, memorial_text?
 * Status defaults to "Confirmed".
 */

/* ---------- helpers copied from admin (and small utils) ---------- */
// --- helpers ---
function genUid() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 5; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
function clean(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined));
}
function buildQrPayload(snapshot) {
  return JSON.stringify(
    clean({
      _type: "burial_record",
      id: snapshot.id,
      uid: snapshot.uid,
      plot_id: snapshot.plot_id,
      deceased_name: snapshot.deceased_name,
      birth_date: snapshot.birth_date,
      death_date: snapshot.death_date,
      burial_date: snapshot.burial_date,
      family_contact: snapshot.family_contact,
      headstone_type: snapshot.headstone_type,
      memorial_text: snapshot.memorial_text,
      is_active: snapshot.is_active,
      lat: snapshot.lat,
      lng: snapshot.lng,
      created_at: snapshot.created_at,
      updated_at: snapshot.updated_at,
    })
  );
}

async function getPlotLatLng(plotId) {
  if (!plotId) return { lat: null, lng: null };
  const { rows } = await pool.query(
    `
    SELECT
      COALESCE(ST_Y(coordinates::geometry), NULL) AS lat,
      COALESCE(ST_X(coordinates::geometry), NULL) AS lng
    FROM plots
    WHERE id = $1
    LIMIT 1
    `,
    [plotId]
  );
  return rows.length ? { lat: rows[0].lat ?? null, lng: rows[0].lng ?? null } : { lat: null, lng: null };
}

// ---------- POST /staff/burial-schedules ----------
async function createBurialSchedule(req, res) {
  const client = await pool.connect();
  try {
    const {
      deceased_name,
      plot_id,
      family_contact,
      birth_date,
      death_date,
      burial_date,
      approved_by,
      special_requirements,
      memorial_text,
    } = req.body || {};

    if (!deceased_name)  return res.status(400).json({ message: "deceased_name is required" });
    if (!plot_id)        return res.status(400).json({ message: "plot_id is required" });
    if (!family_contact) return res.status(400).json({ message: "family_contact is required" });
    if (!approved_by)    return res.status(400).json({ message: "approved_by is required" });

    await client.query("BEGIN");

    // 1) set plot occupied + get lat/lng
    const { rows: plotRows } = await client.query(
      `
      UPDATE plots
         SET status = 'occupied', updated_at = NOW()
       WHERE id = $1
       RETURNING id,
                 COALESCE(ST_Y(coordinates::geometry), NULL) AS lat,
                 COALESCE(ST_X(coordinates::geometry), NULL) AS lng
      `,
      [plot_id]
    );
    if (plotRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Plot not found" });
    }
    const { lat, lng } = plotRows[0];

    // 2) insert schedule (DATE casts!)
    const { rows: schedRows } = await client.query(
      `
      INSERT INTO burial_schedules
        (deceased_name, plot_id, family_contact, birth_date, death_date, burial_date,
         status, approved_by, special_requirements, memorial_text, created_at, updated_at)
      VALUES
        (
          $1,
          $2,
          $3,
          NULLIF($4::text,'')::date,
          NULLIF($5::text,'')::date,
          NULLIF($6::text,'')::date,
          'Confirmed',
          $7,
          $8,
          $9,
          NOW(),
          NOW()
        )
      RETURNING *
      `,
      [
        deceased_name,
        plot_id,
        family_contact,
        birth_date ?? null,
        death_date ?? null,
        burial_date ?? null,
        approved_by,
        special_requirements ?? null,
        memorial_text ?? null,
      ]
    );
    const schedule = schedRows[0];

    // 3) unique 5-char uid for graves
    const uidTaken = async (u) => {
      const { rows } = await client.query(`SELECT 1 FROM graves WHERE uid = $1 LIMIT 1`, [u]);
      return rows.length > 0;
    };
    let uid = null;
    for (let i = 0; i < 12; i++) {
      const cand = genUid();
      if (!(await uidTaken(cand))) { uid = cand; break; }
    }
    if (!uid) {
      await client.query("ROLLBACK");
      return res.status(500).json({ message: "Failed to generate unique uid" });
    }

    // 4) insert grave (DATE casts!) + QR
    const nowIso = new Date().toISOString();
    const snapshot = {
      id: undefined,
      uid,
      plot_id,
      deceased_name,
      birth_date: birth_date || null,
      death_date: death_date || null,
      burial_date: burial_date || null,
      family_contact: family_contact || null,
      headstone_type: "flat",
      memorial_text: memorial_text || null,
      is_active: true,
      lat, lng,
      created_at: nowIso,
      updated_at: nowIso,
    };
    let qr_token = buildQrPayload(snapshot);

    const { rows: graveRows } = await client.query(
      `
      INSERT INTO graves
        (uid, plot_id, deceased_name, birth_date, death_date, burial_date,
         family_contact, headstone_type, memorial_text, qr_token, is_active,
         created_at, updated_at)
      VALUES
        (
          $1,
          $2,
          $3,
          NULLIF($4::text,'')::date,
          NULLIF($5::text,'')::date,
          NULLIF($6::text,'')::date,
          $7,
          $8,
          $9,
          $10,
          TRUE,
          NOW(),
          NOW()
        )
      RETURNING *
      `,
      [
        uid,
        plot_id,
        deceased_name,
        birth_date ?? null,
        death_date ?? null,
        burial_date ?? null,
        family_contact ?? null,
        "flat",
        memorial_text ?? null,
        qr_token,
      ]
    );
    const grave = graveRows[0];

    // include real grave id in QR (optional refresh)
    snapshot.id = grave.id;
    qr_token = buildQrPayload(snapshot);
    await client.query(`UPDATE graves SET qr_token = $1 WHERE id = $2`, [qr_token, grave.id]);

    await client.query("COMMIT");
    return res.status(201).json({
      schedule,
      grave: { ...grave, qr_token },
      message: "Burial schedule and grave created; plot marked occupied",
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[staff.controller] createBurialSchedule error:", err);
    return res.status(500).json({ message: "Failed to create burial schedule" });
  } finally {
    client.release();
  }
}


// ------------------------ UPDATE ------------------------
/**
 * PUT /staff/burial-schedules/:id
 * Body: any editable fields; status is optional (frontend currently not sending)
 */
async function updateBurialSchedule(req, res) {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: "id is required" });

    const body = req.body || {};

    // Build dynamic SETs for the schedule, with proper DATE casts
    const castDate = (paramIndex) => `NULLIF($${paramIndex}::text,'')::date`;
    const sets = [];
    const params = [];
    const add = (sqlFrag, val, cast = false) => {
      if (val !== undefined) {
        sets.push(sqlFrag.replace("?", cast ? castDate(params.length + 1) : `$${params.length + 1}`));
        params.push(val);
      }
    };

    add("deceased_name = ?", body.deceased_name);
    add("plot_id = ?", body.plot_id);
    add("family_contact = ?", body.family_contact);
    add("birth_date = ?", body.birth_date, true);
    add("death_date = ?", body.death_date, true);
    add("burial_date = ?", body.burial_date, true);
    if (body.status !== undefined) {
      const s = String(body.status).toLowerCase();
      add("status = ?", s === "completed" ? "Completed" : "Confirmed");
    }
    add("approved_by = ?", body.approved_by);
    add("special_requirements = ?", body.special_requirements);
    add("memorial_text = ?", body.memorial_text);

    if (sets.length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    // Run everything in a TX because we also touch "graves"
    await client.query("BEGIN");

    // 1) Update schedule
    params.push(id);
    const upSql = `
      UPDATE burial_schedules
         SET ${sets.join(", ")},
             updated_at = NOW()
       WHERE id = $${params.length}
      RETURNING id
    `;
    const { rows: upRows } = await client.query(upSql, params);
    if (!upRows?.[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Schedule not found" });
    }

    // 2) Get full, joined schedule (includes plot_id, uid, etc.)
    const updated = await (async () => {
      const sql = `
        SELECT
          bs.*,
          p.plot_name,
          p.id AS plot_id
        FROM burial_schedules bs
        LEFT JOIN plots p ON p.id = bs.plot_id
        WHERE bs.id = $1
        LIMIT 1
      `;
      const { rows } = await client.query(sql, [upRows[0].id]);
      return rows?.[0] ?? null;
    })();

    // 3) Find the matching grave row:
    //    Prefer matching by shared uid (if schedules table has uid);
    //    fallback to (plot_id, deceased_name)
    const { rows: graveFind } = await client.query(
      `
      SELECT *
      FROM graves
      WHERE
        ($1::text IS NOT NULL AND uid = $1::text)
        OR (plot_id = $2 AND deceased_name = $3)
      ORDER BY id DESC
      LIMIT 1
      `,
      [updated?.uid ?? null, updated?.plot_id ?? null, updated?.deceased_name ?? null]
    );

    let grave = graveFind?.[0] ?? null;

    if (grave) {
      // 4) Mirror fields from schedule → graves (with DATE casts), rebuild QR
      const gSets = [];
      const gParams = [];
      const gAdd = (frag, val, cast = false) => {
        if (val !== undefined) {
          gSets.push(frag.replace("?", cast ? `NULLIF($${gParams.length + 1}::text,'')::date` : `$${gParams.length + 1}`));
          gParams.push(val);
        }
      };

      // Mirror most fields; keep existing headstone_type/is_active unless provided
      gAdd("plot_id = ?", updated.plot_id);
      gAdd("deceased_name = ?", updated.deceased_name);
      gAdd("birth_date = ?", body.birth_date ?? updated.birth_date, true);
      gAdd("death_date = ?", body.death_date ?? updated.death_date, true);
      gAdd("burial_date = ?", body.burial_date ?? updated.burial_date, true);
      gAdd("family_contact = ?", updated.family_contact);
      gAdd("memorial_text = ?", updated.memorial_text);

      // Rebuild QR payload using the merged snapshot
      const { lat, lng } = await getPlotLatLng(updated.plot_id);
      const merged = {
        ...grave,
        plot_id: updated.plot_id,
        deceased_name: updated.deceased_name,
        birth_date: body.birth_date ?? updated.birth_date ?? grave.birth_date,
        death_date: body.death_date ?? updated.death_date ?? grave.death_date,
        burial_date: body.burial_date ?? updated.burial_date ?? grave.burial_date,
        family_contact: updated.family_contact ?? grave.family_contact,
        memorial_text: updated.memorial_text ?? grave.memorial_text,
        headstone_type: grave.headstone_type ?? "flat",
        is_active: grave.is_active ?? true,
        lat, lng,
        // ensure ISO for QR
        created_at: (grave.created_at?.toISOString?.() || grave.created_at || new Date()).toString(),
        updated_at: new Date().toISOString(),
      };
      const qr_token = buildQrPayload(merged);

      gAdd("qr_token = ?", qr_token);

      // If nothing to set (very unlikely), skip UPDATE
      if (gSets.length) {
        gParams.push(grave.id);
        const gSql = `
          UPDATE graves
             SET ${gSets.join(", ")},
                 updated_at = NOW()
           WHERE id = $${gParams.length}
          RETURNING *
        `;
        const { rows: gUp } = await client.query(gSql, gParams);
        grave = gUp?.[0] ?? grave;
      } else {
        // still refresh qr_token timestamp-only if you like
      }
    }

    await client.query("COMMIT");

    // Return fully joined schedule for the UI plus the (possibly updated) grave
    const schedule = await selectScheduleById(id);
    return res.json({ schedule, grave });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[staff.controller] updateBurialSchedule error:", err);
    return res.status(500).json({ message: "Failed to update burial schedule" });
  } finally {
    client.release();
  }
}
// ------------------------ DELETE ------------------------
/**
 * DELETE /staff/burial-schedules/:id
 */
async function deleteBurialSchedule(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: "id is required" });

    const sql = `DELETE FROM burial_schedules WHERE id = $1 RETURNING id`;
    const { rows } = await pool.query(sql, [id]);
    if (!rows?.[0]) return res.status(404).json({ message: "Schedule not found" });

    return res.json({ id: rows[0].id, message: "Deleted" });
  } catch (err) {
    console.error("[staff.controller] deleteBurialSchedule error:", err);
    return res.status(500).json({ message: "Failed to delete burial schedule" });
  }
}

async function getVisitors(req, res) {
  try {
    const sql = `
      SELECT
        id,
        CONCAT(COALESCE(first_name,''),' ',COALESCE(last_name,'')) AS full_name
      FROM users
      WHERE role = 'visitor'
      ORDER BY full_name ASC
    `;
    const { rows } = await pool.query(sql);
    return res.json(rows ?? []);
  } catch (err) {
    console.error("[staff.controller] getVisitors error:", err);
    return res.status(500).json({ message: "Failed to fetch visitors" });
  }
}


const MAINTENANCE_SELECT = `
  SELECT
    ms.id,
    ms.plot_id,
    ms.maintenance_date,
    ms.status,
    ms.approved_by,
    ms.created_at,
    CONCAT(u.first_name, ' ', u.last_name) AS approved_by_name,
    g.deceased_name,
    g.family_contact
  FROM maintenance_schedules ms
  LEFT JOIN graves g ON g.plot_id = (ms.plot_id)::bigint
  LEFT JOIN users  u ON u.id      = (ms.approved_by)::bigint
`;

async function selectMaintenanceById(id) {
  const sql = `${MAINTENANCE_SELECT} WHERE ms.id = $1`;
  const { rows } = await pool.query(sql, [id]);
  return rows?.[0] || null;
}

/**
 * GET /staff/maintenance-schedules
 * Returns maintenance rows joined with graves + users for UI convenience.
 */
async function getMaintenanceSchedules(req, res) {
  try {
    const sql = `
      ${MAINTENANCE_SELECT}
      ORDER BY
        CASE LOWER(ms.status)
          WHEN 'confirmed' THEN 0
          WHEN 'completed' THEN 1
          ELSE 2
        END,
        ms.maintenance_date DESC NULLS LAST,
        ms.created_at DESC
    `;
    const { rows } = await pool.query(sql);
    return res.json(rows ?? []);
  } catch (err) {
    console.error('[staff.controller] getMaintenanceSchedules error:', err);
    return res.status(500).json({ message: 'Failed to fetch maintenance schedules' });
  }
}

/**
 * POST /staff/add-maintenance
 * Body: { plot_id, maintenance_date, status?, approved_by }
 * - status defaults to 'Confirmed'
 */
async function createMaintenance(req, res) {
  try {
    const { plot_id, maintenance_date, status, approved_by } = req.body || {};

    if (!plot_id)       return res.status(400).json({ message: 'plot_id is required' });
    if (!approved_by)   return res.status(400).json({ message: 'approved_by is required' });
    if (!maintenance_date) return res.status(400).json({ message: 'maintenance_date is required' });

    let st = String(status || 'Confirmed').toLowerCase();
    st = st === 'completed' ? 'Completed' : 'Confirmed';

    const insertSql = `
      INSERT INTO maintenance_schedules
        (plot_id, maintenance_date, status, approved_by, created_at)
      VALUES
        (NULLIF($1::text,'')::bigint, NULLIF($2::text,'')::date, $3, NULLIF($4::text,'')::bigint, NOW())
      RETURNING id
    `;
    const { rows } = await pool.query(insertSql, [plot_id, maintenance_date, st, approved_by]);

    const created = await selectMaintenanceById(rows[0].id);
    return res.status(201).json(created);
  } catch (err) {
    console.error('[staff.controller] createMaintenance error:', err);
    return res.status(500).json({ message: 'Failed to create maintenance schedule' });
  }
}

/**
 * PUT /staff/edit-maintenance/:id?
 * Body: { id?, plot_id?, maintenance_date?, status?, approved_by? }
 * - If :id is not provided in URL, uses body.id
 */
async function updateMaintenance(req, res) {
  try {
    const id = req.params?.id || req.body?.id;
    if (!id) return res.status(400).json({ message: 'id is required' });

    const { plot_id, maintenance_date, status, approved_by } = req.body || {};

    const sets = [];
    const params = [];
    const add = (frag, val) => {
      if (val !== undefined) {
        sets.push(frag.replace('?', `$${params.length + 1}`));
        params.push(val);
      }
    };

    // cast targets directly in SQL fragments
    if (plot_id !== undefined)        sets.push(`plot_id = NULLIF($${params.length + 1}::text,'')::bigint`), params.push(plot_id);
    if (maintenance_date !== undefined) sets.push(`maintenance_date = NULLIF($${params.length + 1}::text,'')::date`), params.push(maintenance_date);
    if (status !== undefined) {
      const st = String(status).toLowerCase() === 'completed' ? 'Completed' : 'Confirmed';
      add('status = ?', st);
    }
    if (approved_by !== undefined)    sets.push(`approved_by = NULLIF($${params.length + 1}::text,'')::bigint`), params.push(approved_by);

    if (!sets.length) return res.status(400).json({ message: 'No fields to update' });

    params.push(id);
    const upSql = `
      UPDATE maintenance_schedules
         SET ${sets.join(', ')}
       WHERE id = $${params.length}
      RETURNING id
    `;
    const { rows } = await pool.query(upSql, params);
    if (!rows?.[0]) return res.status(404).json({ message: 'Maintenance schedule not found' });

    const updated = await selectMaintenanceById(rows[0].id);
    return res.json(updated);
  } catch (err) {
    console.error('[staff.controller] updateMaintenance error:', err);
    return res.status(500).json({ message: 'Failed to update maintenance schedule' });
  }
}

/**
 * DELETE /staff/delete-maintenance/:id?
 * Body fallback: { id }
 */
async function deleteMaintenance(req, res) {
  try {
    const id = req.params?.id || req.body?.id;
    if (!id) return res.status(400).json({ message: 'id is required' });

    const delSql = `DELETE FROM maintenance_schedules WHERE id = $1::bigint RETURNING id`;
    const { rows } = await pool.query(delSql, [id]);
    if (!rows?.[0]) return res.status(404).json({ message: 'Maintenance schedule not found' });

    return res.json({ id: rows[0].id, message: 'Deleted' });
  } catch (err) {
    console.error('[staff.controller] deleteMaintenance error:', err);
    return res.status(500).json({ message: 'Failed to delete maintenance schedule' });
  }
}


module.exports = {
  getAllTickets,
  changeTicketStatus,
  getBurialSchedules,
  getAvailablePlots,

  createBurialSchedule,
  updateBurialSchedule,
  deleteBurialSchedule,
  getVisitors,

  getMaintenanceSchedules,
  createMaintenance,
  updateMaintenance,
  deleteMaintenance,
};