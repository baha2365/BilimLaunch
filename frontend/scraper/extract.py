#!/usr/bin/env python3
"""
BilimLaunch -- bachelor's degree info extractor.

Stateless by design: reads one university's config (slug, name,
sourceUrls) as a JSON object on stdin, scrapes those pages, asks a local
Ollama model (llama3.1:8b by default) to pull out bachelor's-degree-only
facts, and prints the resulting JSON object to stdout. This script has no
idea MongoDB (or any cache) exists -- the caller (server/server.js) is
responsible for persisting whatever this prints.

Usage:
    echo '{"slug":"oxford","name":"University of Oxford","sourceUrls":["https://..."]}' \
        | python extract.py

    python extract.py --model llama3.1:8b --ollama-url http://localhost:11434 < payload.json

Called by server/server.js on every cache miss, but also runs standalone
for testing -- e.g. from the scraper/ folder:
    echo '{"slug":"mit","name":"MIT","sourceUrls":["https://facts.mit.edu/..."]}' | python extract.py
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup, Comment, NavigableString

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "llama3.1:8b"
REQUEST_TIMEOUT = 20          # seconds, per page fetch
OLLAMA_TIMEOUT = 600          # seconds -- local 8B models can be slow on CPU
MAX_CHARS_PER_PAGE = 6000     # keep each page's extracted text bounded
MAX_CHARS_TOTAL = 16000       # keep the whole prompt bounded for an 8B model
USER_AGENT = (
    "BilimLaunchBot/0.1 (educational study-abroad research aggregator; "
    "run locally, one request per page, contact: hello@bilimlaunch.example)"
)

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

# Shown to the model so it knows exactly which keys to fill in.
SCHEMA_HINT = {
    "university": "string",
    "degree_level": "Bachelor's / Undergraduate",
    "tuition": {
        "domestic_or_home": "string or null",
        "international": "string or null",
        "notes": "string or null",
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
        resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=REQUEST_TIMEOUT)
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

    return f"""You are extracting facts for a study-abroad app. Only use information that
appears in the SOURCE TEXT below. Do not invent numbers, names, or dates.
If something isn't stated in the source text, use null (or an empty list)
instead of guessing.

Extract information about UNDERGRADUATE / BACHELOR'S DEGREE study ONLY.
Ignore anything about postgraduate, master's, MBA, or PhD programs.

Return ONLY a single JSON object with exactly this shape (no extra keys,
no commentary, no markdown fences):

{json.dumps(SCHEMA_HINT, indent=2)}

University: {uni.get('name', 'Unknown university')}

SOURCE TEXT:
{scraped_text}
"""


def call_ollama(prompt, model, ollama_url):
    log(f"Asking {model} to extract structured info (this can take a minute on CPU)...")
    try:
        resp = requests.post(
            f"{ollama_url.rstrip('/')}/api/generate",
            json={
                "model": model,
                "prompt": prompt,
                "format": "json",
                "stream": False,
                "options": {"temperature": 0.1},
            },
            timeout=OLLAMA_TIMEOUT,
        )
    except requests.exceptions.ConnectionError as exc:
        raise RuntimeError(
            f"Could not reach Ollama at {ollama_url}. Is it running? Try: ollama serve"
        ) from exc

    if resp.status_code == 404:
        raise RuntimeError(
            f"Ollama doesn't know model '{model}'. Try: ollama pull {model}"
        )
    resp.raise_for_status()

    data = resp.json()
    raw = data.get("response", "")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if match:
            return json.loads(match.group(0))
        raise ValueError(f"Model did not return valid JSON:\n{raw[:500]}")


def normalize_result(result, uni):
    """Fill in any keys the model skipped so the caller never has to guess."""
    result.setdefault("university", uni.get("name", "Unknown university"))
    result.setdefault("degree_level", "Bachelor's / Undergraduate")
    tuition = result.setdefault("tuition", {})
    if not isinstance(tuition, dict):
        tuition = {}
        result["tuition"] = tuition
    tuition.setdefault("domestic_or_home", None)
    tuition.setdefault("international", None)
    tuition.setdefault("notes", None)
    if not isinstance(result.get("scholarships"), list):
        result["scholarships"] = []
    result.setdefault("financial_aid_summary", "")
    if not isinstance(result.get("key_deadlines"), list):
        result["key_deadlines"] = []
    result.setdefault("notes", "")
    return result


def run(uni, model, ollama_url):
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