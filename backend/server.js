require("dotenv").config();

const express = require("express");
const path = require("path");
const db = require("./db");
const { generateAndSave, DEGREES } = require("./universities");
const { PYTHON_BIN } = require("./extractor");
const { refreshAll } = require("./refresh_all");
const { runMatch } = require("./matcher");
const { closeBrowser } = require("./scrape");

const ROOT = path.join(__dirname, "../frontend");
const PORT = process.env.PORT || 3000;
const AUTO_REFRESH_HOURS = parseFloat(process.env.AUTO_REFRESH_HOURS || "0");

const DEGREE_LABELS = {
  bachelor: "Bachelor's / Undergraduate",
  master: "Master's / Graduate",
  doctorate: "PhD / Doctoral",
  exchange: "Exchange / study-abroad",
};

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

// Maps the free-text profile.targetDegree to one of our canonical degree
// keys, or null if it's unspecified / doesn't correspond to one (e.g. the
// profile form's "Internship" option has no matching degree level here).
function mapTargetDegreeToKey(targetDegree) {
  const text = (targetDegree || "").toLowerCase();
  if (text.includes("bachelor")) return "bachelor";
  if (text.includes("master")) return "master";
  if (text.includes("phd") || text.includes("doctor")) return "doctorate";
  if (text.includes("exchange")) return "exchange";
  return null;
}

function withoutId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return rest;
}

// Keyed by "slug:degree" (or "slug:degree:force"), so two requests for the
// same not-yet-generated program share one Python process + one Mongo
// write instead of each spawning their own scrape + local-model run.
const inFlight = new Map();

