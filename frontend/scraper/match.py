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
   claims a degree level other than Bachelor's, or claims a specific
   field/major/program -- since we never scraped that data, any such
   claim is necessarily invented.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone

from ollama_client import call_ollama, DEFAULT_MODEL, DEFAULT_OLLAMA_URL

# Signals a fabricated degree level -- every university here is Bachelor's/
# Undergraduate only, so any of these words means the model made it up.
FORBIDDEN_DEGREE_WORDS = re.compile(
    r"\b(master'?s?|ph\.?d\.?|doctorate|doctoral|mba|graduate degree|graduate program)\b",
    re.IGNORECASE,
)

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
    """True/False if we can tell, None if the student gave no preference.
    Every university's degree_level in our data is Bachelor's/Undergraduate,
    so this just checks whether that's also what the student is aiming for.
    """
    text = (target_degree_text or "").strip().lower()
    if not text:
        return None
    return "bachelor" in text or "undergrad" in text


def compute_facts(profile, uni):
    return {
        "country_match": countries_match(uni.get("country"), profile.get("targetCountries")),
        "degree_match": degree_matches_bachelor(profile.get("targetDegree")),
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
        parts.append("Our data for this school covers Bachelor's-level study, which may not match what you're aiming for.")

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
    if FORBIDDEN_DEGREE_WORDS.search(text) or FORBIDDEN_FIELD_PATTERN.search(text) or contradicts_country_fact(text, facts):
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
        if FORBIDDEN_DEGREE_WORDS.search(point) or FORBIDDEN_FIELD_PATTERN.search(point) or contradicts_country_fact(point, facts):
            continue
        kept.append(point.strip())
    return kept


def format_university(uni, facts):
    tuition = uni.get("tuition") or {}
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

    def fact_text(value):
        return {True: "yes", False: "no", None: "student didn't specify"}[value]

    return f"""- slug: {uni.get('slug')}
  name: {uni.get('name') or uni.get('slug')}
  location: {location}
  degree_level: Bachelor's / Undergraduate (every university here is Bachelor's-only)
  tuition (home/domestic): {tuition.get('domestic_or_home') or 'not stated'}
  tuition (international): {tuition.get('international') or 'not stated'}
  financial_aid_summary: {uni.get('financial_aid_summary') or 'not stated'}
  scholarships: {scholarship_text}
  key_deadlines: {deadlines}
  VERIFIED country_match (computed, do not recompute or contradict): {fact_text(facts['country_match'])}
  VERIFIED degree_match (computed, do not recompute or contradict): {fact_text(facts['degree_match'])}"""


def format_profile(profile):
    lines = [f"  {key}: {value}" for key, value in profile.items() if value not in (None, "", [])]
    return "\n".join(lines) if lines else "  (the student hasn't filled in their profile yet)"


def build_prompt(profile, ranked):
    universities_text = "\n".join(format_university(uni, facts) for _, uni, facts in ranked)

    return f"""You are writing short, honest blurbs for a study-abroad app. The
ranking is already decided by the app (not by you) using the VERIFIED
facts below -- your only job is to write one sentence per university
explaining its VERIFIED facts in plain language, plus a couple of short
bullet points.

STUDENT PROFILE (for context and phrasing only -- do not use anything
here except what's echoed in each university's VERIFIED facts to make
factual claims):
{format_profile(profile)}

HARD RULES -- breaking any of these makes your answer useless and it will
be discarded:
1. Every university below is Bachelor's / Undergraduate ONLY. Never write
   "Master's", "PhD", "doctorate", "MBA", or any graduate-program wording
   for any of them.
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


def build_result(profile, universities, model_output, model, ollama_url):
    ranked = rank_universities(profile, universities)
    summaries = model_output.get("summaries") if isinstance(model_output, dict) else None
    if not isinstance(summaries, dict):
        summaries = {}

    recommendations = []
    for i, (_, uni, facts) in enumerate(ranked, start=1):
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
    if not isinstance(overall_notes, str) or FORBIDDEN_DEGREE_WORDS.search(overall_notes) or FORBIDDEN_FIELD_PATTERN.search(overall_notes):
        overall_notes = (
            "Rankings are based on target country and degree level (Bachelor's only) plus listed "
            "scholarships. This app doesn't yet have data on specific fields or majors offered."
        )

    return {
        "best_match": recommendations[0]["slug"] if recommendations else None,
        "recommendations": recommendations,
        "overall_notes": overall_notes,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": model,
    }


def run(payload, model, ollama_url):
    profile = payload.get("profile") or {}
    universities = payload.get("universities") or []

    if not universities:
        raise ValueError("No universities were provided to match against.")

    ranked = rank_universities(profile, universities)
    prompt = build_prompt(profile, ranked)
    log(f"Asking {model} to phrase results for {len(universities)} universities (ranking is computed, not asked)...")
    model_output = call_ollama(prompt, model, ollama_url)
    return build_result(profile, universities, model_output, model, ollama_url)


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