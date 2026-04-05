"use strict";

const path = require("path");
const pool = require(path.join(__dirname, "..", "config", "database"));

async function main() {
  const client = await pool.connect();

  try {
    console.log("[backfill] starting plot person/date sync...");
    await client.query("BEGIN");

    // 1) See which target columns exist in plots
    const colsRes = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'plots'
    `);

    const cols = new Set(colsRes.rows.map((r) => r.column_name));

    const hasPerson = cols.has("person_full_name");
    const hasDob = cols.has("date_of_birth");
    const hasDod = cols.has("date_of_death");
    const hasUpdatedAt = cols.has("updated_at");

    if (!hasPerson && !hasDob && !hasDod) {
      throw new Error(
        "plots table does not have person_full_name/date_of_birth/date_of_death columns"
      );
    }

    // 2) Clear old values first so plots with no grave record don't keep stale data
    const clearParts = [];
    if (hasPerson) clearParts.push(`person_full_name = NULL`);
    if (hasDob) clearParts.push(`date_of_birth = NULL`);
    if (hasDod) clearParts.push(`date_of_death = NULL`);
    if (hasUpdatedAt) clearParts.push(`updated_at = NOW()`);

    if (clearParts.length) {
      const clearSql = `
        UPDATE plots
        SET ${clearParts.join(", ")}
      `;
      await client.query(clearSql);
      console.log("[backfill] cleared existing plot person/date fields");
    }

    // 3) Pick one grave per plot reference
    //    - handles graves.plot_id pointing to plots.id OR plots.uid
    //    - newest grave wins if duplicates exist
    const updateParts = [];
    if (hasPerson) updateParts.push(`person_full_name = src.deceased_name`);
    if (hasDob) updateParts.push(`date_of_birth = src.birth_date`);
    if (hasDod) updateParts.push(`date_of_death = src.death_date`);
    if (hasUpdatedAt) updateParts.push(`updated_at = NOW()`);

    const sql = `
      WITH grave_source AS (
        SELECT
          g.id AS grave_id,
          g.plot_id::text AS grave_plot_ref,
          NULLIF(TRIM(g.deceased_name), '') AS deceased_name,
          g.birth_date,
          g.death_date,
          g.updated_at,
          g.created_at
        FROM graves g
      ),
      matched AS (
        SELECT DISTINCT ON (p.id)
          p.id AS plot_pk,
          gs.deceased_name,
          gs.birth_date,
          gs.death_date
        FROM plots p
        JOIN grave_source gs
          ON p.id::text = gs.grave_plot_ref
          OR p.uid::text = gs.grave_plot_ref
        WHERE gs.deceased_name IS NOT NULL
        ORDER BY
          p.id,
          gs.updated_at DESC NULLS LAST,
          gs.created_at DESC NULLS LAST,
          gs.grave_id DESC
      )
      UPDATE plots p
      SET ${updateParts.join(", ")}
      FROM matched src
      WHERE p.id = src.plot_pk
      RETURNING p.id, p.uid, p.plot_name
    `;

    const result = await client.query(sql);

    // 4) Optional: make sure plots with grave records are occupied
    await client.query(`
      UPDATE plots p
      SET status = 'occupied'
      WHERE EXISTS (
        SELECT 1
        FROM graves g
        WHERE p.id::text = g.plot_id::text
           OR p.uid::text = g.plot_id::text
      )
    `);

    await client.query("COMMIT");

    console.log(`[backfill] synced ${result.rowCount} plots from graves`);
    console.log("[backfill] done");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("[backfill] failed:", err.message || err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0));
}