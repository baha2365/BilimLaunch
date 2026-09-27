const db = require("./Db");
const { runExtraction } = require("./extractor");

/**
 * Generates fresh info for one university (config: {slug, name,
 * sourceUrls, ...} from universities_init) and upserts it into
 * universities_info. Always regenerates -- callers that want a
 * cache-respecting fetch should check universities_info themselves first
 * (see server.js's GET /api/universities/:slug).
 */
async function generateAndSave(config) {
  const extracted = await runExtraction(config);
  const { info } = await db.connect();
  await info.updateOne(
    { slug: config.slug },
    { $set: { slug: config.slug, ...extracted } },
    { upsert: true }
  );
  return info.findOne({ slug: config.slug });
}

module.exports = { generateAndSave };