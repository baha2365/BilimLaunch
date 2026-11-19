#!/usr/bin/env python3
"""
BilimLaunch -- AI University Admissions Advisor.

Stateless: reads one JSON object on stdin, prints one JSON object on stdout.
Which requirements exist and which tasks are in the roadmap is decided by
backend/admissions/*.js from the university's scraped pages; this script only
explains and helps. Two modes:

  {"mode": "summary", "profile", "university", "gap", "tasks"}
      -> {"summary", "priorities": [..], "generated_at", "model"}
      A short personal assessment of the student's situation.

  {"mode": "assist", "profile", "university", "task", "history", "message"}
      -> {"reply", "generated_at", "model"}
      The Task Assistant: helps the student actually do ONE roadmap task
      (draft a CV, plan IELTS preparation, ...).

The prompts forbid inventing facts about the student or the university, and
for the summary a post-check drops any sentence containing a number that was
not in the input.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone

from ollama_client import call_ollama, chat_ollama, DEFAULT_MODEL, DEFAULT_OLLAMA_URL, log

PROFILE_LABELS = [
    ("country", "Country of residence"), ("university", "Current university"),
    ("fieldOfStudy", "Field of study"), ("currentYear", "Current year"), ("gpa", "GPA (4.0 scale)"),
    ("ielts", "IELTS"), ("targetDegree", "Target degree"), ("targetCountries", "Target countries"),
    ("extracurriculars", "Experience"),
]
MAX_HISTORY = 12
MAX_REPLY_CHARS = 5000


def profile_lines(profile):
    return [f"- {label}: {profile[key]}" for key, label in PROFILE_LABELS if profile.get(key)] or ["- (profile is empty)"]


def university_lines(uni):
    lines = [f"- University: {uni.get('name')}"]
    for key, label in (("programme", "Programme"), ("degree_level", "Level"), ("intake", "Intake"),
                       ("deadline", "Application deadline"), ("deadline_note", "Deadline note")):
        if uni.get(key):
            lines.append(f"- {label}: {uni[key]}")
    return lines


# --------------------------------------------------------------------------- #
# summary                                                                     #
# --------------------------------------------------------------------------- #

def build_summary_prompt(payload):
    gap_lines = [
        f"- {r.get('label')}: university asks \"{r.get('required')}\"; student: \"{r.get('student')}\"; status: {r.get('status')}"
        for r in payload.get("gap") or []
    ] or ["- (no entry requirements were found on the university's pages)"]
    task_lines = [f"- {t}" for t in payload.get("tasks") or []] or ["- (none)"]
    return f"""You are an admissions advisor writing to a student ("you") about their plan to apply to one university.

Use ONLY the facts below. Do not invent requirements, deadlines, fees, rankings or numbers. If something
is not listed, do not mention it. Do not promise admission and do not estimate their chances.

STUDENT:
{chr(10).join(profile_lines(payload.get('profile') or {}))}

TARGET:
{chr(10).join(university_lines(payload.get('university') or {}))}

REQUIREMENT CHECK (status: met / missing / unknown / optional):
{chr(10).join(gap_lines)}

NEXT TASKS IN THEIR ROADMAP:
{chr(10).join(task_lines)}

Write:
1. "summary": 3 to 4 sentences, friendly and direct. Say where they stand (what is already fine, what is missing)
   and what matters most now.
2. "priorities": exactly 3 short action items (each under 18 words), most urgent first, based on the missing
   or unknown items and the next tasks.

Return ONLY a JSON object: {{"summary": "...", "priorities": ["...", "...", "..."]}}
"""


def numbers_in(text):
    return {n.strip(".,") for n in re.findall(r"\d[\d.,]*", text) if n.strip(".,")}


def drop_unsupported(text, source):
    """Removes sentences that contain a number which isn't in the input."""
    kept = []
    for sentence in re.split(r"(?<=[.!?])\s+", text.strip()):
        if all(n.lower() in source for n in numbers_in(sentence)):
            kept.append(sentence)
    return " ".join(kept).strip()


def run_summary(payload, model, ollama_url):
    source = json.dumps(payload, ensure_ascii=False).lower()
    result = call_ollama(build_summary_prompt(payload), model, ollama_url, temperature=0.3)
    summary = drop_unsupported(str(result.get("summary") or ""), source)
    priorities = []
    for item in result.get("priorities") or []:
        text = drop_unsupported(str(item or "").strip(), source)
        if text and len(text) <= 200:
            priorities.append(text)
    if len(summary) < 40:
        raise ValueError("The model returned an empty or too-short summary. Try again.")
    return {
        "summary": summary[:900],
        "priorities": priorities[:3],
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": model,
    }


# --------------------------------------------------------------------------- #
# task assistant                                                              #
# --------------------------------------------------------------------------- #

def build_system_prompt(payload):
    task = payload.get("task") or {}
    steps = "\n".join(f"{i}. {s}" for i, s in enumerate(task.get("steps") or [], 1)) or "(none)"
    requirement = f"Requirement it satisfies: {task['requirement']}" if task.get("requirement") else ""
    return f"""You are the BilimLaunch Task Assistant. You help a student actually DO one task from their university
application roadmap, not just talk about it.

RULES
- Use only the facts in CONTEXT and what the student tells you in this chat. Never invent the student's
  achievements, grades, employers, names, dates or projects, and never invent facts about the university.
- If you draft a document (CV, letter, email, plan), write placeholders like [your project name] for anything you
  do not know. If you need information first, ask for it: at most 3 questions at a time.
- Do not state admission requirements, deadlines, fees or scores that are not in CONTEXT. If asked, say to confirm on
  the university's official page.
- Never promise or predict that the student will be admitted.
- Be concrete and brief. Prefer short lists and ready-to-use text over general advice. Under 250 words unless you are
  drafting a document.
- Reply in the language the student writes in (English, Russian or Kazakh).

CONTEXT
Student:
{chr(10).join(profile_lines(payload.get('profile') or {}))}

Target:
{chr(10).join(university_lines(payload.get('university') or {}))}

Current task: {task.get('title')}
Stage: {task.get('stage')}
Why it matters: {task.get('why') or '-'}
Planned steps:
{steps}
{requirement}
"""


def run_assist(payload, model, ollama_url):
    message = str(payload.get("message") or "").strip()
    if not message:
        raise ValueError("Empty message.")
    messages = [{"role": "system", "content": build_system_prompt(payload)}]
    for turn in (payload.get("history") or [])[-MAX_HISTORY:]:
        role = turn.get("role")
        content = str(turn.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content[:3000]})
    messages.append({"role": "user", "content": message[:3000]})

    reply = chat_ollama(messages, model, ollama_url, temperature=0.5)
    if not reply:
        raise ValueError("The model returned an empty answer. Try again.")
    return {
        "reply": reply[:MAX_REPLY_CHARS],
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
        mode = payload.get("mode")
        if mode == "summary":
            out = run_summary(payload, args.model, args.ollama_url)
        elif mode == "assist":
            out = run_assist(payload, args.model, args.ollama_url)
        else:
            raise ValueError(f"Unknown mode '{mode}'")
        print(json.dumps(out, ensure_ascii=False))
    except Exception as exc:
        log("advisor", f"Failed: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
