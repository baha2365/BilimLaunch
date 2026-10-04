#!/usr/bin/env python3
"""
BilimLaunch -- university config discovery.

Given a university name (and, optionally, whatever config already exists
for it), searches the web for its official site and admissions pages per
degree level, then asks the local model to organize the *real, retrieved*
search results into a config object -- it is never allowed to invent a
URL that wasn't actually returned by search.

Stdin:  {"name": "...", "existing": {...partial universities_init doc...}}
Stdout: a full universities_init-shaped config object.

A degree level is searched whenever it has fewer than TARGET_URLS_PER_DEGREE
source pages -- not just when it's completely empty. That matters because
a generic admissions homepage (common in a starting list assembled by
hand) technically counts as "having a URL" but rarely states actual
tuition numbers; this still searches for a second, more specific page
(two separate queries per degree: one for admission requirements, one
specifically for fees/tuition) and appends whatever real results it finds,
up to MAX_URLS_PER_DEGREE, rather than leaving a thin degree thin forever.
A degree level already at the cap is skipped -- so re-running this is
still cheap for universities that already have good coverage.

Usage:
    echo '{"name": "University of Oxford"}' | python discover.py
    echo '{"name": "MIT", "existing": {...}}' | python discover.py
"""

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone

from ollama_client import call_ollama, DEFAULT_MODEL, DEFAULT_OLLAMA_URL
from web_search import search

DEGREES = ["bachelor", "master", "doctorate", "exchange"]
DEGREE_QUERY_HINT = {
    "bachelor": "bachelor's degree admission requirements international students",
    "master": "master's degree admission requirements international students",
    "doctorate": "PhD doctoral admission requirements international students",
    "exchange": "exchange program study abroad international students",
}
# A second, separate query per degree level, specifically aimed at the
# dedicated fees/tuition page -- without this, a university whose only
# known page is a generic admissions homepage (as many of the 30 starting
# entries are) never gets a chance at a page that actually states numbers,
# since gather_candidates only searched "admission requirements" style
# queries, which tend to surface process pages rather than cost pages.
DEGREE_FEE_QUERY_HINT = {
    "bachelor": "bachelor's degree tuition fees cost international students",
    "master": "master's degree tuition fees cost international students",
    "doctorate": "PhD doctoral program tuition fees funding",
    "exchange": "exchange program fees cost international students",
}
RESULTS_PER_QUERY = 6
SEARCH_DELAY_SECONDS = 1.5  # be a little polite between queries, even for personal use

# A degree level counts as "needing more" if it has fewer than this many
# source pages -- not just zero. This is what lets discovery improve a
# degree level that already has one generic/shallow URL (common for the
# 30-university starting list) rather than only ever filling a blank.
TARGET_URLS_PER_DEGREE = 2
MAX_URLS_PER_DEGREE = 3


def log(message):
    print(f"[discover] {message}", file=sys.stderr, flush=True)


def slugify(name):
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return slug or "university"


def missing_parts(existing):
    existing = existing or {}
    source_urls = existing.get("sourceUrls") or {}
    needs_official = not existing.get("officialSite")
    needs_degrees = [d for d in DEGREES if len(source_urls.get(d) or []) < TARGET_URLS_PER_DEGREE]
    return needs_official, needs_degrees


def gather_candidates(name, needs_official, needs_degrees):
    """Runs only the searches actually needed, returns a deduped list of
    {url, title, snippet, categories} -- `categories` says which query
    category(ies) a URL showed up under, so the model has a hint without
    us losing the raw title/snippet it should actually reason from.
    """
    by_url = {}

    def add_results(results, category):
        for r in results:
            if not r["url"]:
                continue
            entry = by_url.setdefault(r["url"], {"url": r["url"], "title": r["title"], "snippet": r["snippet"], "categories": []})
            if category not in entry["categories"]:
                entry["categories"].append(category)

    if needs_official:
        log(f"Searching: official site for {name}")
        add_results(search(f"{name} official website", max_results=RESULTS_PER_QUERY), "official")
        time.sleep(SEARCH_DELAY_SECONDS)

    for degree in needs_degrees:
        query = f"{name} {DEGREE_QUERY_HINT[degree]}"
        log(f"Searching: {degree} requirements -- {query}")
        add_results(search(query, max_results=RESULTS_PER_QUERY), f"{degree} (requirements)")
        time.sleep(SEARCH_DELAY_SECONDS)

        fee_query = f"{name} {DEGREE_FEE_QUERY_HINT[degree]}"
        log(f"Searching: {degree} fees -- {fee_query}")
        add_results(search(fee_query, max_results=RESULTS_PER_QUERY), f"{degree} (fees)")
        time.sleep(SEARCH_DELAY_SECONDS)

    return list(by_url.values())


