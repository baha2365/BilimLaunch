#!/usr/bin/env python3
"""
BilimLaunch -- per-degree-level admissions info extractor.

Stateless by design: reads one university's config for ONE degree level
(slug, name, degree, sourceUrls) as a JSON object on stdin, scrapes those
pages, asks a local Ollama model (llama3.1:8b by default) to pull out
facts for that degree level only -- tuition, admissions requirements,
scholarships, deadlines -- and prints the resulting JSON object to
stdout. This script has no idea MongoDB exists -- the caller
(server/server.js) is responsible for persisting whatever this prints,
typically at universities_info.programs.<degree>.

`degree` is one of: bachelor, master, doctorate, exchange (defaults to
"bachelor" if omitted or unrecognized). A separate call per degree level
is deliberate -- it keeps each prompt small and focused rather than
asking the model to juggle four degree levels' worth of facts at once.

Usage:
    echo '{"slug":"oxford","name":"University of Oxford","degree":"bachelor","sourceUrls":["https://..."]}' \
        | python extract.py

    python extract.py --model llama3.1:8b --ollama-url http://localhost:11434 < payload.json

Called by server/server.js on every cache miss, but also runs standalone
for testing -- e.g. from the scraper/ folder:
    echo '{"slug":"mit","name":"MIT","degree":"master","sourceUrls":["https://..."]}' | python extract.py
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup, Comment, NavigableString

from ollama_client import call_ollama, DEFAULT_MODEL, DEFAULT_OLLAMA_URL

REQUEST_TIMEOUT = 20          # seconds, per page fetch
MAX_CHARS_PER_PAGE = 6000     # keep each page's extracted text bounded
MAX_CHARS_TOTAL = 16000       # keep the whole prompt bounded for an 8B model

# A custom, self-identifying UA ("BilimLaunchBot/...") is exactly what
# university admissions sites' edge/bot protection (Oxford's included)
# tends to block outright, even for a single polite request. This mimics
# an ordinary desktop Chrome request instead -- full header set, not just
# the UA string, since bot checks often look at the combination. This is
# fine for the private, personal-volume use this was built for; it is not
# a way to bypass real anti-bot challenges (Cloudflare JS challenges,
# CAPTCHAs) -- a site using those will still block `requests`, which can't
# execute JavaScript, no matter what headers are sent.
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
REQUEST_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# Tags that are never useful for extracting admissions facts -- layout,
# navigation, media, and interactive chrome. Removed (with their content)
# before anything else, so none of this reaches the LLM.
JUNK_TAGS = [
    "script", "style", "nav", "header", "footer", "noscript", "svg", "form",
    "button", "input", "select", "textarea", "iframe", "img", "picture",
    "source", "video", "audio", "canvas", "map", "area", "object", "embed",
    "link", "meta", "aside", "figure", "figcaption",
]

# Everything the LLM actually needs: headings for structure, paragraphs and
# list items for the actual requirements/scholarship text, tables for fees
# and deadlines, blockquotes for callouts. Content sitting outside all of
# these (bare divs/spans with no semantic wrapper) is treated as chrome and
# dropped -- this is the token-reduction step.
HEADING_TAGS = ["h1", "h2", "h3", "h4"]
BLOCK_TAGS = HEADING_TAGS + ["p", "li", "table", "blockquote"]

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


def table_to_lines(table_tag):
    """Render a <table> as compact 'cell | cell | cell' rows."""
    rows = []
    for tr in table_tag.find_all("tr"):
        cells = tr.find_all(["th", "td"])
        cell_texts = [c.get_text(" ", strip=True) for c in cells]
        cell_texts = [c for c in cell_texts if c]
        if cell_texts:
            rows.append(" | ".join(cell_texts))
    return rows


def fetch_page_text(url):
    """Fetch a page and return only the text inside content-bearing tags
    (headings, paragraphs, list items, tables, blockquotes, links) --
    everything else (nav, layout wrappers, scripts, media, forms) never
    reaches the LLM, which keeps the prompt small and free of boilerplate.
    """
    log(f"Fetching {url}")
    try:
        resp = requests.get(url, headers=REQUEST_HEADERS, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException as exc:
        log(f"  could not fetch {url}: {exc}")
        return ""

    # Parse from raw bytes rather than resp.text: BeautifulSoup's own
    # encoding detection (meta charset, BOM, etc.) is more reliable for
    # HTML than requests' header-only guess, which silently mojibake's
    # currency symbols and other non-ASCII characters on pages that don't
    # declare charset in the Content-Type header.
    soup = BeautifulSoup(resp.content, "html.parser")

    for comment in soup.find_all(string=lambda s: isinstance(s, Comment)):
        comment.extract()

    for tag in soup(JUNK_TAGS):
        tag.decompose()

    main = soup.find("main") or soup.find(attrs={"role": "main"}) or soup.body or soup

    # Keep emphasis visible to the model (a bolded line is often the
    # important bit -- a deadline, a hard requirement) by folding it into
    # the text as markdown before we flatten each block to plain text.
    for tag in main.find_all(["strong", "b"]):
        tag.replace_with(NavigableString(f"**{tag.get_text(' ', strip=True)}**"))
    for tag in main.find_all("em"):
        tag.replace_with(NavigableString(f"_{tag.get_text(' ', strip=True)}_"))

    lines = []
    for tag in main.find_all(BLOCK_TAGS):
        # A block tag nested inside another one we're already capturing
        # (a <p> inside a <li>, a <p> inside a <td>) would otherwise get
        # emitted twice -- once as part of the parent's text, once on its
        # own. Skip it here; the parent already covers it.
        if tag.find_parent(BLOCK_TAGS):
            continue

        if tag.name in HEADING_TAGS:
            text = tag.get_text(" ", strip=True)
            if text:
                lines.append(f"{'#' * int(tag.name[1])} {text}")
        elif tag.name == "li":
            text = tag.get_text(" ", strip=True)
            if text:
                lines.append(f"- {text}")
        elif tag.name == "blockquote":
            text = tag.get_text(" ", strip=True)
            if text:
                lines.append(f"> {text}")
        elif tag.name == "table":
            table_lines = table_to_lines(tag)
            if table_lines:
                lines.append("[TABLE]")
                lines.extend(table_lines)
                lines.append("[/TABLE]")
        else:  # p
            text = tag.get_text(" ", strip=True)
            if text:
                lines.append(text)

    # Links that aren't already inside one of the blocks above (a bare
    # "Apply now" link sitting directly in a layout div, say) -- still
    # worth a line, since they can carry a requirement in their label.
    for a in main.find_all("a"):
        if a.find_parent(BLOCK_TAGS):
            continue
        text = a.get_text(" ", strip=True)
        if text:
            lines.append(text)

    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text[:MAX_CHARS_PER_PAGE]


def build_prompt(uni, pages):
    sections = []
    total = 0
    for url, text in pages:
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

    source_urls = uni.get("sourceUrls") or []
    pages = [(url, fetch_page_text(url)) for url in source_urls]

    prompt = build_prompt(uni, pages)
    extracted = call_ollama(prompt, model, ollama_url)
    extracted = normalize_result(extracted, uni)

    extracted["sources"] = source_urls
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