const { runPythonScript, PYTHON_BIN } = require("./python");

/**
 * Runs scraper/extract.py for ONE university's ONE degree level
 * ({slug, name, degree, pages: [{url, text}, ...]}) and resolves with the
 * extracted program JSON. `pages` must already be scraped (see
 * server/scrape.js) -- extract.py no longer fetches pages itself. Knows
 * nothing about MongoDB or caching -- just "config + scraped text in,
 * extracted JSON out".
 */
function runExtraction(payload) {
  return runPythonScript("extract.py", payload, `${payload.slug}:${payload.degree}`);
}

module.exports = { runExtraction, PYTHON_BIN };