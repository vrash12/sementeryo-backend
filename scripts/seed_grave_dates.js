"use strict";

const path = require("path");
const pool = require(path.join(__dirname, "..", "config", "database"));

const LIMIT = Number(process.env.LIMIT || 0);
const ONLY_WHERE_EMPTY = String(process.env.ONLY_WHERE_EMPTY || "true").toLowerCase() === "true";
const DEBUG = String(process.env.DEBUG || "0") === "1";

function log(...args) {
  console.log("[sync_graves_to_plots]", ...args);
}

function normDate(v) {
  if (v == null) return null;

  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const yyyy = v.getFullYear();
    const mm = String(v.getMonth() + 1).padStart(2, "0");
    const dd = String(v.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  const s = String(v).trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function hasColumn(tableName, columnName) {
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
  return rows.length > 0;
}

async function main() {
  const plotHasName = await hasColumn("plots", "person_full_name");
  const plotHasDob = await hasColumn("plots", "date_of_birth");
  const plotHasDod = await hasColumn("plots", "date_of_death");

  if (!plotHasName && !plotHasDob && !plotHasDod) {
    throw new Error("plots table does not have person_full_name/date_of_birth/date_of_death columns");
  }

  const whereEmpty = ONLY_WHERE_EMPTY
    ? `
      AND (
        COALESCE(NULLIF(TRIM(p.person_full_name), ''), '') = ''
        OR p.date_of_birth IS NULL
        OR p.date_of_death IS NULL
      )
    `
    : "";

  const limitSql = LIMIT > 0 ? `LIMIT ${LIMIT}` : "";

  const sql = `
    SELECT
      g.id AS grave_id,
      g.uid AS grave_uid,
      g.plot_id,
      g.deceased_name,
      g.birth_date,
      g.death_date,
      p.id AS plot_real_id,
      p.uid AS plot_uid,
      p.plot_name,
      p.person_full_name,
      p.date_of_birth,
      p.date_of_death
    FROM graves g
    JOIN plots p
      ON p.id::text = g.plot_id::text
      OR p.uid::text = g.plot_id::text
    WHERE 1=1
    ${whereEmpty}
    ORDER BY g.id ASC
    ${limitSql};
  `;

  const { rows } = await pool.query(sql);

  if (!rows.length) {
    log("No matching grave -> plot rows to sync.");
    await pool.end();
    return;
  }

  log(`Found ${rows.length} row(s) to sync.`);

  const client = await pool.connect();
  let updated = 0;

  try {
    await client.query("BEGIN");

    for (const row of rows) {
      const nextName = String(row.deceased_name || "").trim() || null;
      const nextDob = normDate(row.birth_date);
      const nextDod = normDate(row.death_date);

      if (DEBUG) {
        log("sync", {
          grave_id: row.grave_id,
          plot_id: row.plot_real_id,
          plot_name: row.plot_name,
          nextName,
          nextDob,
          nextDod,
        });
      }

      const sets = [];
      const params = [row.plot_real_id];
      let i = 2;

      if (plotHasName) {
        sets.push(`person_full_name = $${i++}`);
        params.push(nextName);
      }
      if (plotHasDob) {
        sets.push(`date_of_birth = $${i++}`);
        params.push(nextDob);
      }
      if (plotHasDod) {
        sets.push(`date_of_death = $${i++}`);
        params.push(nextDod);
      }

      sets.push(`updated_at = NOW()`);

      await client.query(
        `
        UPDATE plots
        SET ${sets.join(", ")}
        WHERE id = $1
        `,
        params
      );

      updated++;
    }

    await client.query("COMMIT");
    log(`✅ Done. Synced ${updated} plot row(s) from graves.`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Sync failed:", err?.message || err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0));
}