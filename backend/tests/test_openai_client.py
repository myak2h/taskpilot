import unittest

from openai import OpenAI


class OpenAIClientCompatibilityTest(unittest.TestCase):
    def test_client_initializes_with_installed_httpx(self):
        with OpenAI(api_key="test-key"):
            pass


if __name__ == "__main__":
    unittest.main()
