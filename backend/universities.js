const db = require("./db");
const { runExtraction } = require("./extractor");
const fs = require("fs");
const path = require("path");
const { cleanFields } = require("./fields");
const { scrapeUrl, scrapeListItems, discoverProgrammeLinks } = require("./scrape");

const DEGREES = ["bachelor", "master", "doctorate", "exchange"];
const SCRAPE_DELAY_MS = 1000; // a little polite spacing between page fetches on the same site

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scrapes the configured programme-list pages (config.fieldUrls.<degree>)
 * and returns {fields_of_study, fields_sources}. These are the pages' own
 * entries (no LLM), used by the matcher to check the student's field of
 * study. Returns null when no list pages are configured or nothing came back.
 */
/** fieldUrls from the DB config, falling back to data/universities.json so
 *  list pages work even before `npm run seed` has been re-run. */
function configuredFieldUrls(config, degree) {
  const fromDb = (config.fieldUrls && config.fieldUrls[degree]) || [];
  if (fromDb.length) return fromDb;
  try {
    const all = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "universities.json"), "utf8"));
    const match = all.find((u) => u.slug === config.slug);
    return (match && match.fieldUrls && match.fieldUrls[degree]) || [];
  } catch (_) {
    return [];
  }
}

async function scrapeFields(config, degree) {
  let urls = configuredFieldUrls(config, degree);
  const hasConfigured = urls.length > 0;
  // Auto-discovery is only attempted for bachelor lists: on a university's
  // home page it tends to find graduate or directory pages otherwise.
  if (!urls.length && degree === "bachelor" && config.officialSite) {
    // No hand-picked list pages: look for "majors / programs / courses"
    // links on the university's own site. Best effort; fields_sources
    // records exactly which pages were used so it can be verified.
    urls = await discoverProgrammeLinks(config.officialSite);
    if (urls.length) console.log(`  ${config.slug}/${degree}: auto-discovered programme pages: ${urls.join(", ")}`);
  }
  if (!urls.length) return null;
  const seen = new Set();
  const fields = [];
  const sources = [];
  for (let i = 0; i < urls.length; i++) {
    const items = await scrapeListItems(urls[i]);
    if (items.length) sources.push(urls[i]);
    for (const item of cleanFields(items, degree)) {
      if (!seen.has(item.toLowerCase())) {
        seen.add(item.toLowerCase());
        fields.push(item);
      }
    }
    if (i < urls.length - 1) await sleep(SCRAPE_DELAY_MS);
  }
  // Auto-discovered pages are only trusted when they look like a real list:
  // too few entries means we found the wrong page, too many means a site
  // directory (departments, services, ...) rather than a list of subjects.
  const discovered = !hasConfigured;
  if (discovered && (fields.length < 8 || fields.length > 400)) {
    console.log(`  ${config.slug}/${degree}: discarded auto-discovered list (${fields.length} entries) -- add fieldUrls in data/universities.json`);
    return null;
  }
  return fields.length ? { fields_of_study: fields, fields_sources: sources } : null;
}

/** Cheap refresh of just the programme list (no Ollama call). */
async function refreshFields(config, degree) {
  const result = await scrapeFields(config, degree);
  if (!result) return false;
  const { info } = await db.connect();
  await info.updateOne(
    { slug: config.slug },
    { $set: { slug: config.slug, [`programs.${degree}.fields_of_study`]: result.fields_of_study, [`programs.${degree}.fields_sources`]: result.fields_sources } },
    { upsert: true }
  );
  return true;
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

  // Programme list: fresh if scraped; otherwise keep whatever we had so a
  // temporary block doesn't wipe it.
  const fields = await scrapeFields(config, degree);
  if (fields) {
    Object.assign(extracted, fields);
  } else {
    const previous = await info.findOne({ slug: config.slug });
    const old = previous && previous.programs && previous.programs[degree];
    const kept = old && old.fields_of_study ? cleanFields(old.fields_of_study, degree) : [];
    if (kept.length >= 8) {
      extracted.fields_of_study = kept;
      extracted.fields_sources = old.fields_sources || [];
    }
  }
  await info.updateOne(
    { slug: config.slug },
    { $set: { slug: config.slug, [`programs.${degree}`]: extracted } },
    { upsert: true }
  );
  const doc = await info.findOne({ slug: config.slug });
  return doc.programs[degree];
}

module.exports = { generateAndSave, refreshFields, DEGREES };