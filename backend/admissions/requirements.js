/*
 * Turns the entry requirements scraped for one university programme
 * (universities_info.programs.<degree>.requirements) into a list of
 * normalized requirement items, and compares that list with a student.
 *
 * Nothing here calls a model: the numbers come straight from the scraped data
 * and the student's profile, so the gap analysis is reproducible and never
 * "hallucinates" a requirement.
 *
 * A requirement item looks like:
 *   { key, type: "gpa"|"language"|"test"|"document", label, required,
 *     min?, ieltsMin?, tests?, optional?, kind?, count? }
 * and a gap row (the result of comparing it with the student) like:
 *   { key, type, label, required, student, status, note }
 *   status: "met" | "missing" | "unknown" | "optional"
 */

const MAX_GPA_SCALE = 4.3;
const OTHER_SCALE_RE = /(out of|\/|scale)\s*(5|10|100)\b|percent|%|first[- ]class|\b[12]:[12]\b|2:1|2:2/i;
const IELTS_RE = /ielts[^0-9]{0,40}?(\d(?:\.\d)?)/i;
const OPTIONAL_RE = /\b(optional|not required|no longer required|waived|test[- ]optional|not needed|recommended but)\b/i;

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5 };

// Order matters: the first matching kind wins ("research proposal" must not become a statement of purpose).
const DOCUMENT_KINDS = [
  ["language", /english (language )?(test|proficiency|certificate)|proof of english|ielts|toefl|duolingo|language (test|certificate|proficiency)/i],
  ["proposal", /research (proposal|plan|statement)|project proposal/i],
  ["recommendation", /recommend|reference|referee/i],
  ["transcript", /transcript|academic record|grade (report|sheet)|marksheet|record of (grades|marks)/i],
  ["diploma", /diploma|degree certificate|graduation certificate|certificate of graduation|degree award/i],
  ["cv", /\bcv\b|curriculum vitae|r[eé]sum[eé]/i],
  ["sop", /statement of purpose|personal statement|motivation|cover letter|essay|letter of intent|purpose/i],
  ["passport", /passport|identity (document|card)|id card|identification/i],
  ["portfolio", /portfolio|work sample|writing sample|audition/i],
  ["financial", /financ|bank statement|proof of funds|funding|sponsor/i],
];

const STANDARDIZED = ["SAT", "ACT", "GRE", "GMAT", "LSAT", "MCAT", "TMUA", "BMAT", "UCAT", "STEP", "TSA", "LNAT", "PAT"];

function text(value, max = 300) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
}

