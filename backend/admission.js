/**
 * How hard is a university to get into? Used by the matcher so that extremely
 * selective universities don't top a student's recommendations.
 *
 * Two sources, in this order:
 *   1. config.acceptanceRate -- a number (percent) an admin typed in the admin
 *      panel for that university (stored in universities_init).
 *   2. data/admission_rates.json -- a small built-in table of well-known
 *      universities (approximate figures), matched by name / short name / slug.
 * Anything not found is simply "not rated": the matcher doesn't guess.
 */
const fs = require("fs");
const path = require("path");

const TABLE_PATH = path.join(__dirname, "../frontend", "data", "admission_rates.json");
const DIFFICULTIES = ["extreme", "high", "moderate", "accessible"];

/** "École Polytechnique Fédérale" -> "ecole polytechnique federale" */
function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

let aliasIndex = null;

function loadIndex() {
  if (aliasIndex) return aliasIndex;
  aliasIndex = new Map();
  try {
    const table = JSON.parse(fs.readFileSync(TABLE_PATH, "utf8"));
    for (const row of table.universities || []) {
      const entry = {
        acceptance_rate: typeof row.acceptance_rate === "number" ? row.acceptance_rate : null,
        difficulty: DIFFICULTIES.includes(row.difficulty) ? row.difficulty : null,
      };
      for (const alias of row.aliases || []) aliasIndex.set(normalize(alias), entry);
    }
  } catch (err) {
    console.warn(`admission: could not read ${TABLE_PATH} (${err.message}); no universities will be rated.`);
  }
  return aliasIndex;
}

/** { acceptance_rate: number|null, difficulty: string|null, source: "admin"|"table"|null } */
function lookupAdmission(config) {
  const admin = config && config.acceptanceRate;
  if (typeof admin === "number" && admin >= 0 && admin <= 100) {
    return { acceptance_rate: admin, difficulty: null, source: "admin" };
  }
  const index = loadIndex();
  for (const key of [config && config.slug, config && config.name, config && config.shortName]) {
    const hit = index.get(normalize(key));
    if (hit) return { ...hit, source: "table" };
  }
  return { acceptance_rate: null, difficulty: null, source: null };
}

module.exports = { lookupAdmission, normalize };