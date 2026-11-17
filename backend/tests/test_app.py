import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
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


if __name__ == "__main__":
    unittest.main()