function parseNumber(value) {
  const m = String(value == null ? "" : value).replace(",", ".").match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function documentKind(label) {
  for (const [kind, re] of DOCUMENT_KINDS) if (re.test(label)) return kind;
  return "other";
}

function countFromLabel(label) {
  const digit = label.match(/\b(\d)\b/);
  if (digit) return Number(digit[1]);
  const word = label.toLowerCase().match(/\b(one|two|three|four|five)\b/);
  return word ? NUMBER_WORDS[word[1]] : null;
}

function languageTestName(entry) {
  const m = entry.match(/ielts|toefl|duolingo|pte|cambridge|c1 advanced|c2 proficiency|oxford test|linguaskill/i);
  return m ? m[0].toUpperCase() : entry;
}

/** Normalized requirement items for one programme (see the header comment). */
function buildRequirements(programRequirements) {
  const req = programRequirements && typeof programRequirements === "object" ? programRequirements : {};
  const items = [];

  // GPA
  const rawGpa = text(req.minimum_gpa);
  if (rawGpa) {
    const value = parseNumber(rawGpa);
    const comparable = !OTHER_SCALE_RE.test(rawGpa) && value != null && value >= 1 && value <= MAX_GPA_SCALE;
    items.push({ key: "gpa", type: "gpa", label: "Minimum GPA", required: rawGpa, min: comparable ? value : null });
  }

  // English / language tests: one item, because a student only needs to pass one of them.
  const languages = (Array.isArray(req.language_tests) ? req.language_tests : []).map((e) => text(e)).filter(Boolean).slice(0, 8);
  if (languages.length) {
    const ielts = languages
      .map((e) => IELTS_RE.exec(e))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .filter((v) => v >= 4 && v <= 9);
    items.push({
      key: "language",
      type: "language",
      label: "English proficiency",
      required: languages.join(" · "),
      // Universities often list several levels; the lowest one is what a student must reach to be considered at all.
      ieltsMin: ielts.length ? Math.min(...ielts) : null,
      tests: [...new Set(languages.map(languageTestName))],
    });
  }

  // Standardized tests (SAT, GRE, ...)
  const seen = new Set();
  for (const entry of (Array.isArray(req.standardized_tests) ? req.standardized_tests : []).slice(0, 8)) {
    const label = text(entry);
    if (!label) continue;
    const known = STANDARDIZED.find((t) => new RegExp(`\\b${t}\\b`).test(label.toUpperCase()));
    const key = `test.${slugify(known || label)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, type: "test", label: known || label, required: label, optional: OPTIONAL_RE.test(label) });
  }

  // Documents
  const kinds = new Set();
  for (const entry of (Array.isArray(req.required_documents) ? req.required_documents : []).slice(0, 20)) {
    const label = text(entry);
    if (!label) continue;
    const kind = documentKind(label);
    if (kind === "language") continue; // covered by the English proficiency item
    const key = kind === "other" ? `doc.other.${slugify(label)}` : `doc.${kind}`;
    if (kinds.has(key)) continue;
    kinds.add(key);
    items.push({
      key,
      type: "document",
      kind,
      label: label.charAt(0).toUpperCase() + label.slice(1),
      required: label,
      optional: OPTIONAL_RE.test(label),
      count: kind === "recommendation" ? countFromLabel(label) : null,
    });
  }

  return items;
}

/** The student's rows for the gap table. `doneByRequirement` maps requirement key -> true when its roadmap task is ticked. */
function evaluateGap(requirements, profile, doneByRequirement = {}) {
  const p = profile || {};
  const gpa = parseNumber(p.gpa);
  const ielts = parseNumber(p.ielts);

  return (requirements || []).map((item) => {
    const row = { key: item.key, type: item.type, label: item.label, required: item.required, student: "", status: "unknown", note: "" };
    const ticked = !!doneByRequirement[item.key];

    if (item.type === "gpa") {
      row.student = gpa != null ? String(gpa) : "Not in your profile";
      if (gpa == null) {
        row.status = "missing";
        row.note = "Add your GPA on the profile page.";
      } else if (item.min == null) {
        row.status = "unknown";
        row.note = "The university states this on a different scale. Convert yours and confirm on the official page.";
      } else if (gpa >= item.min) {
        row.status = "met";
      } else {
        row.status = "missing";
        row.note = `${(item.min - gpa).toFixed(2).replace(/\.?0+$/, "")} below the stated minimum.`;
      }
    } else if (item.type === "language") {
      row.student = ielts != null ? `IELTS ${ielts}` : "No test score yet";
      if (item.ieltsMin != null) {
        if (ielts != null && ielts >= item.ieltsMin) {
          row.status = "met";
        } else if (ticked) {
          row.status = "met";
          row.note = "Marked as done in your roadmap.";
        } else {
          row.status = "missing";
          row.note = ielts == null ? "Add your IELTS score to your profile once you have it." : `${(item.ieltsMin - ielts).toFixed(1).replace(/\.0$/, "")} below the lowest IELTS level listed.`;
        }
      } else if (ticked) {
        row.status = "met";
        row.note = "Marked as done in your roadmap.";
      } else if (ielts != null) {
        row.status = "unknown";
        row.note = `The university lists ${item.tests.join(", ")}. Check whether IELTS is accepted.`;
      } else {
        row.status = "missing";
      }
    } else {
      // Tests and documents are not part of the profile: they count once the student ticks the roadmap task.
      row.student = ticked ? "Done" : "Not done yet";
      if (ticked) row.status = "met";
      else row.status = item.optional ? "optional" : "missing";
      if (item.type === "document" && item.kind === "recommendation" && item.count && !ticked) row.note = `${item.count} needed.`;
    }
    return row;
  });
}

function summarizeGap(rows) {
  const out = { met: 0, missing: 0, unknown: 0, optional: 0, total: rows.length };
  for (const r of rows) out[r.status] += 1;
  return out;
}

module.exports = { buildRequirements, evaluateGap, summarizeGap, parseNumber, documentKind };
