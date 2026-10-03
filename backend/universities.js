const db = require("./db");
const { runExtraction } = require("./extractor");

const DEGREES = ["bachelor", "master", "doctorate", "exchange"];

/**
 * Generates fresh info for one university's ONE degree level (config:
 * {slug, name, sourceUrls: {bachelor:[...], master:[...], ...}, ...} from
 * universities_init) and upserts it into universities_info.programs.<degree>.
 * Always regenerates that one degree level's data -- callers that want a
 * cache-respecting fetch should check universities_info themselves first
 * (see server.js's GET /api/universities/:slug/:degree).
 */
async function generateAndSave(config, degree) {
  if (!DEGREES.includes(degree)) {
    throw new Error(`Unknown degree level '${degree}'`);
  }
  const sourceUrls = (config.sourceUrls && config.sourceUrls[degree]) || [];
  if (!sourceUrls.length) {
    throw new Error(`No ${degree} source pages configured yet for ${config.name}.`);
  }

  const extracted = await runExtraction({ slug: config.slug, name: config.name, degree, sourceUrls });
  const { info } = await db.connect();
  await info.updateOne(
    { slug: config.slug },
    { $set: { slug: config.slug, [`programs.${degree}`]: extracted } },
    { upsert: true }
  );
  const doc = await info.findOne({ slug: config.slug });
  return doc.programs[degree];
}

module.exports = { generateAndSave, DEGREES };