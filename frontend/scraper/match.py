#!/usr/bin/env python3
"""
BilimLaunch -- rule-based profile-to-university matcher. No LLM involved.

Reads {"profile": {...}, "universities": [...]} as JSON on stdin and prints
a ranked result as JSON on stdout.

Why no LLM: small local models answer "is this a good match?" from their
pretrained opinion of famous universities, not from the data. Every
sentence this script produces is therefore one of two things:
  1. a computed comparison between a profile field and a value that was
     scraped from the university's own pages (e.g. "Your IELTS 6.0 is
     below the required 7.0"), or
  2. a value quoted straight from the scraped data (tuition, scholarship
     names, deadlines).
If something can't be verified it is reported as "unknown", never guessed.

Each check returns {key, status: met|unmet|unknown, detail}.
  - any "unmet" check hides the university (the reason is reported)
  - a university with no usable scraped data is hidden too
  - profile fields we cannot compare (field of study, experience, ...)
    are named in overall_notes instead of being silently ignored
"""

import json
import re
import sys
from datetime import datetime, timezone

COUNTRY_ALIASES = {
    "usa": "united states", "us": "united states", "u.s.": "united states",
    "u.s.a.": "united states", "america": "united states",
    "united states of america": "united states",
    "uk": "united kingdom", "u.k.": "united kingdom", "england": "united kingdom",
    "britain": "united kingdom", "great britain": "united kingdom",
    "scotland": "united kingdom", "wales": "united kingdom",
    "uae": "united arab emirates", "holland": "netherlands",
    "the netherlands": "netherlands", "korea": "south korea",
    "republic of korea": "south korea", "deutschland": "germany",
}

# Profile fields we have no scraped data to compare against.
UNCHECKABLE_FIELDS = {
    "fieldOfStudy": "field of study",
    "currentYear": "current year",
    "extracurriculars": "experience",
    "university": "current university",
}

MAX_GPA_SCALE = 4.3
IELTS_RE = re.compile(r"ielts[^0-9]{0,40}?(\d(?:\.\d)?)", re.I)
OTHER_SCALE_RE = re.compile(r"(out of|/|scale)\s*(5|10|100)\b|percent|%|first[- ]class|\b[12]:[12]\b|2:1|2:2", re.I)
NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")


def normalize_country(value):
    text = re.sub(r"\s+", " ", str(value or "").strip().lower())
    return COUNTRY_ALIASES.get(text, text)


def split_countries(value):
    parts = re.split(r"[,;/&]|\band\b", str(value or ""), flags=re.I)
    return [normalize_country(p) for p in parts if p.strip()]


def parse_number(text):
    match = NUMBER_RE.search(str(text or "").replace(",", "."))
    return float(match.group(0)) if match else None


def ielts_requirements(uni):
    """Highest IELTS overall figure found in requirements.language_tests."""
    tests = (uni.get("requirements") or {}).get("language_tests") or []
    values = []
    for entry in tests:
        match = IELTS_RE.search(str(entry))
        if match:
            value = float(match.group(1))
            if 4 <= value <= 9:
                values.append(value)
    return max(values) if values else None


def minimum_gpa(uni):
    """Minimum GPA on a 4.0 scale, or None if absent / on another scale."""
    raw = (uni.get("requirements") or {}).get("minimum_gpa")
    if not raw or OTHER_SCALE_RE.search(str(raw)):
        return None
    value = parse_number(raw)
    if value is None or not (1.0 <= value <= MAX_GPA_SCALE):
        return None
    return value


def data_points(uni):
    req = uni.get("requirements") or {}
    tuition = uni.get("tuition") or {}
    count = 0
    count += sum(1 for k in ("domestic_or_home", "international") if tuition.get(k))
    count += 1 if req.get("minimum_gpa") else 0
    for key in ("language_tests", "standardized_tests", "required_documents"):
        count += len(req.get(key) or [])
    count += len(uni.get("scholarships") or [])
    count += len(uni.get("key_deadlines") or [])
    return count


def check_country(profile, uni):
    wanted = split_countries(profile.get("targetCountries"))
    if not wanted:
        return None
    actual = normalize_country(uni.get("country"))
    if actual in wanted:
        return {"key": "country", "status": "met", "detail": f"Located in {uni.get('country')}, one of your target countries."}
    return {"key": "country", "status": "unmet", "detail": f"Located in {uni.get('country')}, not in your target countries ({profile.get('targetCountries')})."}


def check_degree(profile, uni):
    if not profile.get("targetDegree") or uni.get("degree_match") is None:
        return None
    if uni.get("degree_match"):
        return {"key": "degree", "status": "met", "detail": f"Data is for {uni.get('degree_level')}, matching your target degree."}
    return {"key": "degree", "status": "unmet", "detail": f"No data for your target degree ({profile.get('targetDegree')})."}


def check_ielts(profile, uni):
    mine = parse_number(profile.get("ielts"))
    if mine is None:
        return None
    needed = ielts_requirements(uni)
    if needed is None:
        return {"key": "ielts", "status": "unknown", "detail": "No IELTS requirement was found in the scraped pages; check the official site."}
    if mine >= needed:
        return {"key": "ielts", "status": "met", "detail": f"Your IELTS {mine:g} meets the listed requirement of {needed:g}."}
    return {"key": "ielts", "status": "unmet", "detail": f"Your IELTS {mine:g} is below the listed requirement of {needed:g}."}


