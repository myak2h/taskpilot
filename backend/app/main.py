from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import models
from .db import Base, engine

Base.metadata.create_all(engine)
app = FastAPI(title="TaskPilot API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/health")
def health():
    return {"ok": True}
