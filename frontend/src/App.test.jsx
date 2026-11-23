import { expect, test } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.jsx";
import { enqueueResponse, requestsFor } from "./test/api.js";

function task(id, fields = {}) {
  return { id, title: `Task ${id}`, notes: "", priority: "medium", due: null, done: false, ...fields };
}

function message(id, fields = {}) {
  return { id, role: "assistant", content: `Message ${id}`, suggestions: [], tasks: [], ...fields };
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
