const { runPythonScript } = require("./python");

/**
 * Runs scraper/match.py: ranks the given discovered universities for the
 * given student profile. `universities` is an array of merged
 * config + info objects (slug, name, tuition, scholarships, ...).
 */
function runMatch(profile, universities) {
  return runPythonScript("match.py", { profile, universities }, "match");
}

module.exports = { runMatch };