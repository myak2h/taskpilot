from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session

from . import models
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


def task_out(t: models.Task) -> dict:
    return {"id": t.id, "title": t.title, "notes": t.notes, "priority": t.priority,
            "due": t.due, "done": t.done}


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
        db.delete(t)
        db.commit()
