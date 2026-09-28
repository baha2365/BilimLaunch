require("dotenv").config();

const express = require("express");
const path = require("path");
const db = require("./Db");
const { generateAndSave } = require("./universities");
const { PYTHON_BIN } = require("./python");
const { refreshAll } = require("./refresh_all");
const { runMatch } = require("./matcher");

const ROOT = path.join(__dirname, "../frontend");
const PORT = process.env.PORT || 3000;
const AUTO_REFRESH_HOURS = parseFloat(process.env.AUTO_REFRESH_HOURS || "0");

const app = express();
app.use(express.json({ limit: "50kb" }));
app.use(express.static(ROOT));

// The only profile fields that ever reach the model. The profile lives in
// the browser (localStorage) for now, so the client sends it with each
// match request -- whitelist + length-cap it here rather than trusting
// whatever arrives.
const PROFILE_FIELDS = [
  "country",
  "university",
  "fieldOfStudy",
  "currentYear",
  "gpa",
  "ielts",
  "targetDegree",
  "targetCountries",
  "extracurriculars",
];
const MAX_PROFILE_FIELD_CHARS = 1000;

function sanitizeProfile(raw) {
  const clean = {};
  if (!raw || typeof raw !== "object") return clean;
  for (const key of PROFILE_FIELDS) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) {
      clean[key] = value.trim().slice(0, MAX_PROFILE_FIELD_CHARS);
    }
  }
  return clean;
}

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

// "Find My Match": ranks every *discovered* university (one that's been
// scraped + LLM-extracted, i.e. has generated_at in universities_info)
// against the profile in the request body. Universities nobody has opened
// yet have no data to compare, so they're never candidates.
app.post("/api/match", async (req, res) => {
  const profile = sanitizeProfile(req.body && req.body.profile);
  if (!Object.keys(profile).length) {
    return res.status(400).json({ error: "Fill in at least part of your profile first, then try again." });
  }

  try {
    const { init, info } = await db.connect();
    const [configs, infos] = await Promise.all([init.find({}).toArray(), info.find({}).toArray()]);
    const configBySlug = new Map(configs.map((c) => [c.slug, c]));

    const universities = infos
      .filter((doc) => doc.generated_at && configBySlug.has(doc.slug))
      .map((doc) => {
        const config = configBySlug.get(doc.slug);
        return {
          slug: doc.slug,
          name: config.name,
          country: config.country,
          city: config.city,
          degree_level: doc.degree_level,
          tuition: doc.tuition,
          scholarships: doc.scholarships,
          financial_aid_summary: doc.financial_aid_summary,
          key_deadlines: doc.key_deadlines,
          notes: doc.notes,
        };
      });

    if (!universities.length) {
      return res.status(409).json({
        error: "No universities have been analyzed yet. Open at least one university's page first so there's data to match against.",
      });
    }

    const result = await runMatch(profile, universities);
    const bySlug = new Map(universities.map((u) => [u.slug, u]));

    // Names/locations come from our own data, not from whatever the model
    // echoed back.
    res.json({
      ...result,
      compared_count: universities.length,
      recommendations: result.recommendations.map((rec) => {
        const uni = bySlug.get(rec.slug);
        return { ...rec, name: uni.name, country: uni.country, city: uni.city };
      }),
    });
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