def build_prompt(name, candidates, needs_official, needs_degrees):
    candidates_text = "\n".join(
        f"- url: {c['url']}\n  title: {c['title']}\n  snippet: {c['snippet']}\n  found under: {', '.join(c['categories'])}"
        for c in candidates
    ) or "(no search results were found)"

    degree_list = ", ".join(needs_degrees) if needs_degrees else "(none needed)"

    return f"""You are organizing real web search results about a university into a
structured record. You may ONLY use URLs that appear verbatim in the
CANDIDATE RESULTS below -- never invent, guess, or modify a URL. If none
of the candidates are clearly right for a field, leave that field null or
an empty list rather than guessing.

University: {name}

Fields to fill: {"officialSite, " if needs_official else ""}country, city,
shortName, and admissions-page URLs for: {degree_list}.

CANDIDATE RESULTS (the only URLs you may use):
{candidates_text}

Return ONLY a single JSON object with exactly this shape (no extra keys,
no commentary, no markdown fences):

{{
  "officialSite": "<one URL from the candidates, or null>",
  "country": "<string, or null>",
  "city": "<string, or null>",
  "shortName": "<a short common name for the university, e.g. 'Oxford'>",
  "sourceUrls": {{
    {", ".join(f'"{d}": ["<0-{MAX_URLS_PER_DEGREE} URLs from the candidates, prefer one that covers requirements and one that covers fees/cost if both exist>"]' for d in DEGREES)}
  }}
}}

Only fill in "sourceUrls" entries for: {degree_list}. Leave any other
degree key as an empty list.
"""


def validate_and_merge(name, existing, model_output, candidate_urls):
    """Trust-but-verify: anything the model claims as a URL is thrown out
    unless it's one of the URLs we actually retrieved. This is the same
    principle match.py applies to factual claims -- the model organizes
    real data, it doesn't get to invent any.
    """
    existing = dict(existing or {})
    model_output = model_output if isinstance(model_output, dict) else {}

    slug = existing.get("slug") or slugify(name)
    config = {
        "slug": slug,
        "name": existing.get("name") or name,
        "shortName": existing.get("shortName") or (model_output.get("shortName") if isinstance(model_output.get("shortName"), str) else None) or name,
        "country": existing.get("country") or (model_output.get("country") if isinstance(model_output.get("country"), str) else None),
        "city": existing.get("city") or (model_output.get("city") if isinstance(model_output.get("city"), str) else None),
        "officialSite": existing.get("officialSite"),
        "sourceUrls": dict(existing.get("sourceUrls") or {}),
    }

    for degree in DEGREES:
        config["sourceUrls"].setdefault(degree, [])

    claimed_official = model_output.get("officialSite")
    if not config["officialSite"] and isinstance(claimed_official, str):
        if claimed_official in candidate_urls:
            config["officialSite"] = claimed_official
        else:
            log(f"Dropped invented officialSite (not in search results): {claimed_official}")

    claimed_sources = model_output.get("sourceUrls")
    if isinstance(claimed_sources, dict):
        for degree in DEGREES:
            current = config["sourceUrls"][degree]
            if len(current) >= MAX_URLS_PER_DEGREE:
                continue  # already have enough for this degree -- don't keep piling on
            urls = claimed_sources.get(degree)
            if not isinstance(urls, list):
                continue
            for url in urls:
                if len(current) >= MAX_URLS_PER_DEGREE:
                    break
                if not isinstance(url, str):
                    continue
                if url not in candidate_urls:
                    log(f"Dropped invented {degree} URL (not in search results): {url}")
                    continue
                if url in current:
                    continue  # already have this exact page
                current.append(url)

    return config


def run(name, existing, model, ollama_url):
    needs_official, needs_degrees = missing_parts(existing)
    if not needs_official and not needs_degrees:
        log(f"{name} already has everything -- nothing to discover.")
        return validate_and_merge(name, existing, {}, set())

    candidates = gather_candidates(name, needs_official, needs_degrees)
    candidate_urls = {c["url"] for c in candidates}

    if not candidates:
        log(f"No search results at all for {name} -- returning what we already had.")
        return validate_and_merge(name, existing, {}, candidate_urls)

    prompt = build_prompt(name, candidates, needs_official, needs_degrees)
    log(f"Asking {model} to organize {len(candidates)} search results for {name}...")
    model_output = call_ollama(prompt, model, ollama_url)
    return validate_and_merge(name, existing, model_output, candidate_urls)


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

    name = payload.get("name")
    if not name:
        log("Failed: 'name' is required")
        sys.exit(1)

    try:
        config = run(name, payload.get("existing"), args.model, args.ollama_url)
        config["discovered_at"] = datetime.now(timezone.utc).isoformat()
        print(json.dumps(config, indent=2, ensure_ascii=False))
    except Exception as exc:  # surface any failure clearly to whoever called this
        log(f"Failed: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()