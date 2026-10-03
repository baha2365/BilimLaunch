#!/usr/bin/env python3
"""
BilimLaunch -- profile-to-university matcher.

Stateless, like extract.py: reads {"profile": {...}, "universities": [...]}
as JSON on stdin -- the student's profile fields, and the already-scraped
tuition/scholarship info for every "discovered" university -- and prints a
ranked recommendation to stdout.

Design note (read this before changing the prompt): the LLM is NEVER asked
to decide the ranking or to judge whether a university "matches." Small
local models are not reliable at that -- they default to recommending
famous names (MIT, Harvard) regardless of the actual profile, and they
readily invent specifics ("offers a Master's in Medical fields") that
aren't in the data, especially about universities they have strong
pretrained opinions about. Two rules follow from that:

1. country_match / degree_match are computed here in Python, from the
   actual profile string and the actual university record. The LLM is
   given these as settled facts, not asked to work them out, and the
   final ranking (see rank_universities) is entirely code, not model
   output.
2. The LLM is only asked to phrase those settled facts into a sentence.
   Its output still passes through sanitize_summary() afterwards, which
   discards (and replaces with an auto-generated fallback) anything that
   claims a degree level other than the one that specific university's
   data is actually about (each university can be a different degree
   level now -- bachelor/master/doctorate/exchange, see
   forbidden_degree_pattern_for), or claims a specific field/major/program
   -- since we never scraped that data, any such claim is necessarily
   invented.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone

from ollama_client import call_ollama, DEFAULT_MODEL, DEFAULT_OLLAMA_URL

# Each university now carries its OWN actual degree level (bachelor/master/
# doctorate/exchange -- there's no longer one answer for "every university
# here"), so the forbidden-degree-words check has to be built per
# university: forbid every degree's keywords except the one this specific
# university's data is actually about.
DEGREE_KEYWORDS = {
    "bachelor": ["bachelor's", "bachelors", "bachelor", "undergraduate", "undergrad"],
    "master": ["master's", "masters", "master"],
    "doctorate": ["phd", "ph.d", "ph.d.", "doctorate", "doctoral"],
    "exchange": ["exchange program", "study-abroad", "study abroad"],
}

DEGREE_LABELS = {
    "bachelor": "Bachelor's / Undergraduate",
    "master": "Master's / Graduate",
    "doctorate": "PhD / Doctoral",
    "exchange": "Exchange / study-abroad",
}


def strip_allowed_degree_phrases(text, uni):
    """Removes legitimate "<this university's real degree level> program/
    degree/course" phrases (e.g. "Master's program" for a uni whose data
    really is Master's) before the field/subject check runs, so saying
    "Master's program" isn't treated the same as saying "Medicine program"
    -- the former just names the degree level correctly, the latter
    invents a subject. Only strips the phrase if it names THIS university's
    own correct degree; a wrong degree is still caught by
    forbidden_degree_pattern_for regardless of this function.
    """
    allowed_words = DEGREE_KEYWORDS.get(uni.get("degree") or "bachelor", [])
    if not allowed_words:
        return text
    pattern = r"\b(" + "|".join(re.escape(w) for w in allowed_words) + r")\b[\s-]*(program|degree|course)s?\b"
    return re.sub(pattern, "", text, flags=re.IGNORECASE)


def forbidden_degree_pattern_for(uni):
    """Regex matching any OTHER degree level's keywords -- a match means
    the model claimed a degree level that isn't this university's actual
    one (e.g. called a Master's-only program a Bachelor's program).
    """
    degree = uni.get("degree") or "bachelor"
    words = [w for key, kws in DEGREE_KEYWORDS.items() if key != degree for w in kws]
    if not words:
        return None
    pattern = r"\b(" + "|".join(re.escape(w) for w in words) + r")\b"
    return re.compile(pattern, re.IGNORECASE)

# Signals a fabricated field/major/program claim -- we never scraped what
# any university teaches, so any mention of academic-subject structure
# words is always invented, whatever the subject. Broad on purpose: a
# false positive here just means a slightly more generic fallback sentence
# is shown; a false negative means a lie gets through, which is worse.
FORBIDDEN_FIELD_PATTERN = re.compile(
    r"\b(offers?|has|provides?|specializes?\s+in)\b[^.]{0,40}\b(program|degree|major|course|field)s?\b[^.]{0,40}\bin\b"
    r"|\b(program|department|faculty|discipline|school\s+of)\b",
    re.IGNORECASE,
)

# Any mention of "target countr(y/ies)" at all -- used together with the
# negation check below to catch a claimed country match that contradicts
# the actual computed fact (either direction).
COUNTRY_CLAIM_PATTERN = re.compile(r"target countr", re.IGNORECASE)
COUNTRY_NEGATION_PATTERN = re.compile(r"(not|isn'?t|doesn'?t|n't|no|outside)\b[^.]{0,25}target countr", re.IGNORECASE)


def contradicts_country_fact(text, facts):
    """True if `text` makes a target-country claim that doesn't match the
    computed fact -- catches exactly the reported bug: the model asserting
    'one of your target countries' for a university whose computed
    country_match is actually False (or the reverse).
    """
    if not COUNTRY_CLAIM_PATTERN.search(text):
        return False
    claims_match = not COUNTRY_NEGATION_PATTERN.search(text)
    if facts["country_match"] is None:
        return True  # student gave no target countries -- any claim here is unverifiable
    return claims_match != bool(facts["country_match"])


def log(message):
    print(f"[match] {message}", file=sys.stderr, flush=True)


def split_countries(text):
    """'Italy, Germany and the UK' -> ['italy', 'germany', 'the uk']"""
    if not text:
        return []
    parts = re.split(r",|;|/| and | & ", text)
    return [p.strip().lower() for p in parts if p.strip()]


def countries_match(uni_country, target_countries_text):
    """True/False if we can tell, None if the student gave no preference."""
    targets = split_countries(target_countries_text)
    if not targets:
        return None
    uni_country = (uni_country or "").strip().lower()
    if not uni_country:
        return None
    return any(uni_country in t or t in uni_country for t in targets)


def degree_matches_bachelor(target_degree_text):
    """Fallback only, for standalone use without a caller-provided
    degree_match: True/False if we can tell, None if the student gave no
    preference. Assumes Bachelor's data, which is only right if the
    caller hasn't told us otherwise -- see compute_facts.
    """
    text = (target_degree_text or "").strip().lower()
    if not text:
        return None
    return "bachelor" in text or "undergrad" in text


def compute_facts(profile, uni):
    # server.js knows whether the student asked for a specific degree level
    # at all (it maps profile.targetDegree to bachelor/master/doctorate/
    # exchange) and already filtered universities accordingly, so it passes
    # the real answer as uni["degree_match"]. Fall back to the old
    # Bachelor's-only heuristic only when a caller doesn't provide one
    # (e.g. calling match.py directly without going through the server).
    if "degree_match" in uni:
        degree_match = uni["degree_match"]
    else:
        degree_match = degree_matches_bachelor(profile.get("targetDegree"))

    return {
        "country_match": countries_match(uni.get("country"), profile.get("targetCountries")),
        "degree_match": degree_match,
        "scholarship_count": len(uni.get("scholarships") or []),
    }


def rank_universities(profile, universities):
    """The one and only place ranking is decided. Sort key, best first:
    country match, then degree match, then how many scholarships are
    listed. `None` (student expressed no preference) sits between a match
    and an explicit mismatch, so it never wrongly beats a real match.
    """

    def tri(value):
        return 1 if value is True else (0.5 if value is None else 0)

    scored = []
    for uni in universities:
        facts = compute_facts(profile, uni)
        score = (tri(facts["country_match"]), tri(facts["degree_match"]), facts["scholarship_count"])
        scored.append((score, uni, facts))
    scored.sort(key=lambda row: row[0], reverse=True)
    return scored


def fallback_summary(uni, facts):
    """Used whenever the model's own sentence gets rejected by
    sanitize_summary -- built only from facts we've actually verified.
    """
    parts = []
    country = uni.get("country") or "an unstated location"
    if facts["country_match"] is True:
        parts.append(f"Located in {country}, one of your target countries.")
    elif facts["country_match"] is False:
        parts.append(f"Located in {country}, which isn't among your target countries.")
    else:
        parts.append(f"Located in {country}.")

    if facts["degree_match"] is False:
        degree_label = DEGREE_LABELS.get(uni.get("degree"), uni.get("degree_level") or "this degree level")
        parts.append(f"Our data for this school covers {degree_label} study, which may not match what you're aiming for.")

    if facts["scholarship_count"] > 0:
        plural = "s" if facts["scholarship_count"] != 1 else ""
        parts.append(f"{facts['scholarship_count']} scholarship{plural} listed on its funding page.")
    else:
        parts.append("No specific scholarships were listed on the pages we read.")

    return " ".join(parts)


def sanitize_summary(text, uni, facts):
    """Reject a model-written sentence that asserts anything we can't back
    with real data, and fall back to a fact-only sentence instead. This is
    the actual anti-hallucination guardrail -- the prompt asks nicely, this
    enforces it.
    """
    if not isinstance(text, str) or not text.strip():
        return fallback_summary(uni, facts)
    forbidden_degree = forbidden_degree_pattern_for(uni)
    field_check_text = strip_allowed_degree_phrases(text, uni)
    if (forbidden_degree and forbidden_degree.search(text)) or FORBIDDEN_FIELD_PATTERN.search(field_check_text) or contradicts_country_fact(text, facts):
        return fallback_summary(uni, facts)
    return text.strip()


def sanitize_points(points, uni, facts):
    """Same idea for the strengths/concerns bullet lists: drop individual
    bullets that fail the check rather than the whole list, since most
    bullets in practice are fine (e.g. "Scholarships available").
    """
    if not isinstance(points, list):
        return []
    kept = []
    for point in points:
        if not isinstance(point, str) or not point.strip():
            continue
        forbidden_degree = forbidden_degree_pattern_for(uni)
        field_check_point = strip_allowed_degree_phrases(point, uni)
        if (forbidden_degree and forbidden_degree.search(point)) or FORBIDDEN_FIELD_PATTERN.search(field_check_point) or contradicts_country_fact(point, facts):
            continue
        kept.append(point.strip())
    return kept


def format_university(uni, facts):
    tuition = uni.get("tuition") or {}
    requirements = uni.get("requirements") or {}
    scholarships = uni.get("scholarships") or []
    scholarship_text = (
        "; ".join(
            f"{s.get('name', 'unnamed award')} "
            f"(amount: {s.get('amount') or 'not stated'}, "
            f"eligibility: {s.get('eligibility') or 'not stated'})"
            for s in scholarships
            if isinstance(s, dict)
        )
        or "none listed"
    )
    deadlines = ", ".join(uni.get("key_deadlines") or []) or "not stated"
    location = ", ".join(part for part in (uni.get("city"), uni.get("country")) if part) or "not stated"
    degree_level = uni.get("degree_level") or DEGREE_LABELS.get(uni.get("degree"), "not stated")
    language_tests = ", ".join(requirements.get("language_tests") or []) or "not stated"
    standardized_tests = ", ".join(requirements.get("standardized_tests") or []) or "not stated"
    required_documents = ", ".join(requirements.get("required_documents") or []) or "not stated"

    def fact_text(value):
        return {True: "yes", False: "no", None: "student didn't specify"}[value]

    return f"""- slug: {uni.get('slug')}
  name: {uni.get('name') or uni.get('slug')}
  location: {location}
  degree_level: {degree_level} (the ONLY degree level this university's data below is about)
  tuition (home/domestic): {tuition.get('domestic_or_home') or 'not stated'}
  tuition (international): {tuition.get('international') or 'not stated'}
  minimum_gpa: {requirements.get('minimum_gpa') or 'not stated'}
  language_test_requirements: {language_tests}
  standardized_test_requirements: {standardized_tests}
  required_documents: {required_documents}
  financial_aid_summary: {uni.get('financial_aid_summary') or 'not stated'}
  scholarships: {scholarship_text}
  key_deadlines: {deadlines}
  VERIFIED country_match (computed, do not recompute or contradict): {fact_text(facts['country_match'])}
  VERIFIED degree_match (computed, do not recompute or contradict): {fact_text(facts['degree_match'])}"""


def format_profile(profile):
    lines = [f"  {key}: {value}" for key, value in profile.items() if value not in (None, "", [])]
    return "\n".join(lines) if lines else "  (the student hasn't filled in their profile yet)"


def is_match(facts):
    """A university is shown only if neither known fact rules it out.
    `None` (student didn't specify that preference) never excludes --
    only an explicit False does.
    """
    return facts["country_match"] is not False and facts["degree_match"] is not False


def exclusion_reason(facts, uni=None):
    reasons = []
    if facts["country_match"] is False:
        reasons.append("not in your target countries")
    if facts["degree_match"] is False:
        degree_label = DEGREE_LABELS.get((uni or {}).get("degree"), (uni or {}).get("degree_level") or "a different degree level")
        reasons.append(f"its available data is for {degree_label}, not what you're targeting")
    return "; ".join(reasons) if reasons else "didn't match your profile"


def build_prompt(profile, matched):
    universities_text = "\n".join(format_university(uni, facts) for uni, facts in matched)

    return f"""You are writing short, honest blurbs for a study-abroad app. The app has
already decided these universities are a fit for this student (see the
VERIFIED facts below) and already decided the order -- your only job is to
write one sentence per university explaining its VERIFIED facts in plain
language, plus a couple of short bullet points.

STUDENT PROFILE (for context and phrasing only -- do not use anything
here except what's echoed in each university's VERIFIED facts to make
factual claims):
{format_profile(profile)}

HARD RULES -- breaking any of these makes your answer useless and it will
be discarded:
1. Each university below lists its own degree_level -- that is the ONLY
   degree level its data is about. Use ONLY that university's own stated
   degree_level when writing about it; never call it a different degree
   level (e.g. don't describe a Master's-only record as a Bachelor's
   program, or vice versa), even if another university in this list has a
   different degree_level.
2. This app has NEVER scraped what subjects, majors, or fields any
   university teaches. You have ZERO information about that, regardless
   of what the student's field of study is. NEVER state or imply that a
   university does or doesn't offer a given field, major, or program.
   If the student's field of study comes up, say plainly that this app
   doesn't have subject-level data yet -- do not guess.
3. For country fit, use ONLY the "VERIFIED country_match" value given for
   that university. Do not reason about it yourself.
4. Do not invent tuition figures, scholarship names, or deadlines beyond
   what's listed for that university.

UNIVERSITIES, already ranked best to worst by the app -- write about ALL of
them, in this order:
{universities_text}

Return ONLY a single JSON object with exactly this shape (no extra keys,
no commentary, no markdown fences):

{{
  "summaries": {{
    "<slug>": {{
      "match_summary": "1 sentence using only that university's VERIFIED facts",
      "strengths": ["short phrase", "..."],
      "concerns": ["short phrase", "..."]
    }}
  }},
  "overall_notes": "1-2 plain-language sentences a student would find useful, mentioning that subject/field fit isn't covered by this data if the student gave a field of study"
}}

Include one entry in "summaries" for every slug listed above.
"""


def build_result(profile, matched, excluded, model_output, model):
    summaries = model_output.get("summaries") if isinstance(model_output, dict) else None
    if not isinstance(summaries, dict):
        summaries = {}

    recommendations = []
    for i, (uni, facts) in enumerate(matched, start=1):
        raw = summaries.get(uni["slug"]) if isinstance(summaries.get(uni["slug"]), dict) else {}
        recommendations.append(
            {
                "slug": uni["slug"],
                "rank": i,
                "match_summary": sanitize_summary(raw.get("match_summary"), uni, facts),
                "strengths": sanitize_points(raw.get("strengths"), uni, facts),
                "concerns": sanitize_points(raw.get("concerns"), uni, facts),
                "country_match": facts["country_match"],
                "degree_match": facts["degree_match"],
            }
        )

    overall_notes = model_output.get("overall_notes") if isinstance(model_output, dict) else None
    if not isinstance(overall_notes, str) or FORBIDDEN_FIELD_PATTERN.search(overall_notes):
        overall_notes = (
            "Rankings are based on target country and degree level match, plus listed scholarships. "
            "This app doesn't yet have data on specific fields or majors offered."
        )

    return {
        "best_match": recommendations[0]["slug"] if recommendations else None,
        "recommendations": recommendations,
        "excluded": [{"slug": uni["slug"], "reason": exclusion_reason(facts, uni)} for uni, facts in excluded],
        "overall_notes": overall_notes,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": model,
    }


def build_no_match_notes(excluded):
    """Templated, not model-written -- there's nothing to phrase creatively
    here, and a wrong-but-confident sentence would be worse than a plain one.
    """
    all_country = excluded and all(f["country_match"] is False and f["degree_match"] is not False for _, f in excluded)
    all_degree = excluded and all(f["degree_match"] is False and f["country_match"] is not False for _, f in excluded)

    if all_degree:
        available_levels = sorted(
            {DEGREE_LABELS.get(uni.get("degree"), uni.get("degree_level")) for uni, _ in excluded if uni.get("degree") or uni.get("degree_level")}
        )
        where = f" (available data covers: {', '.join(available_levels)})" if available_levels else ""
        return (
            f"None of the universities you've explored have data for your target degree level{where}. "
            f"Open more universities, or check a different degree level on ones you've already opened."
        )
    if all_country:
        countries = sorted({uni.get("country") for uni, _ in excluded if uni.get("country")})
        where = ", ".join(countries) if countries else "elsewhere"
        return (
            f"None of the universities you've explored are in your target countries -- they're located "
            f"in {where}. Open universities based in your target countries to compare them, or broaden "
            f"your target countries."
        )
    return (
        "None of the universities you've explored matched your target country and degree level "
        "together. Open more universities, or adjust your profile."
    )


def run(payload, model, ollama_url):
    profile = payload.get("profile") or {}
    universities = payload.get("universities") or []

    if not universities:
        raise ValueError("No universities were provided to match against.")

    ranked = rank_universities(profile, universities)
    matched = [(uni, facts) for _, uni, facts in ranked if is_match(facts)]
    excluded = [(uni, facts) for _, uni, facts in ranked if not is_match(facts)]

    if not matched:
        log(f"None of {len(universities)} discovered universities matched this profile -- skipping the model call.")
        return {
            "best_match": None,
            "recommendations": [],
            "excluded": [{"slug": uni["slug"], "reason": exclusion_reason(facts, uni)} for uni, facts in excluded],
            "overall_notes": build_no_match_notes(excluded),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "model": model,
        }

    prompt = build_prompt(profile, matched)
    log(f"Asking {model} to phrase results for {len(matched)} matching universities "
        f"({len(excluded)} excluded; ranking and matching are computed, not asked)...")
    model_output = call_ollama(prompt, model, ollama_url)
    return build_result(profile, matched, excluded, model_output, model)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Ollama model tag (default: {DEFAULT_MODEL})")
    parser.add_argument("--ollama-url", default=DEFAULT_OLLAMA_URL, help=f"Ollama base URL (default: {DEFAULT_OLLAMA_URL})")
    args = parser.parse_args()

    try:
        payload = json.loads(sys.stdin.read())
    except json.JSONDecodeError as exc:
        log(f"Failed: could not parse JSON from stdin: {exc}")
        sys.exit(1)

    try:
        result = run(payload, args.model, args.ollama_url)
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except Exception as exc:  # surface any failure clearly to whoever called this
        log(f"Failed: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()