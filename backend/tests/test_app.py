import json
import os
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from openai import OpenAI
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

_database_dir = tempfile.TemporaryDirectory()
os.environ["DATABASE_URL"] = f"sqlite:///{_database_dir.name}/test.db"

from app import models
from app.db import Base, get_db
from app.main import app


class AppCompatibilityTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_postgres_drivers_load(self):
        for driver in ("postgresql", "postgresql+psycopg2"):
            engine = create_engine(f"{driver}://test:test@localhost/test")
            engine.dispose()

    def test_tasks_and_demo_chat(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            self.assertEqual(self.client.get("/api/health").json(), {"ok": True})
            chat = self.client.post("/api/chat", json={"message": "Buy milk and call mom"})
            self.assertEqual(chat.status_code, 200)
            message = chat.json()["message"]
            self.assertEqual(len(message["suggestions"]), 2)
            conversation_id = chat.json()["conversation_id"]
            history = self.client.get(f"/api/conversations/{conversation_id}/messages").json()
            self.assertEqual([item["role"] for item in history], ["user", "assistant"])

        created = self.client.post("/api/tasks", json=message["suggestions"][0])
        self.assertEqual(created.status_code, 201)
        task_id = created.json()["id"]
        updated = self.client.patch(f"/api/tasks/{task_id}", json={"done": True})
        self.assertTrue(updated.json()["done"])
        self.assertIn(task_id, [task["id"] for task in self.client.get("/api/tasks").json()])
        self.assertEqual(self.client.delete(f"/api/tasks/{task_id}").status_code, 204)

    def test_openai_tool_call_round_trip(self):
        requests = []

        def respond(request):
            payload = json.loads(request.content)
            requests.append(payload)
            if len(requests) == 1:
                message = {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "suggest_tasks",
                            "arguments": json.dumps({"tasks": [{"title": "Visit apartments", "priority": "high"}]}),
                        },
                    }],
                }
            else:
                message = {"role": "assistant", "content": "Here is your task."}
            return httpx.Response(200, json={
                "id": "test-completion",
                "object": "chat.completion",
                "created": 0,
                "model": "test-model",
                "choices": [{"index": 0, "finish_reason": "stop", "message": message}],
            })

        with httpx.Client(transport=httpx.MockTransport(respond)) as http_client:
            with OpenAI(api_key="test-key", http_client=http_client) as openai_client:
                with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}), \
                        patch("openai.OpenAI", return_value=openai_client):
                    response = self.client.post("/api/chat", json={"message": "Plan apartment visits"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["message"]["suggestions"][0]["title"], "Visit apartments")
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[1]["messages"][-1]["role"], "tool")


