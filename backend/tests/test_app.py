import json
import os
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from openai import OpenAI
from sqlalchemy import create_engine

_database_dir = tempfile.TemporaryDirectory()
os.environ["DATABASE_URL"] = f"sqlite:///{_database_dir.name}/test.db"

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


if __name__ == "__main__":
    unittest.main()
