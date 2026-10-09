#!/usr/bin/env python3
"""
BilimLaunch -- per-degree-level admissions info extractor.

Stateless by design: reads one university's config for ONE degree level
(slug, name, degree, and pages -- already-scraped {url, text} pairs) as a
JSON object on stdin, asks a local Ollama model (llama3.1:8b by default)
to pull out facts for that degree level only -- tuition, admissions
requirements, scholarships, deadlines -- and prints the resulting JSON
object to stdout. This script has no idea MongoDB exists -- the caller
(server/server.js) is responsible for persisting whatever this prints,
typically at universities_info.programs.<degree>.

This script does NOT fetch pages itself. Page fetching moved to Node
(server/scrape.js, using Puppeteer with a stealth plugin) because some
university sites (Oxford's included) block plain HTTP libraries like
`requests` outright, and getting past that needs a real, stealth-patched
browser -- which has no good Python equivalent of the same quality.
server/universities.js scrapes each sourceUrl first and sends the
resulting text here; this script only ever does prompt-building + the
Ollama call.

`degree` is one of: bachelor, master, doctorate, exchange (defaults to
"bachelor" if omitted or unrecognized). A separate call per degree level
is deliberate -- it keeps each prompt small and focused rather than
asking the model to juggle four degree levels' worth of facts at once.

Usage:
    echo '{"slug":"oxford","name":"University of Oxford","degree":"bachelor","pages":[{"url":"https://...","text":"..."}]}' \
        | python extract.py

    python extract.py --model llama3.1:8b --ollama-url http://localhost:11434 < payload.json

Called by server/server.js on every cache miss, but also runs standalone
for testing -- e.g. from the scraper/ folder:
    echo '{"slug":"mit","name":"MIT","degree":"master","pages":[{"url":"https://...","text":"Tuition is $50,000/year..."}]}' | python extract.py
"""

import argparse
import json
import sys
from datetime import datetime, timezone

from ollama_client import call_ollama, DEFAULT_MODEL, DEFAULT_OLLAMA_URL

MAX_CHARS_PER_PAGE = 6000     # matches the cap server/scrape.js already applies; enforced again here defensively
MAX_CHARS_TOTAL = 16000       # keep the whole prompt bounded for an 8B model

# One of these per call -- a single extraction covers ONE degree level for
# ONE university, kept deliberately narrow so the prompt (and the model's
# job) stays small and focused rather than asking for everything about a
# university at once.
DEGREE_LABELS = {
    "bachelor": "Bachelor's / Undergraduate",
    "master": "Master's / Graduate (taught or research)",
    "doctorate": "PhD / Doctoral",
    "exchange": "Exchange / study-abroad (non-degree)",
}
DEFAULT_DEGREE = "bachelor"

# Shown to the model so it knows exactly which keys to fill in.
SCHEMA_HINT = {
    "tuition": {
        "domestic_or_home": "string or null",
        "international": "string or null",
        "notes": "string or null",
    },
    "requirements": {
        "minimum_gpa": "string or null",
        "language_tests": ["string, e.g. 'IELTS 6.5' or 'TOEFL 90'"],
        "standardized_tests": ["string, e.g. 'SAT', 'GRE', 'GMAT'"],
        "required_documents": ["string, e.g. 'official transcript', 'two reference letters'"],
        "other": "string or null",
    },
    "scholarships": [
        {"name": "string", "eligibility": "string", "amount": "string", "deadline": "string or null"}
    ],
    "financial_aid_summary": "string",
    "key_deadlines": ["string"],
    "notes": "string",
}


def log(message):
    """Progress goes to stderr so stdout can stay clean JSON-on-success."""
    print(f"[extract] {message}", file=sys.stderr, flush=True)


