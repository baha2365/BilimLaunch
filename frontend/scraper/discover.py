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

Only searches for what's actually missing from `existing`, so re-running
this on a university that already has e.g. bachelor's and master's URls
only searches for doctorate/exchange -- important since each university
costs several searches plus one Ollama call, and there may be 30 of them.

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
RESULTS_PER_QUERY = 6
SEARCH_DELAY_SECONDS = 1.5  # be a little polite between queries, even for personal use


def log(message):
    print(f"[discover] {message}", file=sys.stderr, flush=True)


def slugify(name):
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return slug or "university"


def missing_parts(existing):
    existing = existing or {}
    source_urls = existing.get("sourceUrls") or {}
    needs_official = not existing.get("officialSite")
    needs_degrees = [d for d in DEGREES if not source_urls.get(d)]
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
        log(f"Searching: {degree} -- {query}")
        add_results(search(query, max_results=RESULTS_PER_QUERY), degree)
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
    {", ".join(f'"{d}": ["<0-2 URLs from the candidates>"]' for d in DEGREES)}
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
            if config["sourceUrls"][degree]:
                continue  # already had URLs for this degree -- don't touch it
            urls = claimed_sources.get(degree)
            if not isinstance(urls, list):
                continue
            kept = []
            for url in urls:
                if isinstance(url, str) and url in candidate_urls:
                    kept.append(url)
                elif isinstance(url, str):
                    log(f"Dropped invented {degree} URL (not in search results): {url}")
            config["sourceUrls"][degree] = kept[:3]

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