function runExtractor(config, degree, force) {
  const key = force ? `${config.slug}:${degree}:force` : `${config.slug}:${degree}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const tracked = generateAndSave(config, degree).finally(() => inFlight.delete(key));
  inFlight.set(key, tracked);
  return tracked;
}

app.get("/api/universities", async (req, res) => {
  try {
    const { init, info } = await db.connect();
    const configs = await init.find({}).toArray();
    const infos = await info.find({}).toArray();
    const infoBySlug = new Map(infos.map((doc) => [doc.slug, doc]));

    res.json(
      configs.map((doc) => {
        const programs = (infoBySlug.get(doc.slug) || {}).programs || {};
        const sourceUrls = doc.sourceUrls || {};
        const availableDegrees = DEGREES.filter((d) => programs[d] && programs[d].generated_at);
        const offeredDegrees = DEGREES.filter((d) => sourceUrls[d] && sourceUrls[d].length);
        return {
          slug: doc.slug,
          name: doc.name,
          shortName: doc.shortName,
          country: doc.country,
          city: doc.city,
          cached: availableDegrees.length > 0,
          availableDegrees,
          offeredDegrees,
        };
      })
    );
  } catch (err) {
    res.status(500).json({ error: `Could not reach MongoDB: ${err.message}` });
  }
});

// Pure read: the config plus whatever programs already exist. Never
// triggers scraping/generation itself -- the frontend calls the
// per-degree route below (lazily, per tab) for that.
app.get("/api/universities/:slug", async (req, res) => {
  const { slug } = req.params;
  try {
    const { init, info } = await db.connect();
    const config = await init.findOne({ slug });
    if (!config) {
      return res.status(404).json({ error: `Unknown university '${slug}'` });
    }
    const doc = await info.findOne({ slug });
    res.json({ ...withoutId(config), programs: (doc && doc.programs) || {} });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/universities/:slug/:degree", async (req, res) => {
  const { slug, degree } = req.params;
  if (!DEGREES.includes(degree)) {
    return res.status(400).json({ error: `Unknown degree level '${degree}'` });
  }
  try {
    const { init, info } = await db.connect();
    const config = await init.findOne({ slug });
    if (!config) {
      return res.status(404).json({ error: `Unknown university '${slug}'` });
    }

    const doc = await info.findOne({ slug });
    const existing = doc && doc.programs && doc.programs[degree];
    if (existing && existing.generated_at) {
      return res.json(existing);
    }

    const result = await runExtractor(config, degree, false);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/universities/:slug/:degree/refresh", async (req, res) => {
  const { slug, degree } = req.params;
  if (!DEGREES.includes(degree)) {
    return res.status(400).json({ error: `Unknown degree level '${degree}'` });
  }
  try {
    const { init } = await db.connect();
    const config = await init.findOne({ slug });
    if (!config) {
      return res.status(404).json({ error: `Unknown university '${slug}'` });
    }
    const result = await runExtractor(config, degree, true);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// "Find My Match": ranks every *discovered* university (one with generated
// data for the relevant degree level) against the profile in the request
// body. If the student named a target degree, only that degree level's
// data is considered per university; otherwise whichever degree level
// happens to be available is used as that university's representative data.
app.post("/api/match", async (req, res) => {
  const profile = sanitizeProfile(req.body && req.body.profile);
  if (!Object.keys(profile).length) {
    return res.status(400).json({ error: "Fill in at least part of your profile first, then try again." });
  }

  const wantedDegree = mapTargetDegreeToKey(profile.targetDegree);

  try {
    const { init, info } = await db.connect();
    const [configs, infos] = await Promise.all([init.find({}).toArray(), info.find({}).toArray()]);
    const infoBySlug = new Map(infos.map((doc) => [doc.slug, doc]));

    const universities = [];
    const bySlug = new Map();
    for (const config of configs) {
      const programs = (infoBySlug.get(config.slug) || {}).programs || {};

      let degree;
      let program;
      if (wantedDegree) {
        degree = wantedDegree;
        program = programs[wantedDegree];
      } else {
        // No target degree specified -- show whichever program this
        // university actually has, preferring bachelor's as the most
        // commonly relevant default when there's a choice.
        degree = DEGREES.find((d) => programs[d] && programs[d].generated_at);
        program = degree ? programs[degree] : null;
      }

      if (!program || !program.generated_at) continue;

      const uni = {
        slug: config.slug,
        name: config.name,
        country: config.country,
        city: config.city,
        degree,
        degree_level: DEGREE_LABELS[degree] || degree,
        // True by construction: we only got here because this IS the
        // program for the degree the student asked for (or, if they
        // didn't ask, there's nothing to mismatch -- see compute_facts
        // in match.py, which treats this as "unspecified" in that case).
        degree_match: wantedDegree ? true : null,
        tuition: program.tuition,
        requirements: program.requirements,
        scholarships: program.scholarships,
        financial_aid_summary: program.financial_aid_summary,
        key_deadlines: program.key_deadlines,
        notes: program.notes,
        sources: program.sources,
        fields_of_study: program.fields_of_study,
        fields_sources: program.fields_sources,
      };
      universities.push(uni);
      bySlug.set(config.slug, uni);
    }

    if (!universities.length) {
      return res.status(409).json({
        error: wantedDegree
          ? `No universities have ${DEGREE_LABELS[wantedDegree]} data yet. Open a university's ${wantedDegree} tab first, or try a different target degree.`
          : "No universities have been analyzed yet. Open at least one university's page first so there's data to match against.",
      });
    }

    const result = await runMatch(profile, universities);

    // Names/locations/degree come from our own data, not from whatever the
    // model echoed back. match.py already filtered out non-matching
    // universities (see its is_match()) -- recommendations here are
    // matches only, and excluded carries just enough (name + reason) for a
    // one-line note.
    res.json({
      ...result,
      compared_count: universities.length,
      recommendations: result.recommendations.map((rec) => {
        const uni = bySlug.get(rec.slug);
        return { ...rec, name: uni.name, country: uni.country, city: uni.city, degree: uni.degree, degree_level: uni.degree_level };
      }),
      excluded: (result.excluded || []).map((ex) => {
        const uni = bySlug.get(ex.slug);
        return { ...ex, name: uni ? uni.name : ex.slug };
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

// The server keeps one Puppeteer browser instance alive across requests
// (see scrape.js) rather than launching a new one per page -- close it on
// Ctrl+C / process termination so Chromium doesn't linger as an orphaned
// process after the server exits.
async function shutdown() {
  console.log("\nShutting down...");
  await closeBrowser().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();