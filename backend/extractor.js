const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "../frontend");
const EXTRACT_SCRIPT = path.join(ROOT, "scraper", "extract.py");

// Windows installs usually expose "python", not "python3" -- override with
// the PYTHON_BIN env var if neither guess is right for your machine.
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");

/**
 * Runs scraper/extract.py for one university config ({slug, name,
 * sourceUrls}) and resolves with the extracted JSON. Knows nothing about
 * MongoDB or caching -- just "config in, extracted JSON out" over stdin/stdout.
 */
function runExtraction(config) {
  return new Promise((resolve, reject) => {
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
        // produces) so callers don't have to show a whole log dump.
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

    child.stdin.write(JSON.stringify({ slug: config.slug, name: config.name, sourceUrls: config.sourceUrls }));
    child.stdin.end();
  });
}

module.exports = { runExtraction, PYTHON_BIN };