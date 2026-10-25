require("dotenv").config();

const express = require("express");
const path = require("path");
const db = require("./Db");
const { generateAndSave, DEGREES } = require("./universities");
const { PYTHON_BIN } = require("./extractor");
const { refreshAll } = require("./refresh_all");
const { runMatch } = require("./matcher");
const { runPythonScript } = require("./python");
const { closeBrowser } = require("./scrape");
const { createAdminRouter } = require("./admin");
const { lookupAdmission } = require("./admission");
const cookieParser = require("cookie-parser");
const pg = require("./pg");
const authCfg = require("./auth/config");
const { createAuthRouter, createMeRouter } = require("./auth/router");
const { requireAuth, requireAdmin } = require("./auth/middleware");
const { getProfile } = require("./auth/profile");
const users = require("./auth/users");

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
app.disable("x-powered-by");
// Behind a proxy / load balancer (Render, Railway, Fly...), set TRUST_PROXY=1 so
// rate limits and secure cookies see the real client address and https.
if (process.env.TRUST_PROXY) {
  app.set("trust proxy", /^\d+$/.test(process.env.TRUST_PROXY) ? parseInt(process.env.TRUST_PROXY, 10) : process.env.TRUST_PROXY);
}
// Browser security headers. The Content-Security-Policy only lets the page run
// scripts from this site, which blocks most cross-site-scripting attacks (and
// so the theft of login tokens). Set DISABLE_CSP=1 to switch it off if it ever
// blocks something you added on purpose.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  if (!process.env.DISABLE_CSP) res.set("Content-Security-Policy", CSP);
  if (authCfg.COOKIE_SECURE) res.set("Strict-Transport-Security", "max-age=15552000");
  // Account and admin data must never be kept in a browser or proxy cache.
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "400kb" }));
app.use(cookieParser());

app.use("/api/admin", createAdminRouter(db, DEGREES));
app.use("/api/auth", createAuthRouter());
app.use("/api/me", createMeRouter());

// Everything below needs a signed-in user (a valid access token).
app.use(["/api/universities", "/api/match", "/api/letter"], requireAuth);

// The profile fields that reach the matcher and the letter model. They now
// come from the signed-in user's row in PostgreSQL, never from the request;
// this still whitelists + length-caps them on the way through.
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
        const offeredDegrees = DEGREES.filter((d) => (sourceUrls[d] && sourceUrls[d].length) || availableDegrees.includes(d));
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

app.post("/api/universities/:slug/:degree/refresh", requireAdmin, async (req, res) => {
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
  let profile;
  try {
    const stored = await getProfile(pg, req.auth.userId);
    if (!stored.completed) {
      return res.status(409).json({ error: "Complete your profile first, then try again.", code: "profile_incomplete" });
    }
    profile = sanitizeProfile(stored.profile);
  } catch (err) {
    return res.status(503).json({ error: "Could not load your profile right now. Please try again shortly." });
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

      const admission = lookupAdmission(config);
      const uni = {
        slug: config.slug,
        name: config.name,
        country: config.country,
        city: config.city,
        // How selective the university is (percent admitted, or a difficulty
        // band); match.py uses it to rank very hard universities last.
        acceptance_rate: admission.acceptance_rate,
        difficulty: admission.difficulty,
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

// Motivation letter for one chosen university. The client sends the profile
// plus the answers to the questions asked just before writing; the
// university facts come from our own database, never from the client.
const ANSWER_FIELDS = ["goal", "goalOther", "whyField", "whyUniversity", "contribution", "highlight"];
const GOALS = ["Work in an international company", "Develop my own startup", "Conduct scientific research", "Other goal"];

app.post("/api/letter", async (req, res) => {
  const body = req.body || {};
  let profile;
  let applicantName = "";
  try {
    const account = await users.findById(pg, req.auth.userId);
    if (!account) return res.status(401).json({ error: "Please sign in again.", code: "invalid_token" });
    profile = sanitizeProfile((await getProfile(pg, account.id)).profile);
    applicantName = account.full_name.slice(0, 80);
  } catch (err) {
    return res.status(503).json({ error: "Could not load your profile right now. Please try again shortly." });
  }
  const answers = {};
  for (const key of ANSWER_FIELDS) {
    const value = body.answers && body.answers[key];
    if (typeof value === "string" && value.trim()) answers[key] = value.trim().slice(0, 1500);
  }

  if (!GOALS.includes(answers.goal)) return res.status(400).json({ error: "Please choose your goal after graduation." });
  if (answers.goal === "Other goal") {
    if (!answers.goalOther) return res.status(400).json({ error: "Please describe your goal." });
    answers.goal = answers.goalOther;
  }
  delete answers.goalOther;
  if (!answers.whyUniversity || answers.whyUniversity.length < 15) {
    return res.status(400).json({ error: "Please tell us why you chose this university (a sentence or two)." });
  }
  if (!answers.contribution || answers.contribution.length < 15) {
    return res.status(400).json({ error: "Please tell us what you could contribute to the university community." });
  }

  const slug = typeof body.slug === "string" ? body.slug : "";
  const degree = DEGREES.includes(body.degree) ? body.degree : mapTargetDegreeToKey(profile.targetDegree) || "bachelor";

  try {
    const { init, info } = await db.connect();
    const config = await init.findOne({ slug });
    if (!config) return res.status(404).json({ error: `Unknown university '${slug}'` });
    const doc = await info.findOne({ slug });
    const program = (doc && doc.programs && doc.programs[degree]) || {};

    const result = await runPythonScript(
      "letter.py",
      {
        profile,
        answers,
        applicant_name: applicantName,
        university: {
          name: config.name,
          city: config.city,
          country: config.country,
          degree_level: DEGREE_LABELS[degree] || degree,
          fields_of_study: program.fields_of_study || [],
        },
      },
      "letter"
    );
    res.json({ ...result, slug, university: config.name, degree });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.use(express.static(ROOT, { dotfiles: "ignore" }));

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
      `Connected to MongoDB -- ${db.DB_NAME}.${db.INIT_COLLECTION_NAME} + ${db.DB_NAME}.${db.INFO_COLLECTION_NAME} (${db.safeUri()})`
    );
  } catch (err) {
    console.error(`Could not connect to MongoDB at ${db.safeUri()}: ${err.message}`);
    console.error("Set MONGODB_ATLAS_URI in server/.env (ask an admin for it), or run a local MongoDB.");
    process.exit(1);
  }

  try {
    await pg.query("SELECT 1 FROM users LIMIT 0");
    console.log(`Connected to PostgreSQL (${pg.safeUrl()})`);
  } catch (err) {
    const missingTables = err && err.code === "42P01";
    console.error(
      missingTables
        ? "PostgreSQL is reachable but the account tables don't exist yet. Run:  node migrate-pg.js"
        : `Could not use PostgreSQL at ${pg.safeUrl() || "(DATABASE_URL not set)"}: ${pg.explainError(err)}`
    );
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
