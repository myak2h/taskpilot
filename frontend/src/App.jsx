import { useEffect, useState } from "react";

const api = async (path, opts = {}) => {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  return res.status === 204 ? null : res.json();
};

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");

  const loadTasks = () => api("/tasks").then(setTasks).catch((e) => setError(e.message));

  useEffect(() => {
    loadTasks();
  }, []);

  const toggle = async (t) => {
    await api(`/tasks/${t.id}`, { method: "PATCH", body: { done: !t.done } });
    loadTasks();
  };
  const remove = async (t) => {
    await api(`/tasks/${t.id}`, { method: "DELETE" });
    loadTasks();
  };
  const addManual = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    await api("/tasks", { method: "POST", body: { title } });
    setTitle("");
    loadTasks();
  };

  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);

  return (
    <div className="app">
      <section className="chat" aria-label="Chat">
        <header>
          <h1>TaskPilot</h1>
        </header>

        <div className="stream">
          <div className="empty">
            <p>Tell me what's coming up. I'll turn it into tasks you can approve.</p>
          </div>
          {error && <div className="error" role="alert">{error}</div>}
        </div>
      </section>

      <aside className="tasks" aria-label="Tasks">
        <h2>Tasks <span>{open.length} open</span></h2>
        <form onSubmit={addManual} className="manual">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" aria-label="New task" />
        </form>
        {open.length === 0 && <p className="hint">No open tasks. Ask the assistant to plan something.</p>}
        <ul>{open.map((t) => <Row key={t.id} t={t} toggle={toggle} remove={remove} />)}</ul>
        {done.length > 0 && (
          <>
            <h3>Done</h3>
            <ul>{done.map((t) => <Row key={t.id} t={t} toggle={toggle} remove={remove} />)}</ul>
          </>
        )}
      </aside>
    </div>
  );
}

function Row({ t, toggle, remove }) {
  return (
    <li className={t.done ? "done" : ""}>
      <input type="checkbox" checked={t.done} onChange={() => toggle(t)} aria-label={`Mark "${t.title}" ${t.done ? "open" : "done"}`} />
      <span className={`dot ${t.priority}`} title={`${t.priority} priority`} />
      <div className="label">
        <span>{t.title}</span>
        {t.due && <small>Due {t.due}</small>}
      </div>
      <button className="ghost x" onClick={() => remove(t)} aria-label={`Delete "${t.title}"`}>×</button>
    </li>
  );
}
