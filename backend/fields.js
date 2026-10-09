/**
 * Cleans a scraped list of programme names. Used when saving a list and by
 * `npm run clean-fields` (which repairs lists already stored in MongoDB).
 * Removes page furniture and, for bachelor lists, postgraduate courses.
 */
const NOISE = [
  /^(page|step)\s*\d+$/i, /^(yes|no)\b/i, /^filter/i, /^search/i, /^(next|previous|back|home|menu|contact)\b/i,
  /^(apply|log ?in|sign (up|in)|read more|learn more|find (out|your|a)|explore|plan your|visit|choosing|important notice|any questions|can't find|did you know|was this page|most popular|more |view |show |see )/i,
  /^(guide|application|admissions?|fees?|funding|scholarships?|financial (support|aid)|accommodation|news|events?|cookies?|privacy|accessibility|terms|undergraduate courses|summary table|courses that|which .* colleges|selection criteria|access )/i,
  /\b(a-z|az)\b/i, /\?$/, /@/, /^\d+\s+results?/i, /separate application/i, /\bcourses\b.*\(/i,
];
const POSTGRAD = /\b(PGCE|MSc|MPhil|DPhil|MRes|MBA|MSt|BCL|DClinPsych|EPSRC|CDT|PhD|DPhil)\b/;

function cleanFields(list, degree) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const text = String(raw || "").replace(/\s+/g, " ").trim();
    const key = text.toLowerCase();
    if (text.length < 3 || text.length > 70 || text.split(" ").length > 8) continue;
    if (seen.has(key) || NOISE.some((re) => re.test(text))) continue;
    if (degree === "bachelor" && POSTGRAD.test(text)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

module.exports = { cleanFields };