def build_prompt(uni, pages):
    """`pages` is a list of {"url": str, "text": str} -- already scraped
    and cleaned by server/scrape.js. This just assembles them into the
    prompt, bounded the same way the old fetcher bounded raw scrape output.
    """
    sections = []
    total = 0
    for page in pages:
        url = page.get("url", "")
        text = (page.get("text") or "")[:MAX_CHARS_PER_PAGE]
        if not text:
            continue
        chunk = f"--- Source: {url} ---\n{text}\n"
        if total + len(chunk) > MAX_CHARS_TOTAL:
            chunk = chunk[: max(0, MAX_CHARS_TOTAL - total)]
        if chunk:
            sections.append(chunk)
            total += len(chunk)
        if total >= MAX_CHARS_TOTAL:
            break

    scraped_text = "\n".join(sections) if sections else "(no page content could be retrieved)"
    degree = uni.get("degree", DEFAULT_DEGREE)
    degree_label = DEGREE_LABELS.get(degree, degree)
    other_labels = ", ".join(label for key, label in DEGREE_LABELS.items() if key != degree)

    return f"""You are extracting facts for a study-abroad app. Only use information that
appears in the SOURCE TEXT below. Do not invent numbers, names, or dates.
If something isn't stated in the source text, use null (or an empty list)
instead of guessing.

Extract information about {degree_label} study ONLY.
Ignore anything about other degree levels ({other_labels}) even if the
source text mentions them.

Return ONLY a single JSON object with exactly this shape (no extra keys,
no commentary, no markdown fences):

{json.dumps(SCHEMA_HINT, indent=2)}

University: {uni.get('name', 'Unknown university')}
Degree level to extract: {degree_label}

SOURCE TEXT:
{scraped_text}
"""


def normalize_result(result, uni):
    """Fill in any keys the model skipped so the caller never has to guess."""
    # The degree level comes from our own request, never from whatever the
    # model echoed back -- there's nothing to "trust" here, we already know it.
    result["degree"] = uni.get("degree", DEFAULT_DEGREE)

    tuition = result.setdefault("tuition", {})
    if not isinstance(tuition, dict):
        tuition = {}
        result["tuition"] = tuition
    tuition.setdefault("domestic_or_home", None)
    tuition.setdefault("international", None)
    tuition.setdefault("notes", None)

    requirements = result.setdefault("requirements", {})
    if not isinstance(requirements, dict):
        requirements = {}
        result["requirements"] = requirements
    requirements.setdefault("minimum_gpa", None)
    if not isinstance(requirements.get("language_tests"), list):
        requirements["language_tests"] = []
    if not isinstance(requirements.get("standardized_tests"), list):
        requirements["standardized_tests"] = []
    if not isinstance(requirements.get("required_documents"), list):
        requirements["required_documents"] = []
    requirements.setdefault("other", None)

    if not isinstance(result.get("scholarships"), list):
        result["scholarships"] = []
    result.setdefault("financial_aid_summary", "")
    if not isinstance(result.get("key_deadlines"), list):
        result["key_deadlines"] = []
    result.setdefault("notes", "")
    return result


def run(uni, model, ollama_url):
    if uni.get("degree") not in DEGREE_LABELS:
        log(f"Unknown or missing degree '{uni.get('degree')}', defaulting to '{DEFAULT_DEGREE}'")
        uni = {**uni, "degree": DEFAULT_DEGREE}

    pages = uni.get("pages") or []
    prompt = build_prompt(uni, pages)
    extracted = call_ollama(prompt, model, ollama_url)
    extracted = normalize_result(extracted, uni)

    extracted["sources"] = [p.get("url") for p in pages if p.get("url")]
    extracted["generated_at"] = datetime.now(timezone.utc).isoformat()
    extracted["model"] = model
    return extracted


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Ollama model tag (default: {DEFAULT_MODEL})")
    parser.add_argument("--ollama-url", default=DEFAULT_OLLAMA_URL, help=f"Ollama base URL (default: {DEFAULT_OLLAMA_URL})")
    args = parser.parse_args()

    try:
        raw_stdin = sys.stdin.read()
        uni = json.loads(raw_stdin)
    except json.JSONDecodeError as exc:
        log(f"Failed: could not parse university JSON from stdin: {exc}")
        sys.exit(1)

    try:
        extracted = run(uni, args.model, args.ollama_url)
        print(json.dumps(extracted, indent=2, ensure_ascii=False))
    except Exception as exc:  # surface any failure clearly to whoever called this
        log(f"Failed: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()