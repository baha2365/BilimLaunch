#!/usr/bin/env python3
"""
BilimLaunch -- motivation letter writer.

Stateless: reads {"profile", "answers", "applicant_name", "university"} as
JSON on stdin, asks the local Ollama model to write the letter, prints
{"letter", "warnings", "generated_at", "model"} to stdout.

The model only does the prose. Everything it may state as fact comes from
three places: the student's profile, the student's answers to the questions
asked just before writing, and the university's own scraped data (name,
location, programmes that fit the student's field). The prompt forbids
inventing anything else, and a post-check flags numbers and unsupported
praise ("world-renowned", rankings, ...) that aren't in the input so the
student can fix them before sending.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone

from match import field_matches
from ollama_client import call_ollama, DEFAULT_MODEL, DEFAULT_OLLAMA_URL, log

UNSUPPORTED_PRAISE = [
    "world-class", "world class", "world-renowned", "world renowned", "prestigious", "renowned",
    "top-ranked", "top ranked", "ranked", "leading", "nobel", "centuries", "legendary", "elite",
]
PROFILE_LABELS = [
    ("country", "Country of residence"), ("university", "Current university"),
    ("fieldOfStudy", "Field of study"), ("currentYear", "Current year"), ("gpa", "GPA"),
    ("ielts", "IELTS"), ("targetDegree", "Target degree"), ("extracurriculars", "Experience"),
]
ANSWER_LABELS = [
    ("goal", "Goal after graduation"), ("whyField", "Why this field"),
    ("whyUniversity", "Why this university"), ("contribution", "Contribution to the community"),
    ("highlight", "Proudest achievement / experience"),
]


def fact_lines(profile, answers):
    lines = [f"- {label}: {profile[key]}" for key, label in PROFILE_LABELS if profile.get(key)]
    lines += [f"- {label}: {answers[key]}" for key, label in ANSWER_LABELS if answers.get(key)]
    return lines


def university_lines(uni, profile):
    lines = [f"- Name: {uni.get('name')}", f"- Location: {', '.join(x for x in (uni.get('city'), uni.get('country')) if x)}"]
    if uni.get("degree_level"):
        lines.append(f"- Level applied for: {uni['degree_level']}")
    field = profile.get("fieldOfStudy")
    if field:
        fits = [p for p in (uni.get("fields_of_study") or []) if field_matches(field, p)][:5]
        if fits:
            lines.append("- Programmes listed on its official pages that relate to the applicant's field: " + "; ".join(fits))
    return lines


def build_prompt(payload):
    profile, answers, uni = payload.get("profile") or {}, payload.get("answers") or {}, payload.get("university") or {}
    name = payload.get("applicant_name") or "the applicant"
    return f"""Write a motivation letter for a university application, in the first person, as {name}.

ONLY use the facts listed below. Do not invent anything: no achievements, awards, numbers, dates,
projects, professors, courses, laboratories, rankings, traditions or facts about the university.
If something is not listed, leave it out instead of making it up. About the university you may say
only its name, its location, and the listed programmes. Avoid praise such as "world-renowned",
"prestigious", "leading" or any ranking claim. Do not state or promise admission requirements.

APPLICANT AND THEIR ANSWERS:
{chr(10).join(fact_lines(profile, answers))}

UNIVERSITY:
{chr(10).join(university_lines(uni, profile))}

FORMAT: about 350-450 words, 4 short paragraphs (background and field; goal after graduation;
why this university; what I will contribute). Start with "Dear Admissions Committee," and end with
"Sincerely," and the applicant's name. Natural, sincere, specific, not clichéd. Use the applicant's
own details and wording where possible.

Return ONLY a JSON object: {{"letter": "<the full letter text, paragraphs separated by blank lines>"}}
"""


def check_letter(letter, payload):
    source = json.dumps(payload, ensure_ascii=False).lower()
    warnings = []
    numbers = sorted({n.strip(".,") for n in re.findall(r"\d[\d.,]*", letter) if n.strip(".,")})
    odd = [n for n in numbers if n.lower() not in source]
    if odd:
        warnings.append("Check these figures, they were not in your profile or answers: " + ", ".join(odd) + ".")
    praise = [w for w in UNSUPPORTED_PRAISE if re.search(rf"\b{re.escape(w)}\b", letter, re.I) and w not in source]
    if praise:
        warnings.append("Contains claims we can't verify (" + ", ".join(praise) + "). Remove or confirm them.")
    return warnings


def run(payload, model, ollama_url):
    result = call_ollama(build_prompt(payload), model, ollama_url, temperature=0.6)
    letter = str(result.get("letter") or "").strip()
    if len(letter) < 200:
        raise ValueError("The model returned an empty or too-short letter. Try again.")
    return {
        "letter": letter,
        "warnings": check_letter(letter, payload),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": model,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--ollama-url", default=DEFAULT_OLLAMA_URL)
    args = parser.parse_args()
    try:
        payload = json.loads(sys.stdin.read())
        print(json.dumps(run(payload, args.model, args.ollama_url), ensure_ascii=False))
    except Exception as exc:
        log("letter", f"Failed: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()