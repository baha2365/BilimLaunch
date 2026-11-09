/**
 * One-time backfill: gives every university in universities_init that has no
 * `degreeTypes` yet the value ["bachelor"] (all pre-existing universities were
 * bachelor's universities). Universities that already have degreeTypes are
 * left alone, so it is safe to run more than once.
 *
 *   node backfill_degree_types.js --dry-run    (show what would change)
 *   node backfill_degree_types.js              (apply)
 */
require("dotenv").config();
const db = require("./Db");

(async () => {
  const dry = process.argv.includes("--dry-run");
  const { init } = await db.connect();
  const filter = { $or: [{ degreeTypes: { $exists: false } }, { degreeTypes: null }] };
  const todo = await init.find(filter, { projection: { slug: 1, name: 1 } }).toArray();
  console.log(`${db.INIT_COLLECTION_NAME}: ${todo.length} university(ies) without degreeTypes`);
  todo.forEach((u) => console.log(`  ${u.slug} (${u.name})`));
  if (dry || !todo.length) return process.exit(0);

  const res = await init.updateMany(filter, { $set: { degreeTypes: ["bachelor"] } });
  console.log(`Updated ${res.modifiedCount} document(s) with degreeTypes: ["bachelor"].`);
  process.exit(0);
})().catch((err) => {
  console.error("backfill failed:", db.explainError(err));
  process.exit(1);
});
