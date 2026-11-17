"""Task-planning agent.

Tasks are only *suggested*, never created without user approval.
"""
import re

from sqlalchemy.orm import Session
from . import models


def _open_tasks(db: Session) -> list[dict]:
    rows = db.query(models.Task).filter_by(done=False).order_by(models.Task.id).all()
    return [{"id": t.id, "title": t.title, "priority": t.priority, "due": t.due} for t in rows]


def run_agent(db: Session, history: list[dict], user_text: str) -> tuple[str, list[dict]]:
    return _demo_agent(db, user_text)


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
