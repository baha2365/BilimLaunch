const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "../frontend");

// Windows installs usually expose "python", not "python3" -- override with
// the PYTHON_BIN env var if neither guess is right for your machine.
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");

/**
 * Runs one of the stateless scripts in scraper/ (extract.py, match.py):
 * writes `payload` as JSON to its stdin, resolves with the JSON it prints
 * to stdout. Neither script knows MongoDB exists -- persistence and input
 * gathering stay in Node.
 *
 * `label` only prefixes the console log lines so concurrent runs are
 * distinguishable.
 */
function runPythonScript(scriptName, payload, label) {
  const scriptPath = path.join(ROOT, "scraper", scriptName);

  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [scriptPath], { cwd: ROOT });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stdout.write(`[${label}] ${text}`);
    });

    child.on("error", (err) => {
      reject(new Error(`Could not start "${PYTHON_BIN}": ${err.message}. Set PYTHON_BIN if your Python is named differently.`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        // Full log already went to the console above; surface just the
        // clearest line (the script's own "Failed: ..." message) so
        // callers don't have to show a whole log dump.
        const lines = stderr.trim().split("\n").filter(Boolean);
        const failureLine = [...lines].reverse().find((l) => l.includes("Failed:")) || lines[lines.length - 1];
        const message = failureLine
          ? failureLine.replace(/^\[\w+\]\s*/, "")
          : `${scriptName} exited with code ${code}`;
        reject(new Error(message));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (err) {
        reject(new Error(`${scriptName} did not print valid JSON: ${err.message}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

module.exports = { runPythonScript, PYTHON_BIN };