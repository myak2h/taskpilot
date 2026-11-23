import { expect, test } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.jsx";
import { deferred, enqueueResponse, requestsFor } from "./test/api.js";

function task(id, fields = {}) {
  return { id, title: `Task ${id}`, notes: "", priority: "medium", due: null, done: false, ...fields };
}

function message(id, fields = {}) {
  return { id, role: "assistant", content: `Message ${id}`, suggestions: [], tasks: [], ...fields };
}

async function resolveResponse(response, body) {
  await act(async () => {
    response.resolve(body);
    await response.promise;
  });
}

async function rejectResponse(response, error) {
  await act(async () => {
    response.reject(error);
    await response.promise.catch(() => {});
  });
}

test("shows an empty chat and task list without requesting conversation history", async () => {
  const user = userEvent.setup();
  enqueueResponse("GET", "/api/tasks", []);

  render(<App />);

  const chat = screen.getByRole("region", { name: "Chat" });
  const tasks = screen.getByRole("complementary", { name: "Tasks" });
  expect(chat).toBeInTheDocument();
  expect(tasks).toBeInTheDocument();
  expect(within(tasks).getByText("No open tasks. Ask the assistant to plan something.")).toBeVisible();
  expect(within(chat).getByRole("button", { name: "Send" })).toBeDisabled();

  const input = within(chat).getByRole("textbox", { name: "Message" });
  await user.type(input, "   ");
  expect(within(chat).getByRole("button", { name: "Send" })).toBeDisabled();
  await user.clear(input);
  expect(within(chat).getByRole("button", { name: "Send" })).toBeDisabled();

  expect(requestsFor("GET", "/api/tasks")).toHaveLength(1);
  // The task load is the only request; a fresh chat must not request history.
  expect(fetch).toHaveBeenCalledTimes(1);
});

