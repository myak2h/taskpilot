import { useEffect, useRef, useState } from "react";

const api = async (path, opts = {}) => {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  return res.status === 204 ? null : res.json();
};

const PROMPTS = [
  "I'm launching a newsletter next week and need to write, design and schedule it",
  "Plan my Saturday: groceries, laundry, call mom, gym",
  "What's on my plate?",
];

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [messages, setMessages] = useState([]);
  const [convId, setConvId] = useState(() => Number(localStorage.getItem("conv")) || null);
  const [input, setInput] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef(null);

  const loadTasks = () => api("/tasks").then(setTasks).catch((e) => setError(e.message));

  useEffect(() => {
    loadTasks();
    if (convId) api(`/conversations/${convId}/messages`).then(setMessages).catch(() => {});
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    setInput("");
    setError("");
    setMessages((m) => [...m, { role: "user", content: text, suggestions: [] }]);
    setBusy(true);
    try {
      const r = await api("/chat", { method: "POST", body: { message: text, conversation_id: convId } });
      setConvId(r.conversation_id);
      localStorage.setItem("conv", r.conversation_id);
      setMessages((m) => [...m, r.message]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function addTasks(msgIndex, picks) {
    for (const t of picks) await api("/tasks", { method: "POST", body: t });
    // mark those suggestions as added in the UI
    setMessages((ms) =>
      ms.map((m, i) =>
        i === msgIndex ? { ...m, suggestions: m.suggestions.filter((s) => !picks.includes(s)) } : m
      )
    );
    loadTasks();
  }

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
  const newChat = () => {
    localStorage.removeItem("conv");
    setConvId(null);
    setMessages([]);
  };

  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);

  return (
    <div className="app">
      <section className="chat" aria-label="Chat">
        <header>
          <h1>TaskPilot</h1>
          <button className="ghost" onClick={newChat}>New chat</button>
        </header>

        <div className="stream">
          {messages.length === 0 && (
            <div className="empty">
              <p>Tell me what's coming up. I'll turn it into tasks you can approve.</p>
              {PROMPTS.map((p) => (
                <button key={p} className="prompt" onClick={() => send(p)}>{p}</button>
              ))}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <p>{m.content}</p>
              {m.suggestions?.length > 0 && (
                <div className="suggest">
                  {m.suggestions.map((s, j) => (
                    <div className="sug" key={j}>
                      <span className={`dot ${s.priority}`} title={`${s.priority} priority`} />
                      <div>
                        <strong>{s.title}</strong>
                        {s.due && <small>Due {s.due}</small>}
                      </div>
                      <button onClick={() => addTasks(i, [s])}>Add task</button>
                    </div>
                  ))}
                  {m.suggestions.length > 1 && (
                    <button className="primary" onClick={() => addTasks(i, m.suggestions)}>
                      Add all {m.suggestions.length} tasks
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && <div className="msg assistant typing" aria-live="polite">Thinking…</div>}
          {error && <div className="error" role="alert">{error}</div>}
          <div ref={endRef} />
        </div>

        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="What do you need to get done?" aria-label="Message" />
          <button className="primary" disabled={busy || !input.trim()}>Send</button>
        </form>
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
