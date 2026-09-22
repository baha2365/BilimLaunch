const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "../frontend");
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "universities.json");
const CACHE_DIR = path.join(DATA_DIR, "cache");
const EXTRACT_SCRIPT = path.join(ROOT, "scraper", "extract.py");

// Windows installs usually expose "python", not "python3" -- override with
// the PYTHON_BIN env var if neither guess is right for your machine.
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(ROOT));

fs.mkdirSync(CACHE_DIR, { recursive: true });

function loadUniversities() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function cachePath(slug) {
  return path.join(CACHE_DIR, `${slug}.json`);
}

function readCache(slug) {
  const file = cachePath(slug);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

// Keyed by slug (or "slug:force"), so two requests for the same
// not-yet-cached university share one Python process instead of each
// spawning their own scrape + local-model run.
const inFlight = new Map();

function runExtractor(slug, force) {
  const key = force ? `${slug}:force` : slug;
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = new Promise((resolve, reject) => {
    const args = [EXTRACT_SCRIPT, slug];
    if (force) args.push("--force");

    const child = spawn(PYTHON_BIN, args, { cwd: ROOT });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stdout.write(`[${slug}] ${text}`);
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
      const result = readCache(slug);
      if (!result) {
        reject(new Error("extract.py finished but no cache file was written."));
        return;
      }
      resolve(result);
    });
  }).finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);
  return promise;
}

app.get("/api/universities", (req, res) => {
  const universities = loadUniversities().map((uni) => ({
    slug: uni.slug,
    name: uni.name,
    shortName: uni.shortName,
    country: uni.country,
    city: uni.city,
    cached: fs.existsSync(cachePath(uni.slug)),
  }));
  res.json(universities);
});

app.get("/api/universities/:slug", async (req, res) => {
  const { slug } = req.params;
  const universities = loadUniversities();
  if (!universities.some((u) => u.slug === slug)) {
    return res.status(404).json({ error: `Unknown university '${slug}'` });
  }

  const cached = readCache(slug);
  if (cached) return res.json(cached);

  try {
    const result = await runExtractor(slug, false);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/universities/:slug/refresh", async (req, res) => {
  const { slug } = req.params;
  const universities = loadUniversities();
  if (!universities.some((u) => u.slug === slug)) {
    return res.status(404).json({ error: `Unknown university '${slug}'` });
  }

  try {
    const result = await runExtractor(slug, true);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`BilimLaunch server running at http://localhost:${PORT}`);
  console.log(`Using Python: ${PYTHON_BIN} (override with the PYTHON_BIN env var)`);
});