"""
Shared local-Ollama client for BilimLaunch's Python scripts (extract.py,
match.py). Kept dependency-free beyond `requests` so either script can
import it without pulling in the other's scraping/matching logic.
"""

import json
import re
import sys

import requests

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "llama3.1:8b"
OLLAMA_TIMEOUT = 600  # seconds -- local 8B models can be slow on CPU


def log(prefix, message):
    """Progress goes to stderr so stdout can stay clean JSON-on-success."""
    print(f"[{prefix}] {message}", file=sys.stderr, flush=True)


def call_ollama(prompt, model=DEFAULT_MODEL, ollama_url=DEFAULT_OLLAMA_URL, temperature=0.1):
    """Sends prompt to Ollama's /api/generate with JSON-mode forced on, and
    returns the parsed JSON object the model responded with. Raises
    RuntimeError/ValueError with a message that's safe to show a user for
    the common failure cases (Ollama not running, model not pulled,
    non-JSON output).
    """
    try:
        resp = requests.post(
            f"{ollama_url.rstrip('/')}/api/generate",
            json={
                "model": model,
                "prompt": prompt,
                "format": "json",
                "stream": False,
                "options": {"temperature": temperature},
            },
            timeout=OLLAMA_TIMEOUT,
        )
    except requests.exceptions.ConnectionError as exc:
        raise RuntimeError(
            f"Could not reach Ollama at {ollama_url}. Is it running? Try: ollama serve"
        ) from exc

    if resp.status_code == 404:
        raise RuntimeError(f"Ollama doesn't know model '{model}'. Try: ollama pull {model}")
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