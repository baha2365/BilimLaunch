"""
DuckDuckGo web search -- used to discover university pages when
universities_init or universities_info don't have enough to go on.

Private/personal use only, as this was requested for: there's no official
DuckDuckGo search API, so this uses the `ddgs` package, which POSTs to
DuckDuckGo's own HTML search page the same way a browser would. That's a
reasonable thing to do occasionally for personal research; it has no SLA,
no API key, and can start failing (rate limits, a changed page layout)
without warning. Not something to run at real volume or ship as a
production dependency.
"""

import sys
import time

try:
    from ddgs import DDGS
    from ddgs.exceptions import DDGSException
except ImportError:  # pragma: no cover -- exercised when the package isn't installed
    DDGS = None
    DDGSException = Exception

DEFAULT_MAX_RESULTS = 6
RETRY_DELAY_SECONDS = 3
MAX_RETRIES = 2


def log(message):
    print(f"[web_search] {message}", file=sys.stderr, flush=True)


def search(query, max_results=DEFAULT_MAX_RESULTS):
    """Returns a list of {"title", "url", "snippet"} dicts, or [] on any
    failure. Callers should treat an empty list as "found nothing for this
    query" and move on -- one bad/rate-limited query should never crash a
    batch job that's partway through 30 universities.
    """
    if DDGS is None:
        log("the 'ddgs' package isn't installed -- run: pip install ddgs")
        return []

    for attempt in range(1, MAX_RETRIES + 2):
        try:
            with DDGS() as ddgs:
                raw = ddgs.text(query, backend="duckduckgo", max_results=max_results)
            return [
                {"title": (r.get("title") or "").strip(), "url": r.get("href") or "", "snippet": (r.get("body") or "").strip()}
                for r in raw
                if r.get("href")
            ]
        except DDGSException as exc:
            log(f"'{query}' failed (attempt {attempt}/{MAX_RETRIES + 1}): {exc}")
            if attempt <= MAX_RETRIES:
                time.sleep(RETRY_DELAY_SECONDS * attempt)
        except Exception as exc:  # noqa: BLE001 -- never let one bad query kill the batch
            log(f"'{query}' failed unexpectedly: {exc}")
            break
    return []