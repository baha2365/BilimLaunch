/**
 * Diagnoses the database connection and the shape of the stored data.
 *   node check-db.js            (summary)
 *   node check-db.js oxford     (details for one university)
 */
require("dotenv").config();
const db = require("./Db");

(async () => {
  const slug = process.argv[2];
  console.log(`Connecting to ${db.safeUri()}`);
  console.log(`Database: ${db.DB_NAME}  | collections: ${db.INIT_COLLECTION_NAME}, ${db.INFO_COLLECTION_NAME}`);
  const { init, info } = await db.connect();
  const [nInit, nInfo] = await Promise.all([init.countDocuments(), info.countDocuments()]);
  console.log(`${db.INIT_COLLECTION_NAME}: ${nInit} document(s)`);
  console.log(`${db.INFO_COLLECTION_NAME}: ${nInfo} document(s)`);

  const docs = await info.find({}).toArray();
  const odd = docs.filter((d) => !d.slug || !d.programs || typeof d.programs !== "object" || Array.isArray(d.programs));
  if (odd.length) {
    console.log(`\nDocuments in ${db.INFO_COLLECTION_NAME} with a missing slug or a bad 'programs' field:`);
    odd.forEach((d) => console.log(`  _id=${d._id} slug=${d.slug} programs=${d.programs === null ? "null" : typeof d.programs}`));
  }

  if (slug) {
    const doc = (await info.findOne({ slug })) || (await info.findOne({ _id: slug }));
    console.log(`\n${slug}:`);
    if (!doc) return console.log("  no document in universities_info (an admin save will create one)");
    console.log(`  _id=${doc._id}, top-level keys: ${Object.keys(doc).join(", ")}`);
    for (const [d, p] of Object.entries(doc.programs || {})) {
      console.log(`  programs.${d}: generated_at=${p.generated_at} manual=${!!p.manual} fields=${(p.fields_of_study || []).length} edited_at=${p.edited_at || "-"}`);
    }
  }

  try {
    const probe = await info.updateOne({ slug: "__write_test__" }, { $set: { slug: "__write_test__", t: new Date().toISOString() } }, { upsert: true });
    await info.deleteOne({ slug: "__write_test__" });
    console.log(`\nWrite test on ${db.INFO_COLLECTION_NAME}: OK`);
  } catch (err) {
    console.log(`\nWrite test on ${db.INFO_COLLECTION_NAME}: FAILED -- ${db.explainError(err)}`);
  }
  process.exit(0);
})().catch((err) => {
  console.error("check-db failed:", db.explainError(err));
  process.exit(1);
});