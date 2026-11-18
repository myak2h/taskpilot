from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session

from . import models
from .agent import run_agent
from .db import Base, engine, get_db

Base.metadata.create_all(engine)
app = FastAPI(title="TaskPilot API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class TaskIn(BaseModel):
    title: str
    notes: str = ""
    priority: str = "medium"
    due: str | None = None


class TaskPatch(BaseModel):
    title: str | None = None
    notes: str | None = None
    priority: str | None = None
    due: str | None = None
    done: bool | None = None


class ChatIn(BaseModel):
    message: str
    conversation_id: int | None = None


def task_out(t: models.Task) -> dict:
    return {"id": t.id, "title": t.title, "notes": t.notes, "priority": t.priority,
            "due": t.due, "done": t.done}


def msg_out(m: models.Message, db: Session) -> dict:
    tasks = (db.query(models.Task)
             .join(models.MessageTask, models.MessageTask.task_id == models.Task.id)
             .filter(models.MessageTask.message_id == m.id)
             .order_by(models.Task.id).all())
    return {"id": m.id, "role": m.role, "content": m.content, "suggestions": m.suggestions or [],
            "tasks": [task_out(t) for t in tasks]}


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/tasks")
def list_tasks(db: Session = Depends(get_db)):
    rows = db.query(models.Task).order_by(models.Task.done, models.Task.id.desc()).all()
    return [task_out(t) for t in rows]


@app.post("/api/tasks", status_code=201)
def create_task(body: TaskIn, db: Session = Depends(get_db)):
    if not body.title.strip():
        raise HTTPException(422, "Title is required")
    t = models.Task(**body.model_dump())
    db.add(t)
    db.commit()
    db.refresh(t)
    return task_out(t)


@app.patch("/api/tasks/{task_id}")
def update_task(task_id: int, body: TaskPatch, db: Session = Depends(get_db)):
    t = db.get(models.Task, task_id)
    if not t:
        raise HTTPException(404, "Task not found")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(t, k, v)
    db.commit()
    return task_out(t)


@app.delete("/api/tasks/{task_id}", status_code=204)
def delete_task(task_id: int, db: Session = Depends(get_db)):
    t = db.get(models.Task, task_id)
    if t:
        db.query(models.MessageTask).filter_by(task_id=task_id).delete()
        db.delete(t)
        db.commit()


@app.post("/api/chat")
def chat(body: ChatIn, db: Session = Depends(get_db)):
    convo = db.get(models.Conversation, body.conversation_id) if body.conversation_id else None
    if not convo:
        convo = models.Conversation()
        db.add(convo)
        db.commit()
        db.refresh(convo)

    prior = (db.query(models.Message).filter_by(conversation_id=convo.id)
             .order_by(models.Message.id.desc()).limit(12).all())[::-1]
    history = [{"role": m.role, "content": m.content} for m in prior]

    db.add(models.Message(conversation_id=convo.id, role="user", content=body.message))
    try:
        reply, suggestions, presented_task_ids = run_agent(db, history, body.message)
    except Exception as e:  # LLM/network failure
        db.rollback()
        raise HTTPException(502, f"The AI service failed: {e}")
    m = models.Message(conversation_id=convo.id, role="assistant", content=reply, suggestions=suggestions)
    db.add(m)
    db.flush()
    for task_id in dict.fromkeys(presented_task_ids):
        if db.get(models.Task, task_id) is not None:
            db.add(models.MessageTask(message_id=m.id, task_id=task_id))
    db.commit()
    db.refresh(m)
    return {"conversation_id": convo.id, "message": msg_out(m, db)}


@app.get("/api/conversations/{cid}/messages")
def messages(cid: int, db: Session = Depends(get_db)):
    rows = db.query(models.Message).filter_by(conversation_id=cid).order_by(models.Message.id).all()
    return [msg_out(m, db) for m in rows]
