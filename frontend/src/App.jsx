import { useEffect, useRef, useState } from "react";
import { updateTaskInMessages, removeTaskFromMessages, reconcileTaskMessages } from "./taskMessages.js";

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
  const [pendingTasks, setPendingTasks] = useState(new Set());
  const pendingTasksRef = useRef(new Set());
  const conversationGenerationRef = useRef(0);
  const sendPendingRef = useRef(false);
  // null means no authoritative task load has succeeded yet, not an empty list.
  const loadedTasksRef = useRef(null);
  const endRef = useRef(null);

  const loadTasks = async () => {
    try {
      const result = await api("/tasks");
      loadedTasksRef.current = result;
      setTasks(result);
      setMessages((ms) => reconcileTaskMessages(ms, result));
      return result;
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    let active = true;
    const generation = conversationGenerationRef.current;
    loadTasks();
    if (convId) api(`/conversations/${convId}/messages`).then((ms) => {
      if (!active || generation !== conversationGenerationRef.current) return;
      setMessages(loadedTasksRef.current === null ? ms : reconcileTaskMessages(ms, loadedTasksRef.current));
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(text) {
    text = text.trim();
    if (!text || sendPendingRef.current) return;
    const generation = conversationGenerationRef.current;
    const conversationId = convId;
    sendPendingRef.current = true;
    setInput("");
    setError("");
    setMessages((m) => [...m, { role: "user", content: text, suggestions: [] }]);
    setBusy(true);
    try {
      const r = await api("/chat", { method: "POST", body: { message: text, conversation_id: conversationId } });
      if (generation !== conversationGenerationRef.current) return;
      setConvId(r.conversation_id);
      localStorage.setItem("conv", r.conversation_id);
      setMessages((m) => [...m, r.message]);
    } catch (e) {
      if (generation === conversationGenerationRef.current) setError(e.message);
    } finally {
      if (generation === conversationGenerationRef.current) {
        sendPendingRef.current = false;
        setBusy(false);
      }
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
    if (pendingTasksRef.current.has(t.id)) return;
    pendingTasksRef.current.add(t.id);
    setPendingTasks(new Set(pendingTasksRef.current));
    setError("");
    try {
      const updated = await api(`/tasks/${t.id}`, { method: "PATCH", body: { done: !t.done } });
      setTasks((ts) => ts.map((task) => task.id === updated.id ? updated : task));
      setMessages((ms) => updateTaskInMessages(ms, updated));
      if (loadedTasksRef.current !== null) {
        loadedTasksRef.current = loadedTasksRef.current.map((task) => task.id === updated.id ? updated : task);
      }
      await loadTasks();
    } catch (e) {
      setError(e.message);
    } finally {
      pendingTasksRef.current.delete(t.id);
      setPendingTasks(new Set(pendingTasksRef.current));
    }
  };
  const remove = async (t) => {
    if (pendingTasksRef.current.has(t.id)) return;
    setError("");
    try {
      await api(`/tasks/${t.id}`, { method: "DELETE" });
      setTasks((ts) => ts.filter((task) => task.id !== t.id));
      setMessages((ms) => removeTaskFromMessages(ms, t.id));
      if (loadedTasksRef.current !== null) {
        loadedTasksRef.current = loadedTasksRef.current.filter((task) => task.id !== t.id);
      }
      await loadTasks();
    } catch (e) {
      setError(e.message);
    }
  };
  const addManual = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    await api("/tasks", { method: "POST", body: { title } });
    setTitle("");
    loadTasks();
  };
  const newChat = () => {
    conversationGenerationRef.current += 1;
    localStorage.removeItem("conv");
    setConvId(null);
    setMessages([]);
    setInput("");
    setError("");
    sendPendingRef.current = false;
    setBusy(false);
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
              {m.content && <p>{m.content}</p>}
              {m.tasks?.length > 0 && (
                <ul className="chat-task-list" aria-label="Existing tasks with completion checkboxes">
                  {m.tasks.map((t) => (
                    <Row key={t.id} t={t} toggle={toggle} pending={pendingTasks.has(t.id)} />
                  ))}
                </ul>
              )}
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
        <ul>{open.map((t) => <Row key={t.id} t={t} toggle={toggle} remove={remove} pending={pendingTasks.has(t.id)} />)}</ul>
        {done.length > 0 && (
          <>
            <h3>Done</h3>
            <ul>{done.map((t) => <Row key={t.id} t={t} toggle={toggle} remove={remove} pending={pendingTasks.has(t.id)} />)}</ul>
          </>
        )}
      </aside>
    </div>
  );
}

function Row({ t, toggle, remove, pending = false }) {
  return (
    <li className={t.done ? "done" : ""}>
      <input type="checkbox" checked={t.done} disabled={pending} onChange={() => toggle(t)} aria-label={`Mark "${t.title}" ${t.done ? "open" : "done"}`} />
      <span className={`dot ${t.priority}`} title={`${t.priority} priority`} />
      <div className="label">
        <span>{t.title}</span>
        {t.due && <small>Due {t.due}</small>}
      </div>
      {remove && <button className="ghost x" disabled={pending} onClick={() => remove(t)} aria-label={`Delete "${t.title}"`}>×</button>}
    </li>
  );
}
