/**
 * Fills gaps in BOTH collections for every university in universities_init:
 *
 *   1. universities_init gaps (missing officialSite, or missing source
 *      pages for a degree level) -> scraper/discover.py searches the web
 *      and fills them in, grounded only in real search results.
 *   2. universities_info gaps (a degree level with source pages but no
 *      extracted data yet) -> scraper/extract.py scrapes those pages and
 *      asks the local model for tuition/requirements/scholarships/deadlines
 *      for that one degree level, stored at programs.<degree>.
 *
 * Fills gaps only, by default -- safe to stop and rerun, and cheap to
 * rerun after adding a new university, since it skips everything already
 * done. Pass --force to ignore what's already there and regenerate
 * everything (both config and info) from scratch.
 *
 * This is a LOT of work for 30 universities x 4 degree levels: up to 30
 * discovery passes (each several searches + one Ollama call) and up to
 * 120 extraction passes (each a few page fetches + one Ollama call). On
 * one local 8B model that's realistically hours, not minutes -- this is
 * designed to be interrupted (Ctrl+C) and resumed later without redoing
 * finished work, not to be a quick command.
 *
 * Usage (from the server/ folder):
 *   node discover-and-refresh.js
 *   node discover-and-refresh.js --force
 *   node discover-and-refresh.js --only=mit,oxford      (just these slugs)
 */

require("dotenv").config();
const db = require("./Db");
const { runPythonScript } = require("./python");
const { generateAndSave, DEGREES } = require("./universities");

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

function configNeedsDiscovery(config) {
  if (!config.officialSite) return true;
  const sourceUrls = config.sourceUrls || {};
  return DEGREES.some((d) => !(sourceUrls[d] && sourceUrls[d].length));
}

async function ensureConfig(init, config) {
  if (!FORCE && !configNeedsDiscovery(config)) {
    return config;
  }
  console.log(`\n=== ${config.slug}: discovering config gaps ===`);
  try {
    const discovered = await runPythonScript(
      "discover.py",
      { name: config.name, existing: FORCE ? null : config },
      `${config.slug}:discover`
    );
    const merged = { ...config, ...discovered, slug: config.slug };
    await init.updateOne({ slug: config.slug }, { $set: merged }, { upsert: true });
    return merged;
  } catch (err) {
    console.error(`  ${config.slug}: discovery failed -- ${err.message}`);
    return config; // fall back to whatever we already had; extraction below will just skip empty degrees
  }
}

async function ensurePrograms(info, config) {
  const doc = await info.findOne({ slug: config.slug });
  const existingPrograms = (doc && doc.programs) || {};
  const sourceUrls = config.sourceUrls || {};

  for (const degree of DEGREES) {
    const urls = sourceUrls[degree];
    if (!urls || !urls.length) {
      continue; // no source pages for this degree level (yet) -- nothing to extract
    }
    if (!FORCE && existingPrograms[degree] && existingPrograms[degree].generated_at) {
      console.log(`  ${config.slug}/${degree}: already have data, skipping`);
      continue;
    }
    console.log(`  ${config.slug}/${degree}: extracting...`);
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
    const updatedConfig = await ensureConfig(init, config);
    await ensurePrograms(info, updatedConfig);
    processed += 1;
    console.log(`--- progress: ${processed}/${configs.length} universities processed ---`);
  });

  console.log("\nAll done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("discover-and-refresh failed:", err.message);
    process.exit(1);
  });