class ChatTaskAttachmentTest(unittest.TestCase):
    def setUp(self):
        database_dir = tempfile.TemporaryDirectory()
        self.addCleanup(database_dir.cleanup)
        engine = create_engine(
            f"sqlite:///{database_dir.name}/attachments.db",
            connect_args={"check_same_thread": False},
        )
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        self.addCleanup(Base.metadata.drop_all, engine)
        self.session_factory = sessionmaker(bind=engine, autoflush=False)

        def isolated_db():
            with self.session_factory() as db:
                yield db

        app.dependency_overrides[get_db] = isolated_db
        self.addCleanup(app.dependency_overrides.pop, get_db)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def create_task(self, title, **fields):
        response = self.client.post("/api/tasks", json={"title": title, **fields})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def seed_tasks(self):
        first = self.create_task(
            "Inspect rooftop garden", notes="Bring the watering log", priority="high", due="2030-04-12"
        )
        second = self.create_task("Reserve rehearsal room", notes="Ask for room B", priority="low")
        completed = self.create_task("Archive winter receipts", priority="medium")
        response = self.client.patch(f"/api/tasks/{completed['id']}", json={"done": True})
        self.assertEqual(response.status_code, 200)
        return first, second, response.json()

    def task_snapshot(self):
        response = self.client.get("/api/tasks")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def history(self, conversation_id):
        response = self.client.get(f"/api/conversations/{conversation_id}/messages")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def demo_chat(self, text):
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            response = self.client.post("/api/chat", json={"message": text})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def assert_listing(self, message, tasks, suggestions=None):
        self.assertEqual(message["tasks"], tasks)
        self.assertEqual(message["suggestions"], suggestions or [])
        self.assertTrue(message["content"].strip())
        self.assertIn("checkbox", message["content"].lower())
        self.assertLess(len(message["content"]), 300)
        for task in tasks:
            self.assertNotIn(task["title"], message["content"])
            self.assertEqual(set(task), {"id", "title", "notes", "priority", "due", "done"})

    def assert_references(self, message_id, tasks):
        with self.session_factory() as db:
            references = (db.query(models.MessageTask).filter_by(message_id=message_id)
                          .order_by(models.MessageTask.task_id).all())
            self.assertEqual([reference.task_id for reference in references], [task["id"] for task in tasks])

    def tool_call(self, call_id, name, arguments):
        return {
            "id": call_id,
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)},
        }

    def tool_message(self, *calls):
        return {"role": "assistant", "content": None, "tool_calls": list(calls)}

    def openai_chat(self, replies, text="Show my tasks"):
        requests = []

        def respond(request):
            requests.append(json.loads(request.content))
            self.assertLessEqual(len(requests), len(replies), "Unexpected extra model request")
            message = replies[len(requests) - 1]
            return httpx.Response(200, json={
                "id": "test-completion",
                "object": "chat.completion",
                "created": 0,
                "model": "test-model",
                "choices": [{
                    "index": 0,
                    "finish_reason": "tool_calls" if message.get("tool_calls") else "stop",
                    "message": message,
                }],
            })

        with httpx.Client(transport=httpx.MockTransport(respond)) as http_client:
            with OpenAI(api_key="test-key", http_client=http_client) as openai_client:
                with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}), \
                        patch("openai.OpenAI", return_value=openai_client):
                    response = self.client.post("/api/chat", json={"message": text})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(requests), len(replies))
        return response.json(), requests

    def assert_tool_tasks(self, request, call_id, tasks):
        result = next(message for message in request["messages"]
                      if message.get("tool_call_id") == call_id)
        self.assertEqual(result["role"], "tool")
        self.assertEqual(json.loads(result["content"]), [
            {key: task[key] for key in ("id", "title", "priority", "due")}
            for task in tasks
        ])

    def test_demo_listing_tracks_current_state_and_deletion(self):
        first, second, completed = self.seed_tasks()
        before = self.task_snapshot()
        result = self.demo_chat("What's on my plate?")
        message = result["message"]
        self.assert_listing(message, [first, second])
        self.assertNotIn(completed["title"], message["content"])
        self.assertEqual(self.task_snapshot(), before)
        self.assert_references(message["id"], [first, second])
        history = self.history(result["conversation_id"])
        self.assertEqual(history[-1], message)
        self.assertEqual(history[0]["tasks"], [])

        response = self.client.patch(f"/api/tasks/{first['id']}", json={"done": True})
        self.assertEqual(response.status_code, 200)
        first = response.json()
        self.assertTrue(first["done"])
        self.assertEqual(self.history(result["conversation_id"])[-1]["tasks"], [first, second])

        response = self.client.patch(
            f"/api/tasks/{first['id']}", json={"title": "Inspect the edited garden", "notes": "Updated notes"}
        )
        self.assertEqual(response.status_code, 200)
        first = response.json()
        self.assertEqual(self.history(result["conversation_id"])[-1]["tasks"], [first, second])

        response = self.client.delete(f"/api/tasks/{second['id']}")
        self.assertEqual(response.status_code, 204)
        self.assertEqual(self.history(result["conversation_id"])[-1]["tasks"], [first])
        self.assert_references(message["id"], [first])
        next_listing = self.demo_chat("Show my tasks")
        self.assertEqual(next_listing["message"]["tasks"], [])
        self.assertIn("no open tasks", next_listing["message"]["content"].lower())

    def test_demo_empty_listing(self):
        completed = self.create_task("Already filed report")
        self.client.patch(f"/api/tasks/{completed['id']}", json={"done": True})
        before = self.task_snapshot()
        result = self.demo_chat("Show my tasks")
        message = result["message"]
        self.assertEqual(message["tasks"], [])
        self.assertEqual(message["suggestions"], [])
        self.assertIn("no open tasks", message["content"].lower())
        self.assertNotIn(completed["title"], message["content"])
        self.assertEqual(self.history(result["conversation_id"])[-1], message)
        self.assertEqual(self.task_snapshot(), before)

    def test_demo_suggestions_and_conversation_have_no_attachments(self):
        self.seed_tasks()
        before = self.task_snapshot()
        result = self.demo_chat("Buy milk and call mom")
        message = result["message"]
        self.assertEqual([suggestion["title"] for suggestion in message["suggestions"]],
                         ["Buy milk", "Call mom"])
        self.assertEqual(message["tasks"], [])
        self.assertEqual(self.history(result["conversation_id"])[-1], message)
        conversational = self.demo_chat("Hi")
        self.assertEqual(conversational["message"]["suggestions"], [])
        self.assertEqual(conversational["message"]["tasks"], [])
        self.assertEqual(self.task_snapshot(), before)

    def test_legacy_message_has_empty_attachments(self):
        self.seed_tasks()
        suggestions = [{"title": "Legacy suggestion", "priority": "medium"}]
        with self.session_factory() as db:
            conversation = models.Conversation()
            db.add(conversation)
            db.flush()
            message = models.Message(
                conversation_id=conversation.id, role="assistant", content="An older reply", suggestions=suggestions
            )
            db.add(message)
            db.commit()
            conversation_id, message_id = conversation.id, message.id
        self.assertEqual(self.history(conversation_id), [{
            "id": message_id, "role": "assistant", "content": "An older reply",
            "suggestions": suggestions, "tasks": [],
        }])
        self.assert_references(message_id, [])

    def test_openai_visible_listing_defaults_and_explicit_true(self):
        first, second, completed = self.seed_tasks()
        before = self.task_snapshot()
        introductions = []
        for arguments in ({}, {"present_to_user": True}):
            with self.subTest(arguments=arguments):
                result, requests = self.openai_chat([
                    self.tool_message(self.tool_call("list_1", "list_tasks", arguments)),
                    {"role": "assistant", "content": f"Your tasks: {first['title']}; {second['title']}."},
                ])
                message = result["message"]
                self.assert_listing(message, [first, second])
                self.assertNotIn(completed["title"], message["content"])
                self.assert_tool_tasks(requests[1], "list_1", [first, second])
                self.assert_references(message["id"], [first, second])
                self.assertEqual(self.history(result["conversation_id"])[-1], message)
                self.assertEqual(self.task_snapshot(), before)
                introductions.append(message["content"])
        self.assertEqual(introductions[0], introductions[1])

    def test_openai_repeated_visible_calls_do_not_duplicate_references(self):
        first, second, _ = self.seed_tasks()
        before = self.task_snapshot()
        result, requests = self.openai_chat([
            self.tool_message(
                self.tool_call("list_1", "list_tasks", {}),
                self.tool_call("list_2", "list_tasks", {"present_to_user": True}),
            ),
            self.tool_message(self.tool_call("list_3", "list_tasks", {})),
            {"role": "assistant", "content": f"Remember {first['title']} and {second['title']}."},
        ])
        message = result["message"]
        self.assert_listing(message, [first, second])
        self.assert_references(message["id"], [first, second])
        self.assert_tool_tasks(requests[1], "list_1", [first, second])
        self.assert_tool_tasks(requests[1], "list_2", [first, second])
        self.assert_tool_tasks(requests[2], "list_3", [first, second])
        self.assertEqual(self.history(result["conversation_id"])[-1], message)
        self.assertEqual(self.task_snapshot(), before)

    def test_openai_background_lookup_preserves_reply_and_suggestions(self):
        first, second, _ = self.seed_tasks()
        before = self.task_snapshot()
        suggestion = {"title": "Prepare concert itinerary", "notes": "Check travel times",
                      "priority": "high", "due": "2030-05-01"}
        reply = "I avoided duplicates. You can add this suggestion with one click."
        result, requests = self.openai_chat([
            self.tool_message(self.tool_call("background", "list_tasks", {"present_to_user": False})),
            self.tool_message(self.tool_call("suggest", "suggest_tasks", {"tasks": [suggestion]})),
            {"role": "assistant", "content": reply},
        ], text="Plan my concert trip without duplicating existing tasks")
        message = result["message"]
        self.assertEqual(message["content"], reply)
        self.assertEqual(message["suggestions"], [suggestion])
        self.assertEqual(message["tasks"], [])
        self.assert_tool_tasks(requests[1], "background", [first, second])
        self.assert_references(message["id"], [])
        self.assertEqual(self.history(result["conversation_id"])[-1], message)
        self.assertEqual(self.task_snapshot(), before)

    def test_openai_visible_listing_with_suggestions(self):
        first, second, _ = self.seed_tasks()
        before = self.task_snapshot()
        suggestion = {"title": "Draft festival budget", "notes": "", "priority": "medium", "due": None}
        result, _ = self.openai_chat([
            self.tool_message(
                self.tool_call("visible", "list_tasks", {"present_to_user": True}),
                self.tool_call("suggest", "suggest_tasks", {"tasks": [suggestion]}),
            ),
            {"role": "assistant", "content": f"{first['title']}, {second['title']}, and {suggestion['title']}."},
        ])
        message = result["message"]
        self.assert_listing(message, [first, second], [suggestion])
        self.assertIn("add", message["content"].lower())
        self.assertNotIn(suggestion["title"], message["content"])
        self.assert_references(message["id"], [first, second])
        self.assertEqual(self.history(result["conversation_id"])[-1], message)
        self.assertEqual(self.task_snapshot(), before)

    def test_openai_empty_visible_listing_replaces_model_reply(self):
        for suggestions in ([], [{"title": "Book studio", "notes": "", "priority": "low", "due": None}]):
            with self.subTest(suggestions=suggestions):
                calls = [self.tool_call("empty", "list_tasks", {})]
                if suggestions:
                    calls.append(self.tool_call("suggest", "suggest_tasks", {"tasks": suggestions}))
                result, requests = self.openai_chat([
                    self.tool_message(*calls),
                    {"role": "assistant", "content": "Here is a long, irrelevant planning response."},
                ])
                message = result["message"]
                self.assertEqual(message["tasks"], [])
                self.assertEqual(message["suggestions"], suggestions)
                self.assertIn("no open tasks", message["content"].lower())
                self.assert_tool_tasks(requests[1], "empty", [])
                if suggestions:
                    self.assertIn("add", message["content"].lower())
                    self.assertNotIn(suggestions[0]["title"], message["content"])
                self.assertEqual(self.history(result["conversation_id"])[-1], message)
                self.assertEqual(self.task_snapshot(), [])

    def test_openai_tool_loop_exhaustion_retains_listing_and_suggestions(self):
        first, second, _ = self.seed_tasks()
        before = self.task_snapshot()
        suggestion = {"title": "Review sound equipment", "notes": "", "priority": "high", "due": None}
        result, requests = self.openai_chat([
            self.tool_message(self.tool_call("visible", "list_tasks", {})),
            self.tool_message(self.tool_call("suggest", "suggest_tasks", {"tasks": [suggestion]})),
            self.tool_message(self.tool_call("again", "list_tasks", {"present_to_user": True})),
        ])
        message = result["message"]
        self.assert_listing(message, [first, second], [suggestion])
        self.assertIn("add", message["content"].lower())
        self.assertNotIn(suggestion["title"], message["content"])
        self.assert_tool_tasks(requests[1], "visible", [first, second])
        self.assert_references(message["id"], [first, second])
        self.assertEqual(self.history(result["conversation_id"])[-1], message)
        self.assertEqual(self.task_snapshot(), before)

    def test_openai_conversational_reply_has_no_attachments(self):
        self.seed_tasks()
        before = self.task_snapshot()
        reply = "Hello! How can I help?"
        result, _ = self.openai_chat([{"role": "assistant", "content": reply}], text="Hello")
        message = result["message"]
        self.assertEqual(message["content"], reply)
        self.assertEqual(message["suggestions"], [])
        self.assertEqual(message["tasks"], [])
        self.assertEqual(self.task_snapshot(), before)


if __name__ == "__main__":
    unittest.main()