for (const first of ["tasks", "history"]) {
  test(`restores history with current tasks when ${first} arrives first`, async () => {
    localStorage.setItem("conv", "42");
    const tasksResponse = deferred();
    const historyResponse = deferred();
    const currentTasks = [
      task(1, { done: true }),
      task(3, { title: "Edited task", priority: "high", due: "2030-04-12" }),
      task(4, { title: "Sidebar only" }),
    ];
    const history = [
      message(10, { role: "user", content: "Show my tasks" }),
      message(11, {
        content: "Restored task list",
        tasks: [task(3), task(2), task(1)],
        suggestions: [{ title: "Unapproved suggestion", notes: "", priority: "low", due: null }],
      }),
      message(12, { content: "Repeated list", tasks: [task(1), task(3)] }),
    ];
    enqueueResponse("GET", "/api/tasks", currentTasks, { deferred: tasksResponse });
    enqueueResponse("GET", "/api/conversations/42/messages", history, { deferred: historyResponse });

    render(<App />);

    expect(requestsFor("GET", "/api/conversations/42/messages")).toHaveLength(1);
    expect(requestsFor("GET", "/api/tasks")).toHaveLength(1);
    if (first === "tasks") {
      await resolveResponse(tasksResponse, currentTasks);
      expect(await screen.findByText("Sidebar only")).toBeVisible();
      expect(screen.queryByText("Restored task list")).not.toBeInTheDocument();
      await resolveResponse(historyResponse, history);
    } else {
      await resolveResponse(historyResponse, history);
      expect(await screen.findByText("Restored task list")).toBeVisible();
      expect(within(screen.getByRole("region", { name: "Chat" })).getByText("Task 2")).toBeVisible();
      await resolveResponse(tasksResponse, currentTasks);
    }

    const chat = within(screen.getByRole("region", { name: "Chat" }));
    const sidebar = within(screen.getByRole("complementary", { name: "Tasks" }));
    await waitFor(() => {
      expect(chat.getAllByRole("checkbox", { name: 'Mark "Task 1" open' })).toHaveLength(2);
      expect(chat.getAllByText("Edited task")).toHaveLength(2);
    });
    chat.getAllByRole("checkbox", { name: 'Mark "Task 1" open' }).forEach((checkbox) => {
      expect(checkbox).toBeChecked();
    });
    chat.getAllByRole("checkbox", { name: 'Mark "Edited task" done' }).forEach((checkbox) => {
      expect(checkbox).not.toBeChecked();
    });
    expect(chat.queryByText("Task 2")).not.toBeInTheDocument();
    expect(chat.queryByText("Task 3")).not.toBeInTheDocument();
    expect(chat.queryByText("Sidebar only")).not.toBeInTheDocument();
    expect(chat.getByText("Show my tasks")).toBeVisible();
    expect(chat.getByText("Unapproved suggestion")).toBeVisible();
    expect(chat.getByRole("button", { name: "Add task" })).toBeEnabled();
    expect(sidebar.getByRole("checkbox", { name: 'Mark "Task 1" open' })).toBeChecked();
    expect(sidebar.getByText("Edited task")).toBeVisible();
    expect(requestsFor("POST", "/api/tasks")).toHaveLength(0);
    expect(localStorage.getItem("conv")).toBe("42");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
}

for (const first of ["tasks", "history"]) {
  test(`an authoritative empty task list removes restored attachments when ${first} arrives first`, async () => {
    localStorage.setItem("conv", "7");
    const tasksResponse = deferred();
    const historyResponse = deferred();
    const history = [message(1, {
      content: "Historical tasks and suggestions",
      tasks: [task(1)],
      suggestions: [{ title: "Keep this suggestion", priority: "medium", notes: "", due: null }],
    })];
    enqueueResponse("GET", "/api/tasks", [], { deferred: tasksResponse });
    enqueueResponse("GET", "/api/conversations/7/messages", history, { deferred: historyResponse });

    render(<App />);

    if (first === "tasks") {
      await resolveResponse(tasksResponse, []);
      await resolveResponse(historyResponse, history);
    } else {
      await resolveResponse(historyResponse, history);
      expect(await screen.findByRole("checkbox", { name: 'Mark "Task 1" done' })).toBeVisible();
      await resolveResponse(tasksResponse, []);
    }

    const chat = within(screen.getByRole("region", { name: "Chat" }));
    expect(await chat.findByText("Historical tasks and suggestions")).toBeVisible();
    await waitFor(() => expect(chat.queryByRole("checkbox")).not.toBeInTheDocument());
    expect(chat.queryByText("Task 1")).not.toBeInTheDocument();
    expect(chat.getByText("Keep this suggestion")).toBeVisible();
    expect(chat.getByRole("button", { name: "Add task" })).toBeEnabled();
    expect(within(screen.getByRole("complementary", { name: "Tasks" })).getByText(
      "No open tasks. Ask the assistant to plan something."
    )).toBeVisible();
  });
}

for (const first of ["tasks", "history"]) {
  test(`a failed task load is not an authoritative empty list when ${first} arrives first`, async () => {
    localStorage.setItem("conv", "8");
    const tasksResponse = deferred();
    const historyResponse = deferred();
    const failure = { detail: "Tasks unavailable" };
    const history = [message(1, { content: "Saved attachment", tasks: [task(1, { done: true })] })];
    enqueueResponse("GET", "/api/tasks", failure, { status: 503, deferred: tasksResponse });
    enqueueResponse("GET", "/api/conversations/8/messages", history, { deferred: historyResponse });

    render(<App />);

    if (first === "tasks") {
      await resolveResponse(tasksResponse, failure);
      expect(await screen.findByRole("alert")).toHaveTextContent("Tasks unavailable");
      await resolveResponse(historyResponse, history);
    } else {
      await resolveResponse(historyResponse, history);
      expect(await screen.findByText("Saved attachment")).toBeVisible();
      await resolveResponse(tasksResponse, failure);
    }

    expect(await screen.findByRole("alert")).toHaveTextContent("Tasks unavailable");
    const chat = within(screen.getByRole("region", { name: "Chat" }));
    expect(chat.getByText("Saved attachment")).toBeVisible();
    expect(chat.getByRole("checkbox", { name: 'Mark "Task 1" open' })).toBeChecked();
  });
}

test("failed history loading leaves the restored conversation usable for sending", async () => {
  const user = userEvent.setup();
  localStorage.setItem("conv", "23");
  const historyResponse = deferred();
  enqueueResponse("GET", "/api/tasks", []);
  enqueueResponse("GET", "/api/conversations/23/messages", { detail: "History unavailable" }, {
    status: 503, deferred: historyResponse,
  });
  enqueueResponse("POST", "/api/chat", { conversation_id: 23, message: message(2, { content: "Still usable" }) });

  render(<App />);
  await resolveResponse(historyResponse, { detail: "History unavailable" });

  expect(requestsFor("GET", "/api/conversations/23/messages")).toHaveLength(1);
  await user.type(screen.getByRole("textbox", { name: "Message" }), "  Continue please  ");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Still usable")).toBeVisible();
  expect(requestsFor("POST", "/api/chat")[0].body).toEqual({
    message: "Continue please", conversation_id: 23,
  });
  expect(localStorage.getItem("conv")).toBe("23");
});

test("sends trimmed optimistic text once while pending, persists the reply, and re-enables sending", async () => {
  const user = userEvent.setup();
  const chatResponse = deferred();
  const reply = {
    conversation_id: 51,
    message: message(2, {
      content: "Here is your plan",
      suggestions: [{ title: "Draft the plan", notes: "", priority: "high", due: null }],
    }),
  };
  enqueueResponse("GET", "/api/tasks", []);
  enqueueResponse("POST", "/api/chat", reply, { deferred: chatResponse });
  enqueueResponse("POST", "/api/chat", { conversation_id: 51, message: message(4, { content: "Follow-up reply" }) });

  render(<App />);

  const chat = within(screen.getByRole("region", { name: "Chat" }));
  const input = chat.getByRole("textbox", { name: "Message" });
  const send = chat.getByRole("button", { name: "Send" });
  // Dispatching submit also exercises paths that bypass a disabled submit button.
  fireEvent.submit(input.form);
  await user.type(input, "   ");
  fireEvent.submit(input.form);
  expect(requestsFor("POST", "/api/chat")).toHaveLength(0);
  await user.clear(input);
  await user.type(input, "  Plan my launch  ");
  act(() => {
    fireEvent.submit(input.form);
    fireEvent.submit(input.form);
    fireEvent.submit(input.form);
  });

  expect(chat.getByText("Plan my launch")).toBeVisible();
  expect(input).toHaveValue("");
  expect(chat.getByText("Thinking…")).toBeVisible();
  expect(send).toBeDisabled();
  await user.type(input, "Follow up");
  await user.click(send);
  fireEvent.submit(input.form);
  expect(requestsFor("POST", "/api/chat")).toHaveLength(1);
  expect(requestsFor("POST", "/api/chat")[0].body).toEqual({ message: "Plan my launch", conversation_id: null });
  expect(localStorage.getItem("conv")).toBeNull();

  await resolveResponse(chatResponse, reply);

  expect(await chat.findByText("Here is your plan")).toBeVisible();
  expect(chat.getByText("Draft the plan")).toBeVisible();
  expect(chat.getByRole("button", { name: "Add task" })).toBeEnabled();
  expect(requestsFor("POST", "/api/tasks")).toHaveLength(0);
  expect(chat.queryByText("Thinking…")).not.toBeInTheDocument();
  expect(send).toBeEnabled();
  expect(localStorage.getItem("conv")).toBe("51");
  await user.click(send);
  expect(await chat.findByText("Follow-up reply")).toBeVisible();
  expect(requestsFor("POST", "/api/chat")).toHaveLength(2);
  expect(requestsFor("POST", "/api/chat")[1].body).toEqual({ message: "Follow up", conversation_id: 51 });
});

for (const failure of ["detail", "network"]) {
  test(`a ${failure} chat failure displays an alert and permits retry`, async () => {
    const user = userEvent.setup();
    const chatResponse = deferred();
    const errorText = failure === "detail" ? "The AI service failed" : "Offline transport failure";
    enqueueResponse("GET", "/api/tasks", []);
    enqueueResponse("POST", "/api/chat", { detail: errorText }, { status: 502, deferred: chatResponse });
    enqueueResponse("POST", "/api/chat", { conversation_id: 61, message: message(2, { content: "Retry succeeded" }) });

    render(<App />);

    const input = screen.getByRole("textbox", { name: "Message" });
    await user.type(input, "First attempt");
    await user.click(screen.getByRole("button", { name: "Send" }));
    if (failure === "network") {
      await rejectResponse(chatResponse, new Error(errorText));
    } else {
      await resolveResponse(chatResponse, { detail: errorText });
    }

    expect(await screen.findByRole("alert")).toHaveTextContent(errorText);
    expect(screen.getByText("First attempt")).toBeVisible();
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    expect(localStorage.getItem("conv")).toBeNull();
    await user.type(input, "Try again");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Retry succeeded")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(localStorage.getItem("conv")).toBe("61");
    expect(requestsFor("POST", "/api/chat").map((request) => request.body)).toEqual([
      { message: "First attempt", conversation_id: null },
      { message: "Try again", conversation_id: null },
    ]);
  });
}

for (const outcome of ["resolve", "reject"]) {
  test(`New chat ignores history that will ${outcome} after reset`, async () => {
    const user = userEvent.setup();
    localStorage.setItem("conv", "72");
    const historyResponse = deferred();
    const history = [message(1, { content: "Discarded history", tasks: [task(1)] })];
    enqueueResponse("GET", "/api/tasks", [task(1)]);
    enqueueResponse("GET", "/api/conversations/72/messages", history, { deferred: historyResponse });

    render(<App />);

    const sidebar = within(screen.getByRole("complementary", { name: "Tasks" }));
    expect(await sidebar.findByText("Task 1")).toBeVisible();
    const input = screen.getByRole("textbox", { name: "Message" });
    await user.type(input, "Discard this draft");
    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(input).toHaveValue("");
    expect(localStorage.getItem("conv")).toBeNull();
    if (outcome === "resolve") {
      await resolveResponse(historyResponse, history);
    } else {
      await rejectResponse(historyResponse, new Error("Discarded history error"));
    }

    expect(screen.queryByText("Discarded history")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(localStorage.getItem("conv")).toBeNull();
    expect(sidebar.getByText("Task 1")).toBeVisible();
    expect(screen.getByText("Tell me what's coming up. I'll turn it into tasks you can approve.")).toBeVisible();
    await user.type(input, "Ready to send");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(requestsFor("GET", "/api/conversations/72/messages")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
}

for (const outcome of ["resolve", "reject"]) {
  test(`New chat ignores an old chat ${outcome} without restoring storage or errors`, async () => {
    const user = userEvent.setup();
    const oldResponse = deferred();
    const oldReply = { conversation_id: 81, message: message(1, { content: "Discarded reply" }) };
    enqueueResponse("GET", "/api/tasks", [task(1)]);
    enqueueResponse("POST", "/api/chat", oldReply, { deferred: oldResponse });

    render(<App />);

    const input = screen.getByRole("textbox", { name: "Message" });
    await user.type(input, "Old question");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("Thinking…")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.queryByText("Old question")).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    if (outcome === "resolve") {
      await resolveResponse(oldResponse, oldReply);
    } else {
      await rejectResponse(oldResponse, new Error("Discarded chat error"));
    }

    expect(screen.queryByText("Discarded reply")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(localStorage.getItem("conv")).toBeNull();
    expect(within(screen.getByRole("complementary", { name: "Tasks" })).getByText("Task 1")).toBeVisible();
    await user.type(input, "New draft");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
}

for (const outcome of ["resolve", "reject"]) {
  for (const first of ["old", "new"]) {
    test(`only the new conversation wins when the old chat will ${outcome} and ${first} settles first`, async () => {
      const user = userEvent.setup();
      const oldResponse = deferred();
      const newResponse = deferred();
      const oldReply = { conversation_id: 91, message: message(1, { content: "Old assistant reply" }) };
      const newReply = { conversation_id: 92, message: message(2, { content: "New assistant reply" }) };
      enqueueResponse("GET", "/api/tasks", []);
      enqueueResponse("POST", "/api/chat", oldReply, { deferred: oldResponse });
      enqueueResponse("POST", "/api/chat", newReply, { deferred: newResponse });

      render(<App />);

      const input = screen.getByRole("textbox", { name: "Message" });
      const send = screen.getByRole("button", { name: "Send" });
      await user.type(input, "Old conversation question");
      await user.click(send);
      await user.click(screen.getByRole("button", { name: "New chat" }));
      await user.type(input, "New conversation question");
      expect(send).toBeEnabled();
      await user.click(send);
      expect(requestsFor("POST", "/api/chat").map((request) => request.body)).toEqual([
        { message: "Old conversation question", conversation_id: null },
        { message: "New conversation question", conversation_id: null },
      ]);
      const settleOld = () => outcome === "resolve"
        ? resolveResponse(oldResponse, oldReply)
        : rejectResponse(oldResponse, new Error("Old conversation failed"));

      if (first === "old") {
        await settleOld();
        expect(screen.getByText("Thinking…")).toBeVisible();
        expect(localStorage.getItem("conv")).toBeNull();
        await user.type(input, "Next draft");
        expect(send).toBeDisabled();
        fireEvent.submit(input.form);
        expect(requestsFor("POST", "/api/chat")).toHaveLength(2);
        await resolveResponse(newResponse, newReply);
      } else {
        await resolveResponse(newResponse, newReply);
        expect(await screen.findByText("New assistant reply")).toBeVisible();
        expect(localStorage.getItem("conv")).toBe("92");
        await settleOld();
        await user.type(input, "Next draft");
      }

      expect(await screen.findByText("New assistant reply")).toBeVisible();
      expect(screen.getByText("New conversation question")).toBeVisible();
      expect(screen.queryByText("Old conversation question")).not.toBeInTheDocument();
      expect(screen.queryByText("Old assistant reply")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
      expect(localStorage.getItem("conv")).toBe("92");
      expect(input).toHaveValue("Next draft");
      expect(send).toBeEnabled();
    });
  }
}

test("history settling after unmount cannot affect a replacement chat", async () => {
  localStorage.setItem("conv", "101");
  const historyResponse = deferred();
  const history = [message(1, { content: "Unmounted history" })];
  enqueueResponse("GET", "/api/tasks", []);
  enqueueResponse("GET", "/api/conversations/101/messages", history, { deferred: historyResponse });
  const view = render(<App />);
  view.unmount();
  localStorage.removeItem("conv");
  enqueueResponse("GET", "/api/tasks", []);

  render(<App />);
  await resolveResponse(historyResponse, history);

  expect(screen.queryByText("Unmounted history")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText("Tell me what's coming up. I'll turn it into tasks you can approve.")).toBeVisible();
  expect(localStorage.getItem("conv")).toBeNull();
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(2);
  expect(requestsFor("GET", "/api/conversations/101/messages")).toHaveLength(1);
});

function suggestion(title, fields = {}) {
  return { title, notes: "", priority: "medium", due: null, ...fields };
}

async function renderWorkflow({ tasks = [], suggestions = [], repeated = false } = {}) {
  const user = userEvent.setup();
  localStorage.setItem("conv", "201");
  const history = [message(201, { content: "Workflow history", tasks, suggestions })];
  if (repeated) history.push(message(202, { content: "Repeated workflow listing", tasks }));
  enqueueResponse("GET", "/api/tasks", tasks);
  enqueueResponse("GET", "/api/conversations/201/messages", history);

  render(<App />);

  const chat = within(screen.getByRole("region", { name: "Chat" }));
  const sidebar = within(screen.getByRole("complementary", { name: "Tasks" }));
  expect(await chat.findByText("Workflow history")).toBeVisible();
  if (tasks.length) expect(await sidebar.findByText(tasks[0].title)).toBeVisible();
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(1);
  expect(requestsFor("GET", "/api/conversations/201/messages")).toHaveLength(1);
  expect(requestsFor("POST", "/api/tasks")).toHaveLength(0);
  return { user, chat, sidebar };
}

test("approves only the selected suggestion and guards every approval control until refresh finishes", async () => {
  const picks = [suggestion("Write announcement"), suggestion("Schedule launch", {
    notes: "Use the mailing list", priority: "high", due: "2030-04-12",
  })];
  const { user, chat, sidebar } = await renderWorkflow({ suggestions: picks });
  const creation = deferred();
  const refresh = deferred();
  const created = task(1, picks[1]);
  enqueueResponse("POST", "/api/tasks", created, { status: 201, deferred: creation });
  enqueueResponse("GET", "/api/tasks", [created], { deferred: refresh });
  const buttons = chat.getAllByRole("button", { name: "Add task" });
  const addAll = chat.getByRole("button", { name: "Add all 2 tasks" });

  act(() => {
    fireEvent.click(buttons[1]);
    fireEvent.click(buttons[1]);
    fireEvent.click(buttons[0]);
    fireEvent.click(addAll);
  });
  buttons.forEach((button) => expect(button).toBeDisabled());
  expect(addAll).toBeDisabled();
  await user.click(addAll);
  expect(requestsFor("POST", "/api/tasks").map((request) => request.body)).toEqual([picks[1]]);
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(1);

  await resolveResponse(creation, created);

  await waitFor(() => expect(chat.queryByText("Schedule launch")).not.toBeInTheDocument());
  expect(chat.getByText("Write announcement")).toBeVisible();
  expect(chat.getByRole("button", { name: "Add task" })).toBeDisabled();
  expect(chat.queryByRole("button", { name: /Add all/ })).not.toBeInTheDocument();
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(2);
  await resolveResponse(refresh, [created]);
  expect(await sidebar.findByText("Schedule launch")).toBeVisible();
  await waitFor(() => expect(chat.getByRole("button", { name: "Add task" })).toBeEnabled());
  expect(sidebar.queryByText("Write announcement")).not.toBeInTheDocument();
  expect(requestsFor("POST", "/api/tasks")).toHaveLength(1);
});

test("Add all persists suggestions sequentially and removes each acknowledged item immediately", async () => {
  const picks = [suggestion("First step"), suggestion("Second step"), suggestion("Third step")];
  const { user, chat, sidebar } = await renderWorkflow({ suggestions: picks });
  const responses = picks.map(() => deferred());
  const created = picks.map((pick, index) => task(index + 1, pick));
  created.forEach((item, index) => {
    enqueueResponse("POST", "/api/tasks", item, { status: 201, deferred: responses[index] });
  });
  enqueueResponse("GET", "/api/tasks", created);

  await user.click(chat.getByRole("button", { name: "Add all 3 tasks" }));
  await user.click(chat.getAllByRole("button", { name: "Add task" })[1]);
  await user.click(chat.getByRole("button", { name: "Add all 3 tasks" }));
  expect(requestsFor("POST", "/api/tasks").map((request) => request.body)).toEqual([picks[0]]);

  for (let index = 0; index < picks.length; index += 1) {
    expect(requestsFor("POST", "/api/tasks")).toHaveLength(index + 1);
    expect(requestsFor("GET", "/api/tasks")).toHaveLength(1);
    chat.getAllByRole("button", { name: "Add task" }).forEach((button) => expect(button).toBeDisabled());
    await resolveResponse(responses[index], created[index]);
    await waitFor(() => expect(chat.queryByText(picks[index].title)).not.toBeInTheDocument());
    for (const remaining of picks.slice(index + 1)) expect(chat.getByText(remaining.title)).toBeVisible();
  }

  expect(await sidebar.findByText("Third step")).toBeVisible();
  created.forEach((item) => expect(sidebar.getByText(item.title)).toBeVisible());
  expect(chat.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
  expect(requestsFor("POST", "/api/tasks").map((request) => request.body)).toEqual(picks);
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(2);
});

test("a failed single approval retains every suggestion and can be retried", async () => {
  const picks = [suggestion("Retry this suggestion"), suggestion("Leave this suggestion")];
  const { user, chat, sidebar } = await renderWorkflow({ suggestions: picks });
  enqueueResponse("POST", "/api/tasks", { detail: "Approval unavailable" }, { status: 503 });

  await user.click(chat.getAllByRole("button", { name: "Add task" })[0]);

  expect(await chat.findByRole("alert")).toHaveTextContent("Approval unavailable");
  picks.forEach((pick) => expect(chat.getByText(pick.title)).toBeVisible());
  chat.getAllByRole("button", { name: "Add task" }).forEach((button) => expect(button).toBeEnabled());
  expect(chat.getByRole("button", { name: "Add all 2 tasks" })).toBeEnabled();
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(1);
  expect(sidebar.queryByText(picks[0].title)).not.toBeInTheDocument();

  const created = task(1, picks[0]);
  enqueueResponse("POST", "/api/tasks", created, { status: 201 });
  enqueueResponse("GET", "/api/tasks", [created]);
  await user.click(chat.getAllByRole("button", { name: "Add task" })[0]);

  expect(await sidebar.findByText(picks[0].title)).toBeVisible();
  expect(chat.queryByText(picks[0].title)).not.toBeInTheDocument();
  expect(chat.getByText(picks[1].title)).toBeVisible();
  expect(chat.getByRole("button", { name: "Add task" })).toBeEnabled();
  expect(chat.queryByRole("alert")).not.toBeInTheDocument();
  expect(requestsFor("POST", "/api/tasks").map((request) => request.body)).toEqual([picks[0], picks[0]]);
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(2);
});

test("partial Add all failure refreshes successful tasks and retries only failed and unattempted suggestions", async () => {
  const picks = [suggestion("Persisted first"), suggestion("Failed second"), suggestion("Unattempted third")];
  const { user, chat, sidebar } = await renderWorkflow({ suggestions: picks });
  const secondResponse = deferred();
  const created = picks.map((pick, index) => task(index + 1, pick));
  enqueueResponse("POST", "/api/tasks", created[0], { status: 201 });
  enqueueResponse("POST", "/api/tasks", { detail: "Second creation failed" }, {
    status: 503, deferred: secondResponse,
  });
  enqueueResponse("GET", "/api/tasks", [created[0]]);

  await user.click(chat.getByRole("button", { name: "Add all 3 tasks" }));
  await waitFor(() => expect(requestsFor("POST", "/api/tasks")).toHaveLength(2));
  expect(chat.queryByText(picks[0].title)).not.toBeInTheDocument();
  expect(chat.getByText(picks[1].title)).toBeVisible();
  expect(chat.getByText(picks[2].title)).toBeVisible();
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(1);
  await resolveResponse(secondResponse, { detail: "Second creation failed" });

  expect(await chat.findByRole("alert")).toHaveTextContent("Second creation failed");
  expect(await sidebar.findByText(picks[0].title)).toBeVisible();
  await waitFor(() => expect(chat.getByRole("button", { name: "Add all 2 tasks" })).toBeEnabled());
  expect(requestsFor("POST", "/api/tasks").map((request) => request.body)).toEqual(picks.slice(0, 2));
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(2);

  enqueueResponse("POST", "/api/tasks", created[1], { status: 201 });
  enqueueResponse("POST", "/api/tasks", created[2], { status: 201 });
  enqueueResponse("GET", "/api/tasks", created);
  await user.click(chat.getByRole("button", { name: "Add all 2 tasks" }));

  expect(await sidebar.findByText(picks[2].title)).toBeVisible();
  created.forEach((item) => expect(sidebar.getByText(item.title)).toBeVisible());
  picks.forEach((pick) => expect(chat.queryByText(pick.title)).not.toBeInTheDocument());
  expect(chat.queryByRole("button", { name: /Add/ })).not.toBeInTheDocument();
  expect(chat.queryByRole("alert")).not.toBeInTheDocument();
  expect(requestsFor("POST", "/api/tasks").map((request) => request.body)).toEqual([
    picks[0], picks[1], picks[1], picks[2],
  ]);
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(3);
});

for (const outcome of ["resolve", "reject"]) {
  test(`an old approval that will ${outcome} cannot change replacement suggestions or unlock their pending approval`, async () => {
    const picks = [suggestion("Shared suggestion"), suggestion("Keep for later")];
    const { user, chat, sidebar } = await renderWorkflow({ suggestions: picks });
    const oldResponse = deferred();
    const newResponse = deferred();
    const oldTask = task(1, picks[0]);
    const newTask = task(2, picks[0]);
    enqueueResponse("POST", "/api/tasks", oldTask, { status: 201, deferred: oldResponse });
    enqueueResponse("POST", "/api/tasks", newTask, { status: 201, deferred: newResponse });
    enqueueResponse("POST", "/api/chat", {
      conversation_id: 202,
      // Reuse the message ID to exercise generation-safe approval cleanup.
      message: message(201, { content: "Replacement suggestions", suggestions: picks }),
    });
    if (outcome === "resolve") enqueueResponse("GET", "/api/tasks", [oldTask]);
    enqueueResponse("GET", "/api/tasks", outcome === "resolve" ? [oldTask, newTask] : [newTask]);

    await user.click(chat.getAllByRole("button", { name: "Add task" })[0]);
    await user.click(chat.getByRole("button", { name: "New chat" }));
    expect(localStorage.getItem("conv")).toBeNull();
    await user.type(chat.getByRole("textbox", { name: "Message" }), "Another plan");
    await user.click(chat.getByRole("button", { name: "Send" }));
    expect(await chat.findByText("Replacement suggestions")).toBeVisible();
    expect(chat.getByRole("button", { name: "Add all 2 tasks" })).toBeEnabled();
    await user.click(chat.getAllByRole("button", { name: "Add task" })[0]);

    if (outcome === "resolve") {
      await resolveResponse(oldResponse, oldTask);
      expect(await sidebar.findByText(picks[0].title)).toBeVisible();
    } else {
      await rejectResponse(oldResponse, new Error("Discarded approval failure"));
    }

    picks.forEach((pick) => expect(chat.getByText(pick.title)).toBeVisible());
    chat.getAllByRole("button", { name: "Add task" }).forEach((button) => expect(button).toBeDisabled());
    expect(chat.getByRole("button", { name: "Add all 2 tasks" })).toBeDisabled();
    expect(chat.queryByRole("alert")).not.toBeInTheDocument();
    expect(localStorage.getItem("conv")).toBe("202");
    await user.click(chat.getByRole("button", { name: "Add all 2 tasks" }));
    expect(requestsFor("POST", "/api/tasks")).toHaveLength(2);

    await resolveResponse(newResponse, newTask);

    await waitFor(() => expect(chat.queryByText(picks[0].title)).not.toBeInTheDocument());
    expect(chat.getByText(picks[1].title)).toBeVisible();
    await waitFor(() => expect(chat.getByRole("button", { name: "Add task" })).toBeEnabled());
    expect(sidebar.getAllByText(picks[0].title)).toHaveLength(outcome === "resolve" ? 2 : 1);
    expect(chat.queryByRole("alert")).not.toBeInTheDocument();
    expect(requestsFor("POST", "/api/tasks").map((request) => request.body)).toEqual([picks[0], picks[0]]);
    expect(requestsFor("POST", "/api/chat")[0].body).toEqual({ message: "Another plan", conversation_id: null });
    expect(requestsFor("GET", "/api/tasks")).toHaveLength(outcome === "resolve" ? 3 : 2);
  });
}

test("manual Enter submission rejects blank titles and remains guarded through creation and refresh", async () => {
  const user = userEvent.setup();
  const creation = deferred();
  const refresh = deferred();
  const created = task(1, { title: "Prepare slides" });
  enqueueResponse("GET", "/api/tasks", []);
  enqueueResponse("POST", "/api/tasks", created, { status: 201, deferred: creation });
  enqueueResponse("GET", "/api/tasks", [created], { deferred: refresh });
  render(<App />);
  const sidebar = within(screen.getByRole("complementary", { name: "Tasks" }));
  const input = sidebar.getByRole("textbox", { name: "New task" });

  fireEvent.submit(input.form);
  await user.type(input, "   {Enter}");
  fireEvent.submit(input.form);
  expect(requestsFor("POST", "/api/tasks")).toHaveLength(0);
  await user.clear(input);
  await user.type(input, "Prepare slides{Enter}");
  act(() => {
    fireEvent.submit(input.form);
    fireEvent.submit(input.form);
  });
  expect(input).toBeDisabled();
  expect(input).toHaveValue("Prepare slides");
  await user.type(input, "Duplicate{Enter}");
  expect(requestsFor("POST", "/api/tasks").map((request) => request.body)).toEqual([{ title: "Prepare slides" }]);
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(1);

  await resolveResponse(creation, created);

  await waitFor(() => expect(input).toHaveValue(""));
  expect(input).toBeDisabled();
  fireEvent.submit(input.form);
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(2);
  await resolveResponse(refresh, [created]);
  expect(await sidebar.findByText("Prepare slides")).toBeVisible();
  await waitFor(() => expect(input).toBeEnabled());
  expect(sidebar.getByRole("checkbox", { name: 'Mark "Prepare slides" done' })).not.toBeChecked();
  expect(requestsFor("POST", "/api/tasks")).toHaveLength(1);
});

test("failed manual creation preserves the title and permits a successful Enter retry", async () => {
  const user = userEvent.setup();
  const created = task(1, { title: "Keep my draft" });
  enqueueResponse("GET", "/api/tasks", []);
  enqueueResponse("POST", "/api/tasks", { detail: "Creation unavailable" }, { status: 503 });
  render(<App />);
  const chat = within(screen.getByRole("region", { name: "Chat" }));
  const sidebar = within(screen.getByRole("complementary", { name: "Tasks" }));
  const input = sidebar.getByRole("textbox", { name: "New task" });

  await user.type(input, "Keep my draft{Enter}");

  expect(await chat.findByRole("alert")).toHaveTextContent("Creation unavailable");
  expect(input).toHaveValue("Keep my draft");
  expect(input).toBeEnabled();
  expect(sidebar.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(1);
  enqueueResponse("POST", "/api/tasks", created, { status: 201 });
  enqueueResponse("GET", "/api/tasks", [created]);
  await user.type(input, "{Enter}");

  expect(await sidebar.findByText("Keep my draft")).toBeVisible();
  await waitFor(() => expect(input).toBeEnabled());
  expect(input).toHaveValue("");
  expect(chat.queryByRole("alert")).not.toBeInTheDocument();
  expect(requestsFor("POST", "/api/tasks").map((request) => request.body)).toEqual([
    { title: "Keep my draft" }, { title: "Keep my draft" },
  ]);
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(2);
});

function expectTaskCopies(chat, sidebar, { done = false, pending = false } = {}) {
  const name = `Mark "Task 1" ${done ? "open" : "done"}`;
  const chatCopies = chat.getAllByRole("checkbox", { name });
  const sidebarCopy = sidebar.getByRole("checkbox", { name });
  expect(chatCopies).toHaveLength(2);
  [...chatCopies, sidebarCopy].forEach((checkbox) => {
    if (done) expect(checkbox).toBeChecked();
    else expect(checkbox).not.toBeChecked();
    if (pending) expect(checkbox).toBeDisabled();
    else expect(checkbox).toBeEnabled();
  });
  const remove = sidebar.getByRole("button", { name: 'Delete "Task 1"' });
  if (pending) expect(remove).toBeDisabled();
  else expect(remove).toBeEnabled();
}

for (const source of ["chat", "sidebar"]) {
  test(`completion from ${source} synchronizes repeated attachments, excludes deletion, and supports reopening`, async () => {
    const { user, chat, sidebar } = await renderWorkflow({ tasks: [task(1)], repeated: true });
    const patchResponse = deferred();
    const refresh = deferred();
    const completed = task(1, { done: true });
    enqueueResponse("PATCH", "/api/tasks/1", completed, { deferred: patchResponse });
    enqueueResponse("GET", "/api/tasks", [completed], { deferred: refresh });
    const chatCopies = chat.getAllByRole("checkbox", { name: 'Mark "Task 1" done' });
    const sidebarCopy = sidebar.getByRole("checkbox", { name: 'Mark "Task 1" done' });
    const first = source === "chat" ? chatCopies[0] : sidebarCopy;

    act(() => {
      fireEvent.click(first);
      fireEvent.click(chatCopies[1]);
      fireEvent.click(sidebarCopy);
      fireEvent.click(sidebar.getByRole("button", { name: 'Delete "Task 1"' }));
    });
    expectTaskCopies(chat, sidebar, { pending: true });
    await user.click(sidebar.getByRole("button", { name: 'Delete "Task 1"' }));
    expect(requestsFor("PATCH", "/api/tasks/1").map((request) => request.body)).toEqual([{ done: true }]);
    expect(requestsFor("DELETE", "/api/tasks/1")).toHaveLength(0);
    expect(requestsFor("GET", "/api/tasks")).toHaveLength(1);

    await resolveResponse(patchResponse, completed);
    await waitFor(() => expectTaskCopies(chat, sidebar, { done: true, pending: true }));
    expect(sidebar.getByRole("heading", { name: "Done" })).toBeVisible();
    expect(requestsFor("GET", "/api/tasks")).toHaveLength(2);
    await resolveResponse(refresh, [completed]);
    await waitFor(() => expectTaskCopies(chat, sidebar, { done: true }));

    enqueueResponse("PATCH", "/api/tasks/1", task(1));
    enqueueResponse("GET", "/api/tasks", [task(1)]);
    const reopen = source === "chat"
      ? sidebar.getByRole("checkbox", { name: 'Mark "Task 1" open' })
      : chat.getAllByRole("checkbox", { name: 'Mark "Task 1" open' })[1];
    await user.click(reopen);

    await waitFor(() => expectTaskCopies(chat, sidebar));
    expect(sidebar.queryByRole("heading", { name: "Done" })).not.toBeInTheDocument();
    expect(requestsFor("PATCH", "/api/tasks/1").map((request) => request.body)).toEqual([
      { done: true }, { done: false },
    ]);
    expect(requestsFor("GET", "/api/tasks")).toHaveLength(3);
    expect(requestsFor("POST", "/api/tasks")).toHaveLength(0);
  });
}

test("deletion accepts 204, guards repeated clicks and completion, and removes all historical copies", async () => {
  const { user, chat, sidebar } = await renderWorkflow({ tasks: [task(1), task(2)], repeated: true });
  const deletion = deferred();
  enqueueResponse("DELETE", "/api/tasks/1", null, { status: 204, deferred: deletion });
  enqueueResponse("GET", "/api/tasks", [task(2)]);
  const remove = sidebar.getByRole("button", { name: 'Delete "Task 1"' });
  const chatCopies = chat.getAllByRole("checkbox", { name: 'Mark "Task 1" done' });
  const sidebarCopy = sidebar.getByRole("checkbox", { name: 'Mark "Task 1" done' });

  act(() => {
    fireEvent.click(remove);
    fireEvent.click(remove);
    fireEvent.click(chatCopies[0]);
    fireEvent.click(chatCopies[1]);
    fireEvent.click(sidebarCopy);
  });
  expectTaskCopies(chat, sidebar, { pending: true });
  await user.click(remove);
  await user.click(chatCopies[0]);
  expect(requestsFor("DELETE", "/api/tasks/1")).toHaveLength(1);
  expect(requestsFor("PATCH", "/api/tasks/1")).toHaveLength(0);
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(1);

  await resolveResponse(deletion, null);

  await waitFor(() => {
    expect(chat.queryByText("Task 1")).not.toBeInTheDocument();
    expect(sidebar.queryByText("Task 1")).not.toBeInTheDocument();
  });
  expect(chat.getAllByText("Task 2")).toHaveLength(2);
  expect(sidebar.getByText("Task 2")).toBeVisible();
  expect(chat.getByText("Workflow history")).toBeVisible();
  expect(chat.getByText("Repeated workflow listing")).toBeVisible();
  expect(sidebar.queryByRole("button", { name: 'Delete "Task 1"' })).not.toBeInTheDocument();
  expect(chat.queryByRole("alert")).not.toBeInTheDocument();
  expect(requestsFor("DELETE", "/api/tasks/1")).toHaveLength(1);
  expect(requestsFor("GET", "/api/tasks")).toHaveLength(2);
});

for (const method of ["PATCH", "DELETE"]) {
  test(`failed ${method} preserves attachments, releases every control, and allows retry`, async () => {
    const { user, chat, sidebar } = await renderWorkflow({ tasks: [task(1)], repeated: true });
    const failure = deferred();
    enqueueResponse(method, "/api/tasks/1", { detail: `${method} unavailable` }, {
      status: 503, deferred: failure,
    });
    const control = () => method === "PATCH"
      ? chat.getAllByRole("checkbox", { name: 'Mark "Task 1" done' })[0]
      : sidebar.getByRole("button", { name: 'Delete "Task 1"' });

    await user.click(control());
    expectTaskCopies(chat, sidebar, { pending: true });
    await resolveResponse(failure, { detail: `${method} unavailable` });

    expect(await chat.findByRole("alert")).toHaveTextContent(`${method} unavailable`);
    await waitFor(() => expectTaskCopies(chat, sidebar));
    expect(chat.getAllByText("Task 1")).toHaveLength(2);
    expect(sidebar.getByText("Task 1")).toBeVisible();
    expect(requestsFor("GET", "/api/tasks")).toHaveLength(1);
    const updated = task(1, { done: true });
    enqueueResponse(method, "/api/tasks/1", method === "PATCH" ? updated : null, {
      status: method === "PATCH" ? 200 : 204,
    });
    enqueueResponse("GET", "/api/tasks", method === "PATCH" ? [updated] : []);
    await user.click(control());

    if (method === "PATCH") {
      await waitFor(() => expectTaskCopies(chat, sidebar, { done: true }));
      expect(requestsFor(method, "/api/tasks/1").map((request) => request.body)).toEqual([
        { done: true }, { done: true },
      ]);
    } else {
      await waitFor(() => expect(sidebar.queryByText("Task 1")).not.toBeInTheDocument());
      expect(chat.queryByText("Task 1")).not.toBeInTheDocument();
      expect(sidebar.getByText("No open tasks. Ask the assistant to plan something.")).toBeVisible();
    }
    expect(chat.queryByRole("alert")).not.toBeInTheDocument();
    expect(requestsFor(method, "/api/tasks/1")).toHaveLength(2);
    expect(requestsFor(method === "PATCH" ? "DELETE" : "PATCH", "/api/tasks/1")).toHaveLength(0);
    expect(requestsFor("GET", "/api/tasks")).toHaveLength(2);
  });
}

for (const method of ["PATCH", "DELETE"]) {
  test(`a failed refresh after successful ${method} retains the acknowledged local change`, async () => {
    const { user, chat, sidebar } = await renderWorkflow({ tasks: [task(1), task(2)], repeated: true });
    const updated = task(1, { done: true });
    enqueueResponse(method, "/api/tasks/1", method === "PATCH" ? updated : null, {
      status: method === "PATCH" ? 200 : 204,
    });
    enqueueResponse("GET", "/api/tasks", { detail: "Refresh unavailable" }, { status: 503 });

    await user.click(method === "PATCH"
      ? sidebar.getByRole("checkbox", { name: 'Mark "Task 1" done' })
      : sidebar.getByRole("button", { name: 'Delete "Task 1"' }));

    expect(await chat.findByRole("alert")).toHaveTextContent("Refresh unavailable");
    if (method === "PATCH") {
      await waitFor(() => expectTaskCopies(chat, sidebar, { done: true }));
      expect(sidebar.getByRole("heading", { name: "Done" })).toBeVisible();
      expect(requestsFor("PATCH", "/api/tasks/1")[0].body).toEqual({ done: true });
    } else {
      expect(sidebar.queryByText("Task 1")).not.toBeInTheDocument();
      expect(chat.queryByText("Task 1")).not.toBeInTheDocument();
    }
    expect(chat.getAllByText("Task 2")).toHaveLength(2);
    expect(sidebar.getByRole("checkbox", { name: 'Mark "Task 2" done' })).toBeEnabled();
    expect(sidebar.getByRole("button", { name: 'Delete "Task 2"' })).toBeEnabled();
    expect(requestsFor(method, "/api/tasks/1")).toHaveLength(1);
    expect(requestsFor("GET", "/api/tasks")).toHaveLength(2);
  });
}
