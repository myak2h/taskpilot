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
                    },
                    "priority": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "Only return open tasks with this exact priority. Omit for all open tasks.",
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

RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "task_response",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "reply": {"type": "string"},
                "task_view": {
                    "anyOf": [
                        {
                            "type": "object",
                            "properties": {
                                "priority": {
                                    "type": ["string", "null"],
                                    "enum": ["low", "medium", "high", None],
                                }
                            },
                            "required": ["priority"],
                            "additionalProperties": False,
                        },
                        {"type": "null"},
                    ]
                },
            },
            "required": ["reply", "task_view"],
            "additionalProperties": False,
        },
    },
}


def _system_prompt() -> str:
    return (
        "You are TaskPilot, a concise, friendly assistant that helps people organize their day. "
        f"Today is {date.today().isoformat()}. "
        "When the user describes things they need to do, call suggest_tasks with clear, verb-first tasks "
        "(break big items down, infer sensible priorities and due dates). "
        "Return a final JSON object with reply and task_view. Every request to display existing tasks, "
        "regardless of wording or priority qualifier, must return a non-null task_view, even when no tasks match. "
        "Set task_view to {\"priority\": null} for all open tasks, or set its priority to low, medium, or high "
        "for the requested priority. The backend resolves this selection into interactive tasks with completion "
        "checkboxes; reply must never enumerate those tasks. "
        "For example, \"What's on my plate?\" requires task_view={\"priority\": null}; "
        "\"what are the high priority tasks on my plate?\" requires task_view={\"priority\": \"high\"}; "
        "\"List my low-priority tasks\" requires task_view={\"priority\": \"low\"}. "
        "Keep list_tasks available to inspect current tasks: when displaying them, use present_to_user=true "
        "and the requested priority filter, if any. For background lookups for planning or duplicate avoidance, "
        "use present_to_user=false. A background lookup alone does not mean the user wants a task view. "
        "Distinguish displaying existing tasks from proposing new ones: \"Buy milk and call mom\" requests "
        "suggestions, not a task_view. Use task_view=null when no display of existing tasks is requested. "
        "A request can ask for both an existing task view and new suggestions. "
        "Never create or complete tasks yourself; the user approves suggestions and marks tasks done in the UI. "
        "For anything else, just reply conversationally. "
        "After suggesting, write a short reply (1-3 sentences) and mention they can add the tasks with one click."
    )


def _open_tasks(db: Session, priority: str | None = None) -> list[dict]:
    query = db.query(models.Task).filter_by(done=False)
    if priority is not None:
        query = query.filter_by(priority=priority)
    rows = query.order_by(models.Task.id).all()
    return [{"id": t.id, "title": t.title, "priority": t.priority, "due": t.due} for t in rows]


def _listing_reply(task_ids: list[int], suggestions: list[dict], priority: str | None = None) -> str:
    if priority is not None:
        reply = (
            f"Here are your open {priority}-priority tasks. Use the completion checkboxes to mark them done."
            if task_ids else
            f"You have no open {priority}-priority tasks. Tasks of other priorities may still be open."
        )
    else:
        reply = (
            "Here are your open tasks. Use the completion checkboxes to mark them done."
            if task_ids else
            "You have no open tasks. Tell me what's coming up and I'll plan it."
        )
    if suggestions:
        reply += " You can add any of the suggested tasks with one click."
    return reply


def _parse_response(content: str) -> dict:
    result = json.loads(content)
    if not isinstance(result, dict) or set(result) != {"reply", "task_view"}:
        raise ValueError("Invalid structured task response")
    if not isinstance(result["reply"], str):
        raise ValueError("Structured reply must be a string")
    task_view = result["task_view"]
    if task_view is not None:
        if not isinstance(task_view, dict) or set(task_view) != {"priority"}:
            raise ValueError("Invalid structured task view")
        if task_view["priority"] not in ("low", "medium", "high", None):
            raise ValueError("Invalid task view priority")
    return result


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
    listing_priority: str | None = None

    def finalize(reply: str) -> tuple[str, list[dict], list[int]]:
        if visible_listing:
            reply = _listing_reply(presented_task_ids, suggestions, listing_priority)
        return reply, suggestions, presented_task_ids

    for _ in range(3):  # small tool-calling loop
        resp = client.chat.completions.create(
            model=MODEL, messages=messages, tools=TOOLS, response_format=RESPONSE_FORMAT
        )
        msg = resp.choices[0].message
        if not msg.tool_calls:
            result = _parse_response(msg.content or "")
            if result["task_view"] is not None:
                listing_priority = result["task_view"]["priority"]
                presented_task_ids = [task["id"] for task in _open_tasks(db, listing_priority)]
                visible_listing = True
            return finalize(result["reply"])
        messages.append(msg)
        for call in msg.tool_calls:
            args = json.loads(call.function.arguments or "{}")
            if call.function.name == "list_tasks":
                priority = args.get("priority")
                tasks = _open_tasks(db, priority)
                if args.get("present_to_user", True):
                    if not visible_listing:
                        listing_priority = priority
                    elif listing_priority != priority:
                        listing_priority = None
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
    if re.search(
        r"\bwhat('s| is| do i have)\b|"
        r"\b(?:show|list)\s+(?:(?:me|all|of|my|the|open|current|low|medium|high|priority)[\s-]+)*tasks\b|"
        r"\bwhich\s+(?:(?:of|my|the|open|current|low|medium|high|priority)[\s-]+)*tasks\b|"
        r"\bwhat are\s+(?:(?:all|of|my|the|open|current|low|medium|high|priority)[\s-]+)*tasks\b|"
        r"\b(?:show|list)\b.*\bon my plate\b|^\s*on my plate\b|"
        r"^\s*my\s+(?:(?:open|current|low|medium|high|priority)[\s-]+)*tasks\b",
        low,
    ):
        match = re.search(r"\b(low|medium|high)[\s-]+priority\b", low)
        priority = match.group(1) if match else None
        tasks = _open_tasks(db, priority)
        task_ids = [t["id"] for t in tasks]
        return _listing_reply(task_ids, [], priority), [], task_ids
    parts = [p.strip(" .") for p in re.split(r",|;|\band\b|\bthen\b", text) if len(p.strip()) > 3]
    if not parts:
        return "Tell me what you need to get done and I'll turn it into tasks.", [], []
    sugg = [
        {"title": p[0].upper() + p[1:], "notes": "", "due": None,
         "priority": "high" if re.search(r"urgent|asap|today|deadline", low) else "medium"}
        for p in parts[:6]
    ]
    return f"I found {len(sugg)} task(s). Add the ones you want (demo mode: set OPENAI_API_KEY for the real agent).", sugg, []
