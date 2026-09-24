require("dotenv").config();

const express = require("express");
const path = require("path");
const { spawn } = require("child_process");
const db = require("./Db");

const ROOT = path.join(__dirname, "../frontend");
const EXTRACT_SCRIPT = path.join(ROOT, "scraper", "extract.py");

// Windows installs usually expose "python", not "python3" -- override with
// the PYTHON_BIN env var if neither guess is right for your machine.
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
const PORT = process.env.PORT || 3000;

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

  const promise = new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [EXTRACT_SCRIPT], { cwd: ROOT });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stdout.write(`[${config.slug}] ${text}`);
    });

    child.on("error", (err) => {
      reject(new Error(`Could not start "${PYTHON_BIN}": ${err.message}. Set PYTHON_BIN if your Python is named differently.`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        // Full log already went to the console above; surface just the
        // clearest line (the one extract.py's own "Failed: ..." message
        // produces) so the frontend doesn't have to show a whole log dump.
        const lines = stderr.trim().split("\n").filter(Boolean);
        const failureLine = [...lines].reverse().find((l) => l.includes("Failed:")) || lines[lines.length - 1];
        const message = failureLine
          ? failureLine.replace(/^\[extract\]\s*/, "")
          : `extract.py exited with code ${code}`;
        reject(new Error(message));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (err) {
        reject(new Error(`extract.py did not print valid JSON: ${err.message}`));
      }
    });

    // Hand the university's config (slug, name, sourceUrls) to the
    // stateless Python script over stdin -- it never reads Mongo or any
    // local file itself.
    child.stdin.write(JSON.stringify({ slug: config.slug, name: config.name, sourceUrls: config.sourceUrls }));
    child.stdin.end();
  }).then(async (extracted) => {
    const { info } = await db.connect();
    // universities_info may not have a document for this slug yet, so
    // this upsert (unlike the config collection's) has to be allowed to
    // create one.
    await info.updateOne(
      { slug: config.slug },
      { $set: { slug: config.slug, ...extracted } },
      { upsert: true }
    );
    return info.findOne({ slug: config.slug });
  });

  const tracked = promise.finally(() => inFlight.delete(key));
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

  app.listen(PORT, () => {
    console.log(`BilimLaunch server running at http://localhost:${PORT}`);
    console.log(`Using Python: ${PYTHON_BIN} (override with the PYTHON_BIN env var)`);
  });
}

start();