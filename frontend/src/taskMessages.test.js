import test from "node:test";
import assert from "node:assert/strict";
import { updateTaskInMessages, removeTaskFromMessages, reconcileTaskMessages } from "./taskMessages.js";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function task(id, fields = {}) {
  return { id, title: `Task ${id}`, notes: "", priority: "medium", due: null, done: false, ...fields };
}

test("updating a task replaces every matching attachment without changing suggestions or content", () => {
  const first = task(1);
  const unrelated = task(2);
  const suggestions = [{ id: 1, title: "A suggestion, not an existing task", priority: "high" }];
  const messages = deepFreeze([
    { id: 10, role: "assistant", content: "Your tasks.", tasks: [first, unrelated], suggestions },
    { id: 11, role: "user", content: "Show them again", suggestions: [] },
    { id: 12, role: "assistant", content: "Here they are.", tasks: [unrelated, { ...first }], suggestions: [] },
  ]);
  const snapshot = JSON.stringify(messages);
  const updated = deepFreeze(task(1, {
    title: "Edited task", notes: "New notes", priority: "high", due: "2030-04-12", done: true,
  }));

  const result = updateTaskInMessages(messages, updated);

  assert.deepEqual(result[0].tasks, [updated, unrelated]);
  assert.deepEqual(result[2].tasks, [unrelated, updated]);
  assert.deepEqual(result.map((message) => message.content), messages.map((message) => message.content));
  assert.deepEqual(result.map((message) => message.id), [10, 11, 12]);
  assert.strictEqual(result[0].suggestions, suggestions);
  assert.strictEqual(result[0].suggestions[0], suggestions[0]);
  assert.deepEqual(result[1].tasks ?? [], []);
  assert.equal(JSON.stringify(messages), snapshot);
});

test("updating can reopen a completed task and does not insert unlisted tasks", () => {
  const completed = task(1, { done: true });
  const messages = deepFreeze([
    { role: "assistant", content: "Tasks", tasks: [completed], suggestions: [] },
    { role: "assistant", content: "Other tasks", tasks: [task(2)], suggestions: [] },
  ]);
  const reopened = deepFreeze(task(1));

  const result = updateTaskInMessages(messages, reopened);

  assert.deepEqual(result[0].tasks, [reopened]);
  assert.deepEqual(result[1].tasks, messages[1].tasks);
  assert.deepEqual(updateTaskInMessages(messages, task(99)), messages);
  assert.equal(messages[0].tasks[0].done, true);
});

test("removing a task deletes it from all attachments while preserving order and suggestions", () => {
  const first = task(1);
  const second = task(2);
  const third = task(3);
  const suggestions = [{ id: 2, title: "Keep this suggestion", priority: "low" }];
  const messages = deepFreeze([
    { role: "assistant", content: "First listing", tasks: [third, second, first], suggestions },
    { role: "assistant", content: "Second listing", tasks: [second], suggestions: [] },
    { role: "assistant", content: "Unrelated listing", tasks: [first], suggestions: [] },
  ]);
  const snapshot = JSON.stringify(messages);

  const result = removeTaskFromMessages(messages, 2);

  assert.deepEqual(result[0].tasks, [third, first]);
  assert.deepEqual(result[1].tasks, []);
  assert.deepEqual(result[2].tasks, [first]);
  assert.deepEqual(result.map((message) => message.content), messages.map((message) => message.content));
  assert.strictEqual(result[0].suggestions, suggestions);
  assert.strictEqual(result[0].suggestions[0], suggestions[0]);
  assert.deepEqual(removeTaskFromMessages(messages, 99), messages);
  assert.equal(JSON.stringify(messages), snapshot);
});

test("reconciliation uses current completed and edited tasks, drops deleted IDs, and preserves attachment order", () => {
  const suggestions = [{ id: 2, title: "Still a suggestion", priority: "medium" }];
  const messages = deepFreeze([
    { role: "assistant", content: "Your tasks", tasks: [task(3), task(2), task(1)], suggestions },
    { role: "assistant", content: "Repeated listing", tasks: [task(1), task(3)], suggestions: [] },
  ]);
  const currentFirst = task(1, { done: true });
  const currentThird = task(3, {
    title: "Revised title", notes: "Revised notes", priority: "low", due: "2030-06-20",
  });
  // Authoritative order differs from attachment order, and task 4 was never attached.
  const currentTasks = deepFreeze([currentFirst, task(4), currentThird]);
  const messagesSnapshot = JSON.stringify(messages);
  const tasksSnapshot = JSON.stringify(currentTasks);

  const result = reconcileTaskMessages(messages, currentTasks);

  assert.deepEqual(result[0].tasks, [currentThird, currentFirst]);
  assert.deepEqual(result[1].tasks, [currentFirst, currentThird]);
  assert.deepEqual(result.map((message) => message.content), messages.map((message) => message.content));
  assert.strictEqual(result[0].suggestions, suggestions);
  assert.strictEqual(result[0].suggestions[0], suggestions[0]);
  assert.equal(JSON.stringify(messages), messagesSnapshot);
  assert.equal(JSON.stringify(currentTasks), tasksSnapshot);
});

test("an authoritative empty task list clears attachments but not suggestions", () => {
  const suggestions = [{ title: "Approve me", priority: "high" }];
  const messages = deepFreeze([
    { role: "assistant", content: "Existing and suggested tasks", tasks: [task(1), task(2)], suggestions },
  ]);
  const snapshot = JSON.stringify(messages);

  const result = reconcileTaskMessages(messages, deepFreeze([]));

  assert.deepEqual(result[0].tasks, []);
  assert.equal(result[0].content, messages[0].content);
  assert.strictEqual(result[0].suggestions, suggestions);
  assert.equal(JSON.stringify(messages), snapshot);
});

test("all helpers handle legacy messages and empty attachments without inserting tasks or changing suggestions", () => {
  const suggestions = [{ title: "Legacy suggestion", priority: "medium" }];
  const messages = deepFreeze([
    { id: 1, role: "user", content: "Hello" },
    { id: 2, role: "assistant", content: "An older reply", suggestions },
    { id: 3, role: "assistant", content: "No attachments", tasks: [], suggestions: [] },
  ]);
  const snapshot = JSON.stringify(messages);
  const current = deepFreeze(task(1, { done: true }));
  const results = [
    updateTaskInMessages(messages, current),
    removeTaskFromMessages(messages, 1),
    reconcileTaskMessages(messages, deepFreeze([current])),
    reconcileTaskMessages(messages, deepFreeze([])),
  ];

  for (const result of results) {
    assert.equal(result.length, messages.length);
    result.forEach((message, index) => {
      assert.deepEqual(message.tasks ?? [], []);
      assert.equal(message.id, messages[index].id);
      assert.equal(message.role, messages[index].role);
      assert.equal(message.content, messages[index].content);
      assert.strictEqual(message.suggestions, messages[index].suggestions);
    });
    assert.strictEqual(result[1].suggestions[0], suggestions[0]);
  }
  assert.equal(JSON.stringify(messages), snapshot);
});

test("all helpers accept an empty conversation", () => {
  const messages = deepFreeze([]);
  const current = deepFreeze(task(1));

  assert.deepEqual(updateTaskInMessages(messages, current), []);
  assert.deepEqual(removeTaskFromMessages(messages, 1), []);
  assert.deepEqual(reconcileTaskMessages(messages, deepFreeze([current])), []);
  assert.deepEqual(reconcileTaskMessages(messages, deepFreeze([])), []);
  assert.deepEqual(messages, []);
});
