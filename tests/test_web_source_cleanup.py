import hashlib
import hmac
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


API_PATH = Path(__file__).resolve().parents[1] / "apps" / "web" / "api" / "web_core.py"
SPEC = importlib.util.spec_from_file_location("web_source_cleanup_test", API_PATH)
WEB_CORE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WEB_CORE)


def load_transcribe_module():
    class FakeFlask:
        def __init__(self, *_args, **_kwargs):
            pass

        def route(self, *_args, **_kwargs):
            return lambda function: function

    fake_flask = types.SimpleNamespace(
        Flask=FakeFlask,
        jsonify=lambda value: value,
        request=types.SimpleNamespace(),
    )
    transcribe_path = API_PATH.with_name("transcribe.py")
    spec = importlib.util.spec_from_file_location("web_transcribe_cleanup_test", transcribe_path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"flask": fake_flask}):
        spec.loader.exec_module(module)
    return module


class WebSourceCleanupTest(unittest.TestCase):
    def test_managed_blob_receives_a_server_signed_cleanup_token(self):
        source_url = (
            "https://si4slzwkn8wdmagr.public.blob.vercel-storage.com/"
            "uploads/recording-random.m4a"
        )
        with patch.dict("os.environ", {"BLOB_READ_WRITE_TOKEN": "test-secret"}):
            token = WEB_CORE.source_cleanup_token(source_url)
        expected = hmac.new(
            b"test-secret",
            f"release:{source_url}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(token, expected)

    def test_external_urls_never_receive_cleanup_authority(self):
        with patch.dict("os.environ", {"BLOB_READ_WRITE_TOKEN": "test-secret"}):
            self.assertIsNone(
                WEB_CORE.source_cleanup_token("https://example.com/recording.m4a")
            )

    def test_successful_sync_response_contains_a_cleanup_token(self):
        module = load_transcribe_module()
        source_url = (
            "https://si4slzwkn8wdmagr.public.blob.vercel-storage.com/"
            "uploads/recording-random.m4a"
        )
        request = types.SimpleNamespace(
            body=json.dumps({
                "input_mode": "url",
                "source_url": source_url,
                "file_name": "recording.m4a",
                "output_format": "txt",
                "translate": False,
            }).encode("utf-8"),
            form={},
            files={},
        )
        module.process_media = lambda **_kwargs: {
            "output_filename": "recording.txt",
            "segment_count": 1,
            "translated": False,
        }
        with patch.dict("os.environ", {"BLOB_READ_WRITE_TOKEN": "test-secret"}):
            response = module.handler(request)
            expected = WEB_CORE.source_cleanup_token(source_url)

        self.assertTrue(response["ok"])
        self.assertEqual(response["source_cleanup_token"], expected)


if __name__ == "__main__":
    unittest.main()
