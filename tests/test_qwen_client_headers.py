import io
import unittest
from unittest.mock import patch

from outputs.work import llm_translate


class QwenClientHeaderTests(unittest.TestCase):
    def test_qwen_request_identifies_client_to_avoid_default_python_ua_block(self):
        config = {
            "provider": "qwen", "label": "Qwen", "base_url": "https://example.invalid/v1",
            "api_key": "test-only", "model": "test-model",
        }
        response = io.BytesIO(b'{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}')
        with patch.object(llm_translate.urllib.request, "urlopen", return_value=response) as open_url:
            content, finish_reason = llm_translate._stream_completion(config, [{"id": 1, "text": "Hi"}])
        request = open_url.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"), "Mozilla/5.0 (compatible; video2text/1.0)")
        self.assertEqual(request.get_header("Authorization"), "Bearer test-only")
        self.assertEqual(content, "ok")
        self.assertEqual(finish_reason, "stop")

    def test_other_provider_keeps_its_existing_headers(self):
        config = {
            "provider": "minimax", "label": "MiniMax", "base_url": "https://example.invalid/v1",
            "api_key": "test-only", "model": "test-model",
        }
        response = io.BytesIO(b'{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}')
        with patch.object(llm_translate.urllib.request, "urlopen", return_value=response) as open_url:
            llm_translate._stream_completion(config, [{"id": 1, "text": "Hi"}])
        self.assertFalse(open_url.call_args.args[0].has_header("User-agent"))


if __name__ == "__main__":
    unittest.main()
