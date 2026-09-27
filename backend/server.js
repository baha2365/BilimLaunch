require("dotenv").config();

const express = require("express");
const path = require("path");
const db = require("./Db");
const { generateAndSave } = require("./universities");
const { PYTHON_BIN } = require("./extractor");
const { refreshAll } = require("./refresh_all");

const ROOT = path.join(__dirname, "../frontend");
const PORT = process.env.PORT || 3000;
const AUTO_REFRESH_HOURS = parseFloat(process.env.AUTO_REFRESH_HOURS || "0");

const app = express();
app.use(express.static(ROOT));

function withoutId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return rest;
}

// Config (universities_init) and generated info (universities_info) are
// merged for the API response -- generated fields win on overlap (there
// isn't any besides slug, which is identical either way).
function mergeConfigAndInfo(config, info) {
  return { ...withoutId(config), ...withoutId(info) };
}

// Keyed by slug (or "slug:force"), so two requests for the same
// not-yet-generated university share one Python process + one Mongo
// write instead of each spawning their own scrape + local-model run.
const inFlight = new Map();

function runExtractor(config, force) {
  const key = force ? `${config.slug}:force` : config.slug;
  if (inFlight.has(key)) return inFlight.get(key);

  const tracked = generateAndSave(config).finally(() => inFlight.delete(key));
  inFlight.set(key, tracked);
  return tracked;
}

app.get("/api/universities", async (req, res) => {
  try {
    const { init, info } = await db.connect();
    const configs = await init.find({}).toArray();
    const infos = await info.find({}, { projection: { slug: 1, generated_at: 1 } }).toArray();
    const generatedSlugs = new Set(infos.filter((doc) => doc.generated_at).map((doc) => doc.slug));

    res.json(
      configs.map((doc) => ({
        slug: doc.slug,
        name: doc.name,
        shortName: doc.shortName,
        country: doc.country,
        city: doc.city,
        cached: generatedSlugs.has(doc.slug),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: `Could not reach MongoDB: ${err.message}` });
  }
});

app.get("/api/universities/:slug", async (req, res) => {
  const { slug } = req.params;
  try {
    const { init, info } = await db.connect();
    const config = await init.findOne({ slug });
    if (!config) {
      return res.status(404).json({ error: `Unknown university '${slug}'` });
    }

    const existingInfo = await info.findOne({ slug });
    if (existingInfo && existingInfo.generated_at) {
      return res.json(mergeConfigAndInfo(config, existingInfo));
    }

    const freshInfo = await runExtractor(config, false);
    res.json(mergeConfigAndInfo(config, freshInfo));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/universities/:slug/refresh", async (req, res) => {
  const { slug } = req.params;
  try {
    const { init } = await db.connect();
    const config = await init.findOne({ slug });
    if (!config) {
      return res.status(404).json({ error: `Unknown university '${slug}'` });
    }

    const freshInfo = await runExtractor(config, true);
    res.json(mergeConfigAndInfo(config, freshInfo));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Optional: keep every university's info current automatically for as
// long as this process stays running. Off by default -- set
// AUTO_REFRESH_HOURS in server/.env to enable it. For a schedule that
// doesn't depend on the server never restarting, use an OS scheduler
// (Task Scheduler/cron) to run `node refresh-all.js` instead -- see README.
function scheduleAutoRefresh() {
  if (!AUTO_REFRESH_HOURS || AUTO_REFRESH_HOURS <= 0) return;

  const intervalMs = AUTO_REFRESH_HOURS * 60 * 60 * 1000;
  console.log(`Auto-refresh enabled: all universities every ${AUTO_REFRESH_HOURS}h while this server runs.`);

  setInterval(() => {
    console.log(`\n[auto-refresh] Starting scheduled refresh of all universities...`);
    refreshAll()
      .then(({ succeeded, failed }) => {
        console.log(`[auto-refresh] Done -- ${succeeded.length} succeeded, ${failed.length} failed.`);
      })
      .catch((err) => {
        console.error(`[auto-refresh] Failed: ${err.message}`);
      });
  }, intervalMs);
}

async function start() {
  try {
    await db.connect();
    console.log(
      `Connected to MongoDB -- ${db.DB_NAME}.${db.INIT_COLLECTION_NAME} + ${db.DB_NAME}.${db.INFO_COLLECTION_NAME} (${db.MONGODB_URI})`
    );
  } catch (err) {
    console.error(`Could not connect to MongoDB at ${db.MONGODB_URI}: ${err.message}`);
    console.error("Is MongoDB running? Set MONGODB_URI in server/.env if it's not on the default local address.");
    process.exit(1);
  }

  scheduleAutoRefresh();

  app.listen(PORT, () => {
    console.log(`BilimLaunch server running at http://localhost:${PORT}`);
    console.log(`Using Python: ${PYTHON_BIN} (override with the PYTHON_BIN env var)`);
  });
}

start();