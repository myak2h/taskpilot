# TaskPilot — AI task-planning assistant

A chat assistant that turns messy plans ("launch a newsletter next week") into
actionable tasks. Built with **FastAPI + PostgreSQL + React + an LLM (OpenAI API)**.

## How the agent workflow works
1. User sends a message → `POST /api/chat`.
2. The LLM runs a small tool-calling loop (`backend/app/agent.py`):
   - `list_tasks` reads open tasks from the DB (answers "what's on my plate?", avoids duplicates)
   - `suggest_tasks` returns structured tasks (title, priority, due date)
3. Suggestions come back with the reply; the user **approves** them with one click, which creates real tasks.
4. Every message (and its suggestions) is persisted, so conversations survive a refresh.

No API key? The app falls back to a rule-based **demo mode** so it still runs end to end.

## Stack
- Backend: Python, FastAPI, SQLAlchemy, OpenAI SDK
- DB: PostgreSQL (SQLite by default for zero-setup)
- Frontend: React 19 + Vite

## Run it

### Option A: everything in Docker (recommended)
```bash
cp .env.example .env     # optional: add OPENAI_API_KEY (empty = demo mode)
docker compose up --build
```
Compose reads the root `.env` file and passes its values to the backend. The
file is optional; without an API key the app runs in demo mode. Shell values
for `OPENAI_API_KEY` and `OPENAI_MODEL` take precedence over `.env`. The
Compose configuration sets `DATABASE_URL` to the Docker database regardless
of its value in `.env`. After changing `.env`, rerun `docker compose up -d`
to recreate the backend with the updated values. The optional `env_file`
requires Docker Compose 2.24.0 or later.

- App: http://localhost:3000
- API docs: http://localhost:8000/docs

This starts three containers: **PostgreSQL**, the **FastAPI backend**, and the **React frontend** (built and served by nginx, which proxies `/api` to the backend). Data persists in the `pgdata` volume. Stop with `docker compose down` (add `-v` to wipe the data).

### Option B: run locally without Docker
```bash
# Backend (uses SQLite by default)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # add OPENAI_API_KEY for the real agent
uvicorn app.main:app --reload   # http://localhost:8000/docs

# Frontend (new terminal)
cd frontend
node --version                  # Vite requires Node 20.19+ within 20.x, or 22.12+
npm install
npm run dev                     # http://localhost:5173
```
To use Postgres locally, run `docker compose up -d db` and set
`DATABASE_URL=postgresql://taskpilot:taskpilot@localhost:5432/taskpilot` in `backend/.env`.

## API
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/chat` | Send a message, get reply + suggested tasks |
| GET | `/api/conversations/{id}/messages` | Conversation history |
| GET/POST | `/api/tasks` | List / create tasks |
| PATCH/DELETE | `/api/tasks/{id}` | Update (e.g. mark done) / delete |

## Next steps (phase 2 ideas)
Auth and per-user data, streaming responses, Alembic migrations, calendar sync, recurring tasks.
