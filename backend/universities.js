const db = require("./db");
const { runExtraction } = require("./extractor");
const { scrapeUrl } = require("./scrape");

const DEGREES = ["bachelor", "master", "doctorate", "exchange"];
const SCRAPE_DELAY_MS = 1000; // a little polite spacing between page fetches on the same site

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generates fresh info for one university's ONE degree level (config:
 * {slug, name, sourceUrls: {bachelor:[...], master:[...], ...}, ...} from
 * universities_init) and upserts it into universities_info.programs.<degree>.
 * Always regenerates that one degree level's data -- callers that want a
 * cache-respecting fetch should check universities_info themselves first
 * (see server.js's GET /api/universities/:slug/:degree).
 *
 * Scraping happens here, via Puppeteer (server/scrape.js) -- one page at a
 * time, sequentially, so a university with several source pages for one
 * degree level doesn't hit that site with simultaneous requests.
 */
async function generateAndSave(config, degree) {
  if (!DEGREES.includes(degree)) {
    throw new Error(`Unknown degree level '${degree}'`);
  }
  const sourceUrls = (config.sourceUrls && config.sourceUrls[degree]) || [];
  if (!sourceUrls.length) {
    throw new Error(`No ${degree} source pages configured yet for ${config.name}.`);
  }

  const pages = [];
  for (let i = 0; i < sourceUrls.length; i++) {
    const url = sourceUrls[i];
    const text = await scrapeUrl(url);
    pages.push({ url, text });
    if (i < sourceUrls.length - 1) await sleep(SCRAPE_DELAY_MS);
  }

  const extracted = await runExtraction({ slug: config.slug, name: config.name, degree, pages });
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