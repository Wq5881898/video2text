import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch


API_PATH = Path(__file__).resolve().parents[1] / "apps" / "web" / "api" / "cloud_pipeline.py"
SPEC = importlib.util.spec_from_file_location("web_cloud_pipeline_test", API_PATH)
PIPELINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PIPELINE)


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class MiniMaxTranslationTest(unittest.TestCase):
    def test_valid_response_preserves_segment_order(self):
        payload = {
            "choices": [{"finish_reason": "stop", "message": {
                "content": json.dumps({"translations": [
                    {"id": 0, "text": "你好"}, {"id": 1, "text": "再见"},
                ]}, ensure_ascii=False),
            }}],
        }
        segments = [
            {"start": 0, "end": 1, "speaker": None, "text": "Hello"},
            {"start": 1, "end": 2, "speaker": None, "text": "Bye"},
        ]
        with patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}), patch.object(
            PIPELINE.urllib.request, "urlopen", return_value=FakeResponse(payload)
        ):
            result = PIPELINE.translate_segments(segments)
        self.assertEqual([item["text"] for item in result], ["你好", "再见"])

    def test_mismatched_ids_are_rejected(self):
        payload = {"choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps({"translations": [{"id": 1, "text": "你好"}]})
        }}]}
        with patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}), patch.object(
            PIPELINE.urllib.request, "urlopen", return_value=FakeResponse(payload)
        ):
            with self.assertRaisesRegex(RuntimeError, "mismatched segment ids"):
                PIPELINE._minimax_translate_batch(["Hello"])

    def test_truncated_output_is_rejected(self):
        payload = {"choices": [{"finish_reason": "length", "message": {"content": "{}"}}]}
        with patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}), patch.object(
            PIPELINE.urllib.request, "urlopen", return_value=FakeResponse(payload)
        ):
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                PIPELINE._minimax_translate_batch(["Hello"])

    def test_malformed_json_is_retried(self):
        malformed = {"choices": [{"finish_reason": "stop", "message": {"content": "{broken"}}]}
        valid = {"choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps({"translations": [{"id": 0, "text": "你好"}]}, ensure_ascii=False)
        }}]}
        with patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}), patch.object(
            PIPELINE.urllib.request, "urlopen", side_effect=[FakeResponse(malformed), FakeResponse(valid)]
        ), patch.object(PIPELINE.time, "sleep"):
            self.assertEqual(PIPELINE._minimax_translate_batch(["Hello"]), ["你好"])

    def test_malformed_batch_is_split(self):
        calls = []

        def response_for(request, timeout):
            items = json.loads(request.data)["messages"][1]["content"]
            segments = json.loads(items)["segments"]
            calls.append(len(segments))
            if len(segments) > 1:
                content = "{broken"
            else:
                content = json.dumps({"translations": [{"id": 0, "text": "你好" if segments[0]["text"] == "Hello" else "再见"}]}, ensure_ascii=False)
            return FakeResponse({"choices": [{"finish_reason": "stop", "message": {"content": content}}]})

        with patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}), patch.object(
            PIPELINE.urllib.request, "urlopen", side_effect=response_for
        ), patch.object(PIPELINE.time, "sleep"):
            result = PIPELINE._minimax_translate_batch(["Hello", "Bye"])
        self.assertEqual(result, ["你好", "再见"])
        self.assertEqual(calls, [2, 2, 1, 1])

    def test_rate_limit_is_not_split(self):
        with patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}), patch.object(
            PIPELINE, "_request_minimax_batch", side_effect=RuntimeError("MiniMax translation failed: HTTP 429")
        ) as request:
            with self.assertRaisesRegex(RuntimeError, "HTTP 429"):
                PIPELINE._minimax_translate_batch(["Hello", "Bye"])
        self.assertEqual(request.call_count, 1)


if __name__ == "__main__":
    unittest.main()
