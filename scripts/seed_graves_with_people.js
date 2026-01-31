// backend/scripts/seed_graves_with_people.js
"use strict";

const path = require("path");
const pool = require(path.join(__dirname, "..", "config", "database"));

const KEEP_UNOCCUPIED = Number(process.env.KEEP_UNOCCUPIED || 10);
const WIPE = String(process.env.WIPE || "true").toLowerCase() === "true";
const LIMIT = Number(process.env.LIMIT || 0); // 0 = no limit (use all)
const DEBUG = String(process.env.DEBUG || "0") === "1";

function log(...args) {
  console.log("[seed_graves_with_people]", ...args);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

// ✅ keep within CHAR(5)
function genUid5() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 5; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function getColumnInfo(table, column) {
  const { rows } = await pool.query(
    `
    SELECT data_type, character_maximum_length
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name=$1
      AND column_name=$2
    LIMIT 1
    `,
    [table, column]
  );
  return rows[0] || null;
}

function iso(y, m, d) {
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function fakePerson(i) {
  const first = [
    "Juan", "Maria", "Jose", "Ana", "Pedro", "Luisa", "Carlos", "Rosa", "Miguel", "Carmen",
    "Andres", "Teresa", "Paolo", "Isabel", "Ramon", "Elena", "Ricardo", "Sofia", "Daniel", "Grace",
  ];
  const last = [
    "Dela Cruz", "Santos", "Reyes", "Garcia", "Mendoza", "Torres", "Flores", "Gonzales", "Ramos", "Castillo",
    "Navarro", "Aquino", "Bautista", "Villanueva", "Pascual", "Domingo", "Salazar", "Cabrera", "Valdez", "Luna",
  ];

  const deceased_name = `${pick(first)} ${pick(last)}`;

  const birthYear = randInt(1930, 1990);
  const birthMonth = randInt(1, 12);
  const birthDay = randInt(1, 28);

  const deathYear = randInt(Math.max(birthYear + 18, 2000), 2025);
  const deathMonth = randInt(1, 12);
  const deathDay = randInt(1, 28);

  // burial shortly after death
  const burialYear = deathYear;
  const burialMonth = deathMonth;
  const burialDay = Math.min(28, deathDay + randInt(1, 7));

  const headstone_type = pick(["granite", "marble", "bronze", "limestone", "none"]);
  const memorial_text = pick([
    "Forever in our hearts.",
    "Rest in peace.",
    "Gone but never forgotten.",
    "In loving memory.",
    "Loved always.",
  ]);

  return {
    deceased_name,
    birth_date: iso(birthYear, birthMonth, birthDay),
    death_date: iso(deathYear, deathMonth, deathDay),
    burial_date: iso(burialYear, burialMonth, burialDay),
    headstone_type,
    memorial_text,
    photo_url: null,
    is_active: true,
  };
}

async function main() {
  log("🪦 Seeding graves with fictional people...");
  log("KEEP_UNOCCUPIED =", KEEP_UNOCCUPIED);
  log("WIPE =", WIPE);
  log("LIMIT =", LIMIT);

  const graveUidCol = await getColumnInfo("graves", "uid");
  const plotIdCol = await getColumnInfo("graves", "plot_id");

  if (DEBUG) {
    log("graves.uid column =", graveUidCol);
    log("graves.plot_id column =", plotIdCol);
  }

  const graveUidMax = graveUidCol?.character_maximum_length || 5;

  // Determine if graves.plot_id is numeric or text
  const plotIdIsNumeric =
    plotIdCol?.data_type === "integer" ||
    plotIdCol?.data_type === "bigint" ||
    plotIdCol?.data_type === "numeric";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (WIPE) {
      log("🧹 Wiping existing graves and freeing occupied plots (generated grave plots only)...");
      await client.query(`DELETE FROM graves`);

      // free all generated grave plots (S/N/G/E/W/H/Z/Y + numbers)
      await client.query(`
        UPDATE plots
        SET status = 'available', updated_at = NOW()
        WHERE plot_name ~ '^[SNEGWHZY][0-9]+$'
           OR plot_type ILIKE 'grave%';
      `);
    }

    // Load grave plots from plots table
    const plotsRes = await client.query(
      `
      SELECT id, uid, plot_name, plot_type, status
      FROM plots
      WHERE plot_name ~ '^[SNEGWHZY][0-9]+$'
         OR plot_type ILIKE 'grave%'
      ORDER BY id ASC
      `
    );

    let plots = plotsRes.rows || [];
    if (LIMIT > 0) plots = plots.slice(0, LIMIT);

    if (plots.length === 0) {
      throw new Error("No grave plots found in plots table. Run seed_cemetery_layout first.");
    }

    // choose KEEP_UNOCCUPIED plots to remain available
    const keep = plots.slice(0, Math.min(KEEP_UNOCCUPIED, plots.length));
    const keepIds = new Set(keep.map((p) => String(p.id)));

    log(`Available grave plots found: ${plots.length}`);
    log(`🟩 Will keep ${keep.length} plots unoccupied (available).`);
    log(`🟥 Will occupy ${plots.length - keep.length} plots.`);

    // Insert graves for every plot NOT in keepIds
    const insertSql = `
      INSERT INTO graves
        (uid, plot_id, deceased_name, birth_date, death_date, burial_date,
         family_contact, headstone_type, memorial_text, photo_url, is_active,
         created_at, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW(), NOW())
    `;

    let created = 0;

    for (let i = 0; i < plots.length; i++) {
      const p = plots[i];
      if (keepIds.has(String(p.id))) continue;

      const person = fakePerson(i);

      // ✅ safe uid: prefer plot.uid (already 5 chars from your layout seed)
      let graveUid = (p.uid && String(p.uid).trim()) ? String(p.uid).trim() : genUid5();
      if (graveUid.length > graveUidMax) graveUid = graveUid.slice(0, graveUidMax);

      // resolve plot reference for graves.plot_id
      const plotRef = plotIdIsNumeric ? Number(p.id) : String(p.uid || p.id);

      await client.query(insertSql, [
        graveUid,
        plotRef,
        person.deceased_name,
        person.birth_date,
        person.death_date,
        person.burial_date,
        null, // family_contact (keep null to avoid FK/length issues)
        person.headstone_type,
        person.memorial_text,
        person.photo_url,
        true,
      ]);

      created++;
    }

    // Update plot statuses:
    // - keepers => available
    // - everyone else => occupied
    await client.query(
      `
      UPDATE plots
      SET status = CASE WHEN id = ANY($1::int[]) THEN 'available' ELSE 'occupied' END,
          updated_at = NOW()
      WHERE plot_name ~ '^[SNEGWHZY][0-9]+$'
         OR plot_type ILIKE 'grave%';
      `,
      [keep.map((p) => Number(p.id))]
    );

    await client.query("COMMIT");

    log(`✅ Done. Inserted ${created} grave records.`);
    log("Reload your map page — almost everything should be RED except 10 GREEN.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Seed failed:", err?.message || err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0));
}
