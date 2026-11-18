"""Task-planning agent.

Workflow: the LLM reads the user's message, decides whether they want to plan
something, and calls one of two tools:
  - list_tasks:     read the user's open tasks (so it can avoid duplicates / answer questions)
  - suggest_tasks:  propose actionable tasks (the user confirms them in the UI)
Tasks are only *suggested*, never created without user approval.
"""
import json
import os
import re
from datetime import date

from sqlalchemy.orm import Session
from . import models

MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_tasks",
            "description": "Get the user's current open tasks.",
            "parameters": {
                "type": "object",
                "properties": {
                    "present_to_user": {
                        "type": "boolean",
                        "default": True,
                        "description": "Show the tasks to the user (default true). Set false for a background lookup for planning or duplicate avoidance.",
                    }
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "suggest_tasks",
            "description": "Propose 1-6 concrete, actionable tasks extracted from the user's request.",
            "parameters": {
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string", "description": "Short verb-first title"},
                                "notes": {"type": "string"},
                                "priority": {"type": "string", "enum": ["low", "medium", "high"]},
                                "due": {"type": "string", "description": "YYYY-MM-DD or empty"},
                            },
                            "required": ["title", "priority"],
                        },
                    }
                },
                "required": ["tasks"],
            },
        },
    },
]


def _system_prompt() -> str:
    return (
        "You are TaskPilot, a concise, friendly assistant that helps people organize their day. "
        f"Today is {date.today().isoformat()}. "
        "When the user describes things they need to do, call suggest_tasks with clear, verb-first tasks "
        "(break big items down, infer sensible priorities and due dates). "
        "When they ask to see existing tasks or what's on their plate, call list_tasks with present_to_user=true. "
        "For background lookups for planning or duplicate avoidance, use present_to_user=false. "
        "Visible listings are attached as interactive task lists with completion checkboxes; "
        "never enumerate attached task titles in prose. "
        "Never create or complete tasks yourself; the user approves suggestions and marks tasks done in the UI. "
        "For anything else, just reply conversationally. "
        "After suggesting, write a short reply (1-3 sentences) and mention they can add the tasks with one click."
    )


def _open_tasks(db: Session) -> list[dict]:
    rows = db.query(models.Task).filter_by(done=False).order_by(models.Task.id).all()
    return [{"id": t.id, "title": t.title, "priority": t.priority, "due": t.due} for t in rows]


def _listing_reply(task_ids: list[int], suggestions: list[dict]) -> str:
    reply = (
        "Here are your open tasks. Use the completion checkboxes to mark them done."
        if task_ids else
        "You have no open tasks. Tell me what's coming up and I'll plan it."
    )
    if suggestions:
        reply += " You can add any of the suggested tasks with one click."
    return reply


def run_agent(db: Session, history: list[dict], user_text: str) -> tuple[str, list[dict], list[int]]:
    if not os.getenv("OPENAI_API_KEY"):
        return _demo_agent(db, user_text)

    from openai import OpenAI

    client = OpenAI()
    messages = [{"role": "system", "content": _system_prompt()}, *history,
                {"role": "user", "content": user_text}]
    suggestions: list[dict] = []
    presented_task_ids: list[int] = []
    seen_task_ids: set[int] = set()
    visible_listing = False

    def finalize(reply: str) -> tuple[str, list[dict], list[int]]:
        if visible_listing:
            reply = _listing_reply(presented_task_ids, suggestions)
        return reply, suggestions, presented_task_ids

    for _ in range(3):  # small tool-calling loop
        resp = client.chat.completions.create(model=MODEL, messages=messages, tools=TOOLS)
        msg = resp.choices[0].message
        if not msg.tool_calls:
            return finalize(msg.content or "")
        messages.append(msg)
        for call in msg.tool_calls:
            args = json.loads(call.function.arguments or "{}")
            if call.function.name == "list_tasks":
                tasks = _open_tasks(db)
                if args.get("present_to_user", True):
                    visible_listing = True
                    for task in tasks:
                        if task["id"] not in seen_task_ids:
                            seen_task_ids.add(task["id"])
                            presented_task_ids.append(task["id"])
                result = json.dumps(tasks)
            else:
                suggestions = [_clean(t) for t in args.get("tasks", [])]
                result = "Suggestions shown to the user."
            messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
    return finalize("Here's what I came up with.")


def _clean(t: dict) -> dict:
    pr = t.get("priority", "medium")
    return {
        "title": str(t.get("title", "")).strip()[:200],
        "notes": t.get("notes", "") or "",
        "priority": pr if pr in ("low", "medium", "high") else "medium",
        "due": t.get("due") or None,
    }


def _demo_agent(db: Session, text: str) -> tuple[str, list[dict], list[int]]:
    """Offline fallback so the app can be demoed without an API key."""
    low = text.lower()
    if re.search(r"what('s| is| do i have)|my tasks|on my plate", low):
        tasks = _open_tasks(db)
        task_ids = [t["id"] for t in tasks]
        return _listing_reply(task_ids, []), [], task_ids
    parts = [p.strip(" .") for p in re.split(r",|;|\band\b|\bthen\b", text) if len(p.strip()) > 3]
    if not parts:
        return "Tell me what you need to get done and I'll turn it into tasks.", [], []
    sugg = [
        {"title": p[0].upper() + p[1:], "notes": "", "due": None,
         "priority": "high" if re.search(r"urgent|asap|today|deadline", low) else "medium"}
        for p in parts[:6]
    ]
    return f"I found {len(sugg)} task(s). Add the ones you want (demo mode: set OPENAI_API_KEY for the real agent).", sugg, []
