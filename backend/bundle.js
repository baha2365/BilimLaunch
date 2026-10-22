/**
 * Turns a "university bundle" (a JSON file with, for each university, its
 * details AND its programme data) into documents ready for MongoDB.
 * Pure functions, no database -- so a bundle can be checked with --dry-run
 * and tested without a connection.
 *
 * Bundle format -- a JSON array (or { "universities": [...] }) of:
 * {
 *   "name": "University of Copenhagen",          required
 *   "country": "Denmark",                        required
 *   "slug": "copenhagen",                        optional (made from the name)
 *   "shortName": "Copenhagen", "city": "Copenhagen",
 *   "officialSite": "https://www.ku.dk",
 *   "acceptanceRate": 35,                        optional, percent (see README)
 *   "sourceUrls": { "bachelor": [...] },         optional, pages for automatic scraping
 *   "fieldUrls":  { "bachelor": [...] },         optional
 *   "programs": {                                optional, one entry per degree level
 *     "bachelor": { same fields as the admin panel form:
 *        tuition{domestic_or_home, international, notes},
 *        requirements{minimum_gpa, language_tests[], standardized_tests[], required_documents[], other},
 *        scholarships[{name, eligibility, amount, deadline}], financial_aid_summary,
 *        key_deadlines[], notes, fields_of_study[], sources[] }
 *   }
 * }
 * Everything goes through the same sanitisers the admin panel uses, so imported
 * data has exactly the shape the app reads.
 */
const { sanitizeNewUniversity, sanitizeProgram } = require("./admin");

const DEGREES = ["bachelor", "master", "doctorate", "exchange"];

function programWarnings(program) {
  const w = [];
  const t = program.tuition;
  if (!t.international && !t.domestic_or_home) w.push("no tuition");
  if (!program.requirements.language_tests.length) w.push("no language requirement");
  if (!program.sources.length) w.push("no source URLs");
  if (!program.fields_of_study.length) w.push("no programme list");
  if (!program.key_deadlines.length) w.push("no deadlines");
  return w;
}

/**
 * @param {any} raw        parsed bundle JSON
 * @param {{date?: string, now?: string}} opts
 * @returns {{ items: Array<{config, programs, warnings:string[]}>, errors: string[] }}
 */
function prepareBundle(raw, opts = {}) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.universities) ? raw.universities : null;
  if (!list) return { items: [], errors: ['The file must be a JSON array of universities (or {"universities": [...]}).'] };

  const now = opts.now || new Date().toISOString();
  const date = opts.date || now.slice(0, 10);
  const errors = [];
  const items = [];
  const seen = new Set();

  list.forEach((entry, i) => {
    const label = `#${i + 1} ${entry && (entry.name || entry.slug) ? entry.name || entry.slug : "(no name)"}`;
    if (!entry || typeof entry !== "object") return errors.push(`${label}: not an object`);
    let config;
    try {
      config = sanitizeNewUniversity(entry, DEGREES);
    } catch (err) {
      return errors.push(`${label}: ${err.message}`);
    }
    if (seen.has(config.slug)) return errors.push(`${label}: the ID '${config.slug}' appears twice in the file`);
    seen.add(config.slug);

    const programs = {};
    const warnings = [];
    for (const [degree, rawProgram] of Object.entries(entry.programs || {})) {
      if (!DEGREES.includes(degree)) {
        errors.push(`${label}: unknown degree level '${degree}' (use ${DEGREES.join(", ")})`);
        continue;
      }
      if (!rawProgram || typeof rawProgram !== "object") {
        errors.push(`${label}: programs.${degree} is not an object`);
        continue;
      }
      const program = {
        ...sanitizeProgram({ manual: true, ...rawProgram }, degree),
        generated_at: now,
        edited_at: now,
        model: "manual-research",
        research_date: typeof rawProgram.research_date === "string" && rawProgram.research_date ? rawProgram.research_date.slice(0, 10) : date,
        fields_sources: [],
      };
      programs[degree] = program;
      const w = programWarnings(program);
      if (w.length) warnings.push(`${degree}: ${w.join(", ")}`);
    }
    if (!Object.keys(programs).length) warnings.push("no programme data (only the university details will be added)");
    items.push({ config, programs, warnings });
  });

  return { items, errors };
}

module.exports = { prepareBundle, DEGREES };