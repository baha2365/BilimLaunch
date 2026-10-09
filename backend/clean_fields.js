/**
 * Repairs programme lists already stored in MongoDB (removes page furniture
 * and postgraduate entries from bachelor lists). No scraping, no Ollama.
 *   npm run clean-fields
 */
require("dotenv").config();
const db = require("./db");
const { cleanFields } = require("./fields");

(async () => {
  const { info } = await db.connect();
  const docs = await info.find({}).toArray();
  for (const doc of docs) {
    for (const [degree, program] of Object.entries(doc.programs || {})) {
      if (!Array.isArray(program.fields_of_study)) continue;
      const cleaned = cleanFields(program.fields_of_study, degree);
      const keep = cleaned.length >= 8 ? cleaned : [];
      console.log(`${doc.slug}/${degree}: ${program.fields_of_study.length} -> ${keep.length}${keep.length ? "" : " (too few left; cleared -- add fieldUrls and run fill-gaps)"}`);
      await info.updateOne({ slug: doc.slug }, { $set: { [`programs.${degree}.fields_of_study`]: keep } });
    }
  }
  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });