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
            "parameters": {"type": "object", "properties": {}},
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
        "When they ask what's on their plate, call list_tasks first. "
        "For anything else, just reply conversationally. "
        "After suggesting, write a short reply (1-3 sentences) and mention they can add the tasks with one click."
    )


def _open_tasks(db: Session) -> list[dict]:
    rows = db.query(models.Task).filter_by(done=False).order_by(models.Task.id).all()
    return [{"id": t.id, "title": t.title, "priority": t.priority, "due": t.due} for t in rows]


def run_agent(db: Session, history: list[dict], user_text: str) -> tuple[str, list[dict]]:
    if not os.getenv("OPENAI_API_KEY"):
        return _demo_agent(db, user_text)

    from openai import OpenAI

    client = OpenAI()
    messages = [{"role": "system", "content": _system_prompt()}, *history,
                {"role": "user", "content": user_text}]
    suggestions: list[dict] = []

    for _ in range(3):  # small tool-calling loop
        resp = client.chat.completions.create(model=MODEL, messages=messages, tools=TOOLS)
        msg = resp.choices[0].message
        if not msg.tool_calls:
            return msg.content or "", suggestions
        messages.append(msg)
        for call in msg.tool_calls:
            args = json.loads(call.function.arguments or "{}")
            if call.function.name == "list_tasks":
                result = json.dumps(_open_tasks(db))
            else:
                suggestions = [_clean(t) for t in args.get("tasks", [])]
                result = "Suggestions shown to the user."
            messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
    return "Here's what I came up with.", suggestions


def _clean(t: dict) -> dict:
    pr = t.get("priority", "medium")
    return {
        "title": str(t.get("title", "")).strip()[:200],
        "notes": t.get("notes", "") or "",
        "priority": pr if pr in ("low", "medium", "high") else "medium",
        "due": t.get("due") or None,
    }


def _demo_agent(db: Session, text: str) -> tuple[str, list[dict]]:
    """Offline fallback so the app can be demoed without an API key."""
    low = text.lower()
    if re.search(r"what('s| is| do i have)|my tasks|on my plate", low):
        tasks = _open_tasks(db)
        if not tasks:
            return "You have no open tasks. Tell me what's coming up and I'll plan it.", []
        return "Open tasks: " + "; ".join(t["title"] for t in tasks) + ".", []
    parts = [p.strip(" .") for p in re.split(r",|;|\band\b|\bthen\b", text) if len(p.strip()) > 3]
    if not parts:
        return "Tell me what you need to get done and I'll turn it into tasks.", []
    sugg = [
        {"title": p[0].upper() + p[1:], "notes": "", "due": None,
         "priority": "high" if re.search(r"urgent|asap|today|deadline", low) else "medium"}
        for p in parts[:6]
    ]
    return f"I found {len(sugg)} task(s). Add the ones you want (demo mode: set OPENAI_API_KEY for the real agent).", sugg
