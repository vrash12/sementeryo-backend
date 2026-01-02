// backend/scripts/seed_section_prices.js
const path = require("path");
const pool = require(path.join(__dirname, "..", "config", "database"));

const SECTION_ORDER = ["S", "N", "G", "E", "W", "H", "Z", "Y"];
const START_PRICE = 20000;
const STEP = 1500;

function buildPriceMap() {
  const map = {};
  SECTION_ORDER.forEach((sec, idx) => {
    map[sec] = START_PRICE + STEP * idx;
  });
  return map;
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
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function main() {
  const priceMap = buildPriceMap();

  console.log("💰 Seeding plot prices per section...");
  console.log("Price map:", priceMap);

  // Safety: ensure plots.price exists
  const priceExists = await hasColumn("plots", "price");
  if (!priceExists) {
    console.error("❌ Column public.plots.price does not exist.");
    console.error("Run: ALTER TABLE plots ADD COLUMN price numeric;");
    process.exit(1);
  }

  // Build CASE expression
  const cases = SECTION_ORDER.map((sec) => {
    // Only affect plot_name like 'S123', 'N5', etc.
    return `WHEN plot_name ~ '^${sec}[0-9]+$' THEN ${priceMap[sec]}`;
  }).join("\n        ");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sql = `
      UPDATE plots
      SET
        price = CASE
          ${cases}
          ELSE price
        END,
        updated_at = NOW()
      WHERE plot_name ~ '^[SNEGWHZY][0-9]+$';
    `;

    const result = await client.query(sql);
    console.log(`✅ Updated ${result.rowCount} plot rows.`);

    // Optional: show counts per section after update
    const summary = await client.query(
      `
      SELECT
        LEFT(plot_name, 1) AS section,
        COUNT(*)::int AS plots,
        MIN(price) AS min_price,
        MAX(price) AS max_price
      FROM plots
      WHERE plot_name ~ '^[SNEGWHZY][0-9]+$'
      GROUP BY 1
      ORDER BY 1;
      `
    );

    console.log("📊 Summary per section:");
    console.table(summary.rows);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Seeding failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().then(() => process.exit(0));
}
