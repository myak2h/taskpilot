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
