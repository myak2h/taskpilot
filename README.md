# TaskPilot — AI task-planning assistant

A chat assistant that turns messy plans ("launch a newsletter next week") into
actionable tasks. Built with **FastAPI + PostgreSQL + React + an LLM (OpenAI API)**.

## How the agent workflow works
1. User sends a message → `POST /api/chat`.
2. The LLM runs a small tool-calling loop (`backend/app/agent.py`):
   - `list_tasks` reads open tasks from the DB (answers "what's on my plate?", avoids duplicates)
   - `suggest_tasks` returns structured tasks (title, priority, due date)
3. Suggestions come back with the reply; the user **approves** them with one click, which creates real tasks.
4. Asking for existing open tasks produces one interactive list with **completion checkboxes** and a short introduction, not a duplicate plaintext enumeration. These attachments reference tasks already added; unlike suggestions, they do not need approval or create new tasks.
5. Completion and reopening stay synchronized between chat and the sidebar, including repeated listings. Every message (and its suggestions and task references) is persisted, so conversations survive a refresh. Historical attachments show the current task state, including edits and completion; deleted tasks disappear from them. A new request lists only currently open tasks.

No API key? The app falls back to a rule-based **demo mode** so it still runs end to end, including interactive lists of existing tasks. Try "What's on my plate?" after adding tasks. The agent never creates or completes tasks itself; you approve suggestions and control completion in the UI.

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

At backend startup, `Base.metadata.create_all` creates the additive
`message_tasks` association table on existing databases without changing existing
tables. Older messages have no task references and return empty attachments
(`tasks: []`).

## API
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/chat` | Send a message, get a reply + suggestions requiring approval + existing-task attachments with completion controls |
| GET | `/api/conversations/{id}/messages` | Conversation history with current task state in attachments |
| GET/POST | `/api/tasks` | List / create tasks |
| PATCH/DELETE | `/api/tasks/{id}` | Update (e.g. mark done) / delete |

For example, the `message` returned by `/api/chat` for an existing-task request
contains these fields (alongside `id` and `role`):

```json
{
  "content": "Here are your open tasks. Use the completion checkboxes to mark them done.",
  "suggestions": [],
  "tasks": [
    {
      "id": 1,
      "title": "Draft newsletter",
      "notes": "Include the launch announcement",
      "priority": "high",
      "due": "2030-04-12",
      "done": false
    }
  ]
}
```

`suggestions` holds proposed tasks awaiting approval; `tasks` holds existing task
objects, resolved to their current state on each history request. Both arrays can
appear in the same message and are empty when unused. Task attachments do not
create tasks, and deleting a task removes it from historical attachments.

## Validation
After installing the dependencies above, run each block from the repository root:

```bash
cd backend
source .venv/bin/activate
python -m unittest discover -s tests
```

```bash
cd frontend
npm test
npm run build
```

## Next steps (phase 2 ideas)
Auth and per-user data, streaming responses, Alembic migrations, calendar sync, recurring tasks.
