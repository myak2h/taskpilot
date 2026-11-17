export default function App() {
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
        </div>
      </section>

      <aside className="tasks" aria-label="Tasks">
        <h2>Tasks</h2>
        <p className="hint">No open tasks. Ask the assistant to plan something.</p>
        <ul></ul>
      </aside>
    </div>
  );
}
