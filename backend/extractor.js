const { runPythonScript, PYTHON_BIN } = require("./python");

/**
 * Runs scraper/extract.py for one university config ({slug, name,
 * sourceUrls}) and resolves with the extracted JSON. Knows nothing about
 * MongoDB or caching -- just "config in, extracted JSON out".
 */
function runExtraction(config) {
  return runPythonScript(
    "extract.py",
    { slug: config.slug, name: config.name, sourceUrls: config.sourceUrls },
    config.slug
  );
}

module.exports = { runExtraction, PYTHON_BIN };