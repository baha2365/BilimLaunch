/**
 * Regenerates universities_info for every university in universities_init
 * -- a full re-scrape + re-extraction pass, ignoring whatever's cached.
 * This is the "keep tuition/scholarship data current" job. Regenerates
 * every degree level (bachelor/master/doctorate/exchange) that has source
 * pages configured; a degree level with no source URLs yet is skipped
 * (add their URLs to data/universities.json, run `npm run seed`, then `npm run fill-gaps`).
 *
 * Runs universities one at a time by default (REFRESH_CONCURRENCY=1) since
 * a single local Ollama model on one machine doesn't actually get faster
 * from parallel requests -- they queue for the same GPU/CPU anyway, and
 * running several at once just adds memory pressure. Raise
 * REFRESH_CONCURRENCY in .env if you have the hardware (e.g. a fast GPU
 * with room for a few concurrent contexts) and want to try it.
 *
 * Standalone usage (from the server/ folder):
 *   node refresh-all.js
 * or:
 *   npm run refresh
 *
 * For "every 24 hours," the two options are:
 *   1. Set AUTO_REFRESH_HOURS=24 in server/.env -- server.js will then run
 *      this on a timer for as long as the server process stays up.
 *   2. Leave AUTO_REFRESH_HOURS unset and instead point an OS scheduler
 *      (Windows Task Scheduler, cron, launchd) at `node refresh-all.js`
 *      once a day -- more robust, since it doesn't depend on the server
 *      never being restarted or the machine never sleeping.
 * See the README for both.
 */

require("dotenv").config();
const db = require("./db");
const { generateAndSave, DEGREES } = require("./universities");

const REFRESH_CONCURRENCY = Math.max(1, parseInt(process.env.REFRESH_CONCURRENCY, 10) || 1);

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = { slug: items[i].slug, ok: true, value: await worker(items[i]) };
      } catch (err) {
        results[i] = { slug: items[i].slug, ok: false, error: err.message };
      }
    }
  }

  const lanes = Array.from({ length: Math.min(limit, items.length) }, runNext);
  await Promise.all(lanes);
  return results;
}

async function refreshAll() {
  const { init } = await db.connect();
  const configs = await init.find({}).toArray();

  if (!configs.length) {
    console.log("No universities in universities_init yet -- run `npm run seed` first.");
    return { succeeded: [], failed: [] };
  }

  console.log(`Refreshing ${configs.length} universities (concurrency: ${REFRESH_CONCURRENCY})...`);

  const results = await runWithConcurrency(configs, REFRESH_CONCURRENCY, async (config) => {
    console.log(`\n=== ${config.slug} ===`);
    const sourceUrls = config.sourceUrls || {};
    const degreesWithUrls = DEGREES.filter((d) => sourceUrls[d] && sourceUrls[d].length);
    if (!degreesWithUrls.length) {
      console.log(`  ${config.slug}: no source pages configured for any degree level yet -- skipping`);
      return;
    }
    for (const degree of degreesWithUrls) {
      console.log(`  ${config.slug}/${degree}: regenerating...`);
      await generateAndSave(config, degree); // lets a failure here reject the whole university, same as before
      console.log(`  ${config.slug}/${degree}: done`);
    }
  });

  const succeeded = results.filter((r) => r.ok).map((r) => r.slug);
  const failed = results.filter((r) => !r.ok);

  console.log(`\nDone. ${succeeded.length} succeeded, ${failed.length} failed.`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  ${f.slug}: ${f.error}`));
  }

  return { succeeded, failed };
}

module.exports = { refreshAll };

// Only run automatically when invoked directly (`node refresh-all.js`),
// not when server.js requires this file for the scheduler (the server
// keeps its own browser instance alive across requests -- see scrape.js
// -- and shouldn't have it closed out from under it by a scheduled run).
if (require.main === module) {
  const { closeBrowser } = require("./scrape");
  refreshAll()
    .then(async ({ failed }) => {
      await closeBrowser();
      process.exit(failed.length ? 1 : 0);
    })
    .catch(async (err) => {
      console.error("refresh-all failed:", err.message);
      await closeBrowser().catch(() => {});
      process.exit(1);
    });
}