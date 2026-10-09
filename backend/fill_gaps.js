/**
 * Fills gaps in universities_info for every university in universities_init:
 * a degree level with source pages configured but no extracted data yet
 * gets scraped (via server/scrape.js, Puppeteer) and sent through
 * scraper/extract.py, stored at programs.<degree>.
 *
 * This does NOT discover new universities or new source URLs -- that
 * capability (web search via DuckDuckGo) was removed; adding a university
 * or a missing degree level's source pages is now a manual edit to
 * data/universities.json followed by `npm run seed`. This script only
 * fills in the *extraction* side: pages you've already configured that
 * haven't been scraped + summarized yet.
 *
 * Fills gaps only, by default -- safe to stop and rerun, and cheap to
 * rerun after adding new source pages, since it skips every degree level
 * that already has data. Pass --force to regenerate everything regardless
 * (same as refresh-all.js, but --only lets you restrict it).
 *
 * This is still a lot of work for 30 universities x up to 4 degree levels
 * each: up to 120 extraction passes, each a few page loads (real browser
 * navigations, not simple HTTP requests, so slower) plus one Ollama call.
 * Designed to be interrupted (Ctrl+C) and resumed later without redoing
 * finished work.
 *
 * Usage (from the server/ folder):
 *   node fill-gaps.js
 *   node fill-gaps.js --force
 *   node fill-gaps.js --only=mit,oxford      (just these slugs)
 */

require("dotenv").config();
const db = require("./db");
const { generateAndSave, refreshFields, DEGREES } = require("./universities");
const { closeBrowser } = require("./scrape");

const FORCE = process.argv.includes("--force");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").replace("--only=", "");
const ONLY_SLUGS = ONLY ? new Set(ONLY.split(",").map((s) => s.trim())) : null;
const CONCURRENCY = Math.max(1, parseInt(process.env.REFRESH_CONCURRENCY, 10) || 1);

async function runWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  async function lane() {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

async function ensurePrograms(info, config) {
  const doc = await info.findOne({ slug: config.slug });
  const existingPrograms = (doc && doc.programs) || {};
  const sourceUrls = config.sourceUrls || {};

  for (const degree of DEGREES) {
    const urls = sourceUrls[degree];
    if (!urls || !urls.length) {
      continue; // no source pages configured for this degree level -- nothing to extract
    }
    if (!FORCE && existingPrograms[degree] && existingPrograms[degree].generated_at) {
      const wantsFields = config.fieldUrls && config.fieldUrls[degree] && config.fieldUrls[degree].length;
      if (wantsFields && !(existingPrograms[degree].fields_of_study || []).length) {
        console.log(`  ${config.slug}/${degree}: adding programme list only...`);
        const ok = await refreshFields(config, degree);
        console.log(`  ${config.slug}/${degree}: programme list ${ok ? "saved" : "could not be read"}`);
      } else {
        console.log(`  ${config.slug}/${degree}: already have data, skipping`);
      }
      continue;
    }
    console.log(`  ${config.slug}/${degree}: scraping + extracting...`);
    try {
      await generateAndSave(config, degree);
      console.log(`  ${config.slug}/${degree}: done`);
    } catch (err) {
      console.error(`  ${config.slug}/${degree}: FAILED -- ${err.message}`);
    }
  }
}

async function main() {
  const { init, info } = await db.connect();
  let configs = await init.find({}).toArray();
  if (ONLY_SLUGS) {
    configs = configs.filter((c) => ONLY_SLUGS.has(c.slug));
  }

  console.log(
    `Processing ${configs.length} universities (force=${FORCE}, concurrency=${CONCURRENCY})` +
      (ONLY_SLUGS ? ` -- restricted to: ${[...ONLY_SLUGS].join(", ")}` : "")
  );

  let processed = 0;
  await runWithConcurrency(configs, CONCURRENCY, async (config) => {
    await ensurePrograms(info, config);
    processed += 1;
    console.log(`--- progress: ${processed}/${configs.length} universities processed ---`);
  });

  console.log("\nAll done.");
}

main()
  .then(() => closeBrowser())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("fill-gaps failed:", err.message);
    await closeBrowser().catch(() => {});
    process.exit(1);
  });