const { runPythonScript, PYTHON_BIN } = require("./python");

/**
 * Runs scraper/extract.py for ONE university's ONE degree level
 * ({slug, name, degree, sourceUrls}) and resolves with the extracted
 * program JSON. Knows nothing about MongoDB or caching -- just "config in,
 * extracted JSON out".
 */
function runExtraction(payload) {
  return runPythonScript("extract.py", payload, `${payload.slug}:${payload.degree}`);
}

module.exports = { runExtraction, PYTHON_BIN };