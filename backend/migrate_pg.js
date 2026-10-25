/*
 * Creates / updates the PostgreSQL tables used for user accounts.
 *
 *   node migrate-pg.js          (or: npm run db:migrate)
 *
 * Runs every file in server/migrations/ that hasn't run yet, in name order,
 * each inside its own transaction. Safe to run again at any time.
 */
const fs = require("fs");
const path = require("path");
const pg = require("./pg");

const DIR = path.join(__dirname, "migrations");
const LOCK_KEY = 726174; // arbitrary number: stops two people migrating at the same moment

async function migrate({ log = console.log } = {}) {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = await pg.getPool().connect();
  const applied = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    );
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(DIR, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
      applied.push(file);
      log(`  applied ${file}`);
    }
    if (!applied.length) log("  nothing to do -- the database is already up to date");
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}

if (require.main === module) {
  console.log(`Migrating PostgreSQL (${pg.safeUrl() || "DATABASE_URL not set"})`);
  migrate()
    .then(() => pg.close())
    .then(() => console.log("Done."))
    .catch(async (err) => {
      console.error(`Failed: ${pg.explainError(err)}`);
      await pg.close().catch(() => {});
      process.exit(1);
    });
}

module.exports = { migrate };
