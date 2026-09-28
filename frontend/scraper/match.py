#!/usr/bin/env python3
"""
BilimLaunch -- profile-to-university matcher.

Stateless, like extract.py: reads {"profile": {...}, "universities": [...]}
as JSON on stdin -- the student's profile fields, and the already-scraped
tuition/scholarship info for every "discovered" university (i.e. one that
has been opened at least once, so universities_info has data for it) --
asks the local model to rank them for that student, and prints the result
JSON to stdout. Never touches MongoDB itself; server/matcher.js handles
fetching the input and using the output.

Usage:
    echo '{"profile": {...}, "universities": [{...}, ...]}' | python match.py
    python match.py --model llama3.1:8b --ollama-url http://localhost:11434 < payload.json
"""

import argparse
import json
import sys
from datetime import datetime, timezone

from ollama_client import call_ollama, DEFAULT_MODEL, DEFAULT_OLLAMA_URL

RECOMMENDATION_SCHEMA_HINT = {
    "best_match": "<slug of the top pick -- must be one of the given slugs>",
    "recommendations": [
        {
            "slug": "<slug>",
            "rank": "integer, 1 = best",
            "match_summary": "1-2 plain-language sentences on why this rank",
            "strengths": ["short phrase", "..."],
            "concerns": ["short phrase", "..."],
        }
    ],
    "overall_notes": "1-2 sentences a student would actually find useful, including the limitation below if it matters here",
}


def log(message):
    print(f"[match] {message}", file=sys.stderr, flush=True)


def format_university(uni):
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

    return f"""- slug: {uni.get('slug')}
  name: {uni.get('name') or uni.get('slug')}
  location: {location}
  degree_level: {uni.get('degree_level') or 'not stated'}
  tuition (home/domestic): {tuition.get('domestic_or_home') or 'not stated'}
  tuition (international): {tuition.get('international') or 'not stated'}
  financial_aid_summary: {uni.get('financial_aid_summary') or 'not stated'}
  scholarships: {scholarship_text}
  key_deadlines: {deadlines}
  notes: {uni.get('notes') or 'none'}"""


def format_profile(profile):
    lines = [f"  {key}: {value}" for key, value in profile.items() if value not in (None, "", [])]
    return "\n".join(lines) if lines else "  (the student hasn't filled in their profile yet)"


def build_match_prompt(profile, universities):
    universities_text = "\n".join(format_university(u) for u in universities)

    return f"""You are a study-abroad advisor helping a student compare universities.
Be direct and specific -- avoid generic filler like "this could be a great fit."

STUDENT PROFILE:
{format_profile(profile)}

You may ONLY recommend from the universities listed below. These are the
only ones with real, scraped data available -- never mention, rank, or
invent any university that isn't in this list.

IMPORTANT LIMITATION: this data covers tuition, scholarships, and general
funding only. It does NOT include each university's academic entry
requirements (minimum GPA, required test scores, etc.), because those
pages were never scraped -- only fee/funding pages were. So do not state
or imply an admission probability or "chance of getting in." Base the
ranking only on concrete, available signals: whether the university's
degree level matches what the student is aiming for, whether its country
is among the student's target countries, and whether its scholarships or
aid look like a realistic fit given what the student described about their
goals and experience. If the available data genuinely doesn't let you
distinguish between universities for this student, say so plainly in
overall_notes rather than inventing a reason.

UNIVERSITIES (only these may be recommended -- rank ALL of them):
{universities_text}

Return ONLY a single JSON object with exactly this shape (no extra keys,
no commentary, no markdown fences):

{json.dumps(RECOMMENDATION_SCHEMA_HINT, indent=2)}
"""


def normalize_match_result(result, universities):
    """Defends against a model that hallucinates a slug, skips one, or
    returns malformed rank/strengths/concerns -- the frontend should never
    have to guard against any of that itself.
    """
    valid_slugs = [u.get("slug") for u in universities if u.get("slug")]
    valid_set = set(valid_slugs)

    raw_recs = result.get("recommendations")
    if not isinstance(raw_recs, list):
        raw_recs = []

    cleaned = []
    seen = set()
    for rec in raw_recs:
        if not isinstance(rec, dict):
            continue
        slug = rec.get("slug")
        if slug not in valid_set or slug in seen:
            continue
        seen.add(slug)
        cleaned.append(
            {
                "slug": slug,
                "rank": rec.get("rank") if isinstance(rec.get("rank"), (int, float)) else len(cleaned) + 1,
                "match_summary": rec.get("match_summary") if isinstance(rec.get("match_summary"), str) else "",
                "strengths": [s for s in (rec.get("strengths") or []) if isinstance(s, str)],
                "concerns": [c for c in (rec.get("concerns") or []) if isinstance(c, str)],
            }
        )

    # Any university the model skipped still gets a bare entry, appended
    # in the order it was given, so nothing "discovered" silently vanishes.
    for slug in valid_slugs:
        if slug not in seen:
            cleaned.append({"slug": slug, "rank": len(cleaned) + 1, "match_summary": "", "strengths": [], "concerns": []})

    cleaned.sort(key=lambda r: r["rank"])
    for i, rec in enumerate(cleaned, start=1):
        rec["rank"] = i

    best_match = result.get("best_match")
    if best_match not in valid_set:
        best_match = cleaned[0]["slug"] if cleaned else None

    overall_notes = result.get("overall_notes")
    if not isinstance(overall_notes, str):
        overall_notes = ""

    return {"best_match": best_match, "recommendations": cleaned, "overall_notes": overall_notes}


def run(payload, model, ollama_url):
    profile = payload.get("profile") or {}
    universities = payload.get("universities") or []

    if not universities:
        raise ValueError("No universities were provided to match against.")

    prompt = build_match_prompt(profile, universities)
    log(f"Asking {model} to rank {len(universities)} universities for this profile...")
    result = call_ollama(prompt, model, ollama_url)
    result = normalize_match_result(result, universities)

    result["generated_at"] = datetime.now(timezone.utc).isoformat()
    result["model"] = model
    return result


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