def check_gpa(profile, uni):
    raw = str(profile.get("gpa") or "")
    if not raw.strip():
        return None
    mine = parse_number(raw)
    if mine is None or OTHER_SCALE_RE.search(raw) or not (0 < mine <= MAX_GPA_SCALE):
        return {"key": "gpa", "status": "unknown", "detail": "Your GPA isn't on a 4.0 scale, so it can't be compared automatically."}
    needed = minimum_gpa(uni)
    if needed is None:
        return {"key": "gpa", "status": "unknown", "detail": "No comparable (4.0-scale) minimum GPA was found in the scraped pages."}
    if mine >= needed:
        return {"key": "gpa", "status": "met", "detail": f"Your GPA {mine:g} meets the listed minimum of {needed:g}."}
    return {"key": "gpa", "status": "unmet", "detail": f"Your GPA {mine:g} is below the listed minimum of {needed:g}."}


def evidence_lines(uni):
    lines = []
    tuition = uni.get("tuition") or {}
    if tuition.get("international"):
        lines.append(f"International tuition: {tuition['international']}")
    if tuition.get("domestic_or_home"):
        lines.append(f"Home tuition: {tuition['domestic_or_home']}")
    names = [s.get("name") for s in (uni.get("scholarships") or []) if isinstance(s, dict) and s.get("name")]
    if names:
        lines.append("Scholarships listed: " + ", ".join(names[:4]))
    req = uni.get("requirements") or {}
    if req.get("language_tests"):
        lines.append("Language tests: " + ", ".join(str(t) for t in req["language_tests"][:3]))
    if req.get("standardized_tests"):
        lines.append("Standardized tests: " + ", ".join(str(t) for t in req["standardized_tests"][:3]))
    if uni.get("key_deadlines"):
        lines.append("Deadlines: " + "; ".join(str(d) for d in uni["key_deadlines"][:2]))
    return lines


def evaluate(profile, uni):
    checks = [c for c in (check_country(profile, uni), check_degree(profile, uni),
                          check_ielts(profile, uni), check_gpa(profile, uni)) if c]
    reasons = [c["detail"] for c in checks if c["status"] == "unmet"]
    points = data_points(uni)
    if points == 0:
        reasons.append("No usable data was extracted for this program yet.")
    return checks, reasons, points


def summarize(checks):
    met = sum(1 for c in checks if c["status"] == "met")
    unknown = sum(1 for c in checks if c["status"] == "unknown")
    if not checks:
        return "Nothing in your profile could be compared with this program's data."
    text = f"{met} of {len(checks)} checks passed"
    if unknown:
        text += f"; {unknown} could not be verified from the scraped data"
    return text + "."


def profile_note(profile):
    unused = [label for key, label in UNCHECKABLE_FIELDS.items() if str(profile.get(key) or "").strip()]
    if not unused:
        return ""
    return "Not used in this comparison (no matching data is collected): your " + ", ".join(unused) + "."


def run(payload):
    profile = payload.get("profile") or {}
    unis = payload.get("universities") or []
    scored, excluded = [], []

    for uni in unis:
        checks, reasons, points = evaluate(profile, uni)
        if reasons:
            excluded.append({"slug": uni.get("slug"), "reason": " ".join(reasons)})
            continue
        met = sum(1 for c in checks if c["status"] == "met")
        unknown = sum(1 for c in checks if c["status"] == "unknown")
        scholarships = len(uni.get("scholarships") or [])
        scored.append((met, unknown, points, scholarships, uni, checks))

    scored.sort(key=lambda r: (-r[0], r[1], -r[2], -r[3], str(r[4].get("name"))))

    recommendations = []
    for rank, (met, unknown, points, _, uni, checks) in enumerate(scored, 1):
        recommendations.append({
            "slug": uni.get("slug"),
            "rank": rank,
            "match_summary": summarize(checks),
            "strengths": [c["detail"] for c in checks if c["status"] == "met"] + evidence_lines(uni)[:2],
            "concerns": [c["detail"] for c in checks if c["status"] == "unknown"],
            "checks": checks,
            "sources": uni.get("sources") or [],
        })

    notes = []
    if len(scored) > 1 and len({(r[0], r[1]) for r in scored}) == 1:
        notes.append("These programs passed the same checks, so they are ordered by how much data is available, then alphabetically.")
    if not scored:
        notes.append("No analyzed program satisfies your profile's checkable requirements.")
    if not any(str(profile.get(k) or "").strip() for k in ("targetCountries", "targetDegree", "gpa", "ielts")):
        notes.append("Your profile has no target country, target degree, GPA or IELTS, so nothing could be verified. Add them for meaningful results.")
    extra = profile_note(profile)
    if extra:
        notes.append(extra)

    return {
        "recommendations": recommendations,
        "excluded": excluded,
        "overall_notes": " ".join(notes),
        "best_match": recommendations[0]["slug"] if recommendations else None,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "method": "rules",
    }


def main():
    try:
        payload = json.loads(sys.stdin.read())
        print(json.dumps(run(payload), ensure_ascii=False))
    except Exception as exc:
        print(f"[match] Failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()