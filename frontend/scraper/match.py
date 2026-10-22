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
    """Lowest IELTS figure found in requirements.language_tests.

    Universities often list several levels (for example UCL "Level 1" to
    "Level 5", or Oxford 6.5 for some courses and 7.0 for the rest). The
    requirement a student must meet to be considered for *any* programme is the
    lowest of them, so a student is only marked as unmet when they are below
    every level.
    """
    tests = (uni.get("requirements") or {}).get("language_tests") or []
    values = []
    for entry in tests:
        match = IELTS_RE.search(str(entry))
        if match:
            value = float(match.group(1))
            if 4 <= value <= 9:
                values.append(value)
    return min(values) if values else None


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


# Groups of word roots meaning "the same area". A profile term and a
# programme name match if they hit the same group, or share a word stem.
FIELD_GROUPS = [
    ("medicine", ["medic", "clinical", "surgery", "nursing", "pharmac", "dentist", "physician", "health"]),
    ("biomedical", ["biomedical", "biomedicine", "neuroscience"]),
    ("biology", ["biolog", "biochem", "genetic", "molecular"]),
    ("computing", ["computer", "computing", "software", "informatic", "data science", "artificial intelligence", "machine learning", "cyber"]),
    ("engineering", ["engineer", "mechanic", "robotic", "aeronaut", "aerospace", "electrical", "civil", "chemical eng"]),
    ("mathematics", ["math", "statistic", "applied math"]),
    ("physics", ["physic", "astronomy", "astrophys"]),
    ("chemistry", ["chemi"]),
    ("economics", ["econom", "finance", "financ"]),
    ("business", ["business", "management", "accounting", "entrepreneur", "marketing"]),
    ("law", ["law", "jurisprudence", "legal"]),
    ("psychology", ["psycholog", "cognitive", "behavio"]),
    ("politics", ["politic", "government", "international relations", "public policy", "sociolog"]),
    ("history", ["history", "archaeolog", "classics", "anthropolog"]),
    ("philosophy", ["philosoph", "theology", "religio"]),
    ("literature", ["literature", "english", "linguistic", "language", "writing"]),
    ("arts", ["music", "singing", "vocal", "theatre", "theater", "drama", "film", "art ", "arts", "dance", "fine art", "design"]),
    ("architecture", ["architect", "urban", "planning"]),
    ("education", ["educat", "teaching", "pedagog"]),
    ("environment", ["environment", "earth", "geolog", "geograph", "climate", "ecolog", "sustainab"]),
    ("agriculture", ["agricultur", "food", "veterinar"]),
]
STOPWORDS = {"and", "the", "of", "in", "for", "studies", "science", "sciences", "with", "general"}
FIELDS_MIN_FOR_UNMET = 15  # only call it a mismatch when the scraped list is big enough to trust


def _groups(text):
    low = f" {str(text).lower()} "
    return {name for name, roots in FIELD_GROUPS if any(r in low for r in roots)}


def _stems(text):
    words = re.findall(r"[a-z]{4,}", str(text).lower())
    return {w[:5] for w in words if w not in STOPWORDS}


def field_matches(profile_field, programme):
    pg, ps = _groups(profile_field), _stems(profile_field)
    if pg & _groups(programme):
        return True
    return bool(ps & _stems(programme))


def check_field(profile, uni):
    field = str(profile.get("fieldOfStudy") or "").strip()
    if not field:
        return None
    items = [str(i) for i in (uni.get("fields_of_study") or []) if str(i).strip()]
    if not items:
        return {"key": "field", "status": "unknown", "detail": f"No list of programmes has been collected for this university yet, so '{field}' couldn't be checked."}
    hits = [i for i in items if field_matches(field, i)]
    if hits:
        return {"key": "field", "status": "met", "detail": f"Listed programmes matching '{field}': " + ", ".join(hits[:4]) + "."}
    if len(items) >= FIELDS_MIN_FOR_UNMET:
        return {"key": "field", "status": "unmet", "detail": f"None of the {len(items)} programmes listed on the official pages match '{field}'."}
    return {"key": "field", "status": "unknown", "detail": f"Only {len(items)} programmes were collected, not enough to rule out '{field}'; check the official site."}


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


# ---- admission difficulty ("chance") -------------------------------------
# A university can pass every requirement check and still be a long shot
# (Harvard admits ~4% of applicants). So besides the requirement checks each
# university gets a chance label from (how selective it is) x (how strong the
# student's GPA is):
#   likely / target -> ranked normally
#   reach           -> always ranked BELOW every likely/target/unrated university
#   hidden          -> a very selective university the student's GPA makes
#                      unrealistic; moved to the "hidden -- why" list
# Selectivity comes from uni["acceptance_rate"] (percent admitted) or
# uni["difficulty"]; if neither is known the university is simply not rated.
# Rates describe undergraduate admission, so only Bachelor's programmes are rated.

DIFFICULTY_BANDS = [(10, "extreme"), (25, "high"), (50, "moderate")]  # < upper bound; else "accessible"
VALID_DIFFICULTIES = {"extreme", "high", "moderate", "accessible"}

# GPA (4.0 scale) bands: top >= 3.8, strong >= 3.5, solid >= 3.0, below < 3.0.
GPA_TOP, GPA_STRONG, GPA_SOLID = 3.8, 3.5, 3.0

# difficulty -> student band -> label (None = hide this university)
CHANCE_MATRIX = {
    "extreme": {"top": "reach", "strong": None, "solid": None, "below": None, "unknown": "reach"},
    "high": {"top": "target", "strong": "reach", "solid": None, "below": None, "unknown": "reach"},
    "moderate": {"top": "likely", "strong": "target", "solid": "target", "below": "reach", "unknown": "target"},
    "accessible": {"top": "likely", "strong": "likely", "solid": "likely", "below": "target", "unknown": "likely"},
}
CHANCE_ORDER = {"likely": 0, "target": 1, None: 1, "reach": 2}  # None = not rated


def difficulty_of(uni):
    """(difficulty band or None, acceptance rate or None)."""
    rate = uni.get("acceptance_rate")
    rate = float(rate) if isinstance(rate, (int, float)) and not isinstance(rate, bool) and 0 <= rate <= 100 else None
    if rate is not None:
        for upper, name in DIFFICULTY_BANDS:
            if rate < upper:
                return name, rate
        return "accessible", rate
    named = uni.get("difficulty")
    return (named if named in VALID_DIFFICULTIES else None), None


def student_gpa(profile):
    """The student's GPA on a 4.0 scale, or None if missing / on another scale."""
    raw = str(profile.get("gpa") or "")
    mine = parse_number(raw)
    if not raw.strip() or mine is None or OTHER_SCALE_RE.search(raw) or not (0 < mine <= MAX_GPA_SCALE):
        return None
    return mine


def gpa_band(gpa):
    if gpa is None:
        return "unknown"
    if gpa >= GPA_TOP:
        return "top"
    if gpa >= GPA_STRONG:
        return "strong"
    if gpa >= GPA_SOLID:
        return "solid"
    return "below"


def assess_chance(profile, uni):
    """Returns None (not rated), or {"label": likely|target|reach|hidden, "difficulty", "acceptance_rate", "note"}."""
    if uni.get("degree") not in (None, "bachelor"):
        return None
    difficulty, rate = difficulty_of(uni)
    if difficulty is None:
        return None
    gpa = student_gpa(profile)
    band = gpa_band(gpa)
    label = CHANCE_MATRIX[difficulty][band]

    # e.g. " (about 4% of applicants are admitted)"; empty when only a difficulty band is known
    how = f" (about {rate:g}% of applicants are admitted)" if rate is not None else ""
    unknown_gpa = " Add your GPA (4.0 scale) to your profile for a sharper estimate." if gpa is None else ""

    if label is None:
        note = (f"Highly selective{how} and your GPA {gpa:g} is below the level most admitted students have, "
                "so it is not recommended as a realistic option.")
    elif label == "reach":
        note = (f"Reach: very hard to get into{how}. Even strong applicants are often rejected, "
                f"so treat it as an ambitious extra, not a likely admission.{unknown_gpa}")
    elif label == "target":
        note = f"Competitive{how}. Your profile makes it a realistic target, but admission is never guaranteed.{unknown_gpa}"
    else:
        note = f"Less selective{how}, so it is a realistic option for your profile.{unknown_gpa}"
    return {
        "label": label or "hidden",
        "difficulty": difficulty,
        "acceptance_rate": rate,
        "note": note,
    }


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
    checks = [c for c in (check_field(profile, uni), check_country(profile, uni), check_degree(profile, uni),
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
    too_selective = 0  # universities hidden because they are unrealistic for this student's GPA

    for uni in unis:
        checks, reasons, points = evaluate(profile, uni)
        if reasons:
            excluded.append({"slug": uni.get("slug"), "reason": " ".join(reasons)})
            continue
        chance = assess_chance(profile, uni)
        if chance and chance["label"] == "hidden":
            excluded.append({"slug": uni.get("slug"), "reason": chance["note"]})
            too_selective += 1
            continue
        met = sum(1 for c in checks if c["status"] == "met")
        unknown = sum(1 for c in checks if c["status"] == "unknown")
        scholarships = len(uni.get("scholarships") or [])
        field = next((c["status"] for c in checks if c["key"] == "field"), None)
        field_rank = 0 if field == "met" else 1  # a confirmed field match outranks the rest of its group
        tier = CHANCE_ORDER[chance["label"] if chance else None]  # reach universities always come last
        scored.append((met, unknown, points, scholarships, uni, checks, field_rank, tier, chance))

    scored.sort(key=lambda r: (r[7], r[6], -r[0], r[1], -r[2], -r[3], str(r[4].get("name"))))

    recommendations = []
    for rank, (met, unknown, points, _, uni, checks, _fr, _tier, chance) in enumerate(scored, 1):
        rec = {
            "slug": uni.get("slug"),
            "rank": rank,
            "match_summary": summarize(checks),
            "strengths": [c["detail"] for c in checks if c["status"] == "met"] + evidence_lines(uni)[:2],
            "concerns": [c["detail"] for c in checks if c["status"] == "unknown"],
            "checks": checks,
            "sources": uni.get("sources") or [],
        }
        if chance:
            rec["chance"] = chance
        recommendations.append(rec)

    # The "best match" is never a reach school: a long shot isn't a best match.
    best = next((r["slug"] for r in recommendations if (r.get("chance") or {}).get("label") != "reach"), None)

    notes = []
    if too_selective or any(r.get("chance") for r in recommendations):
        notes.append("Admission difficulty uses approximate undergraduate acceptance rates and your GPA; "
                     "very selective universities are listed last as \"reach\" or hidden. "
                     "It is a rough guide, not a prediction -- check each university's admissions statistics.")
    if len(scored) > 1 and len({(r[0], r[1]) for r in scored}) == 1:
        notes.append("These programs passed the same checks, so they are ordered by how much data is available, then alphabetically.")
    if not scored:
        notes.append("No analyzed program satisfies your profile's checkable requirements.")
    if not any(str(profile.get(k) or "").strip() for k in ("fieldOfStudy", "targetCountries", "targetDegree", "gpa", "ielts")):
        notes.append("Your profile has no field of study, target country, target degree, GPA or IELTS, so nothing could be verified. Add them for meaningful results.")
    extra = profile_note(profile)
    if extra:
        notes.append(extra)

    return {
        "recommendations": recommendations,
        "excluded": excluded,
        "overall_notes": " ".join(notes),
        "best_match": best,
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