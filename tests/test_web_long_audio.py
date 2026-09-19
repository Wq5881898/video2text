import importlib.util
import io
import json
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch


API_PATH = Path(__file__).resolve().parents[1] / "apps" / "web" / "api" / "cloud_pipeline.py"
SPEC = importlib.util.spec_from_file_location("web_long_audio_test", API_PATH)
PIPELINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PIPELINE)


class LongAudioTest(unittest.TestCase):
    def test_python_dev_helper_keeps_the_sync_url_entry_working(self):
        dev_path = API_PATH.parent.parent / "dev_server.py"
        spec = importlib.util.spec_from_file_location("web_dev_long_audio_test", dev_path)
        dev = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dev)
        handler = object.__new__(dev.WebDevHandler)
        handler.path = "/api/media-info"
        handler.command = "POST"
        with patch.object(handler, "_json_response") as respond:
            handler._dispatch_api()
        respond.assert_called_once_with(200, {
            "ok": True, "splitting_supported": False, "split_required": False,
        })

    def test_duration_limit_error_is_explicitly_marked_for_background_handoff(self):
        body = json.dumps({"message": "Audio duration is greater than the maximum allowed duration (8100 seconds but actual duration is 12309 seconds)"}).encode()
        error = urllib.error.HTTPError("https://api.gladia.io/v2/upload", 400, "Bad Request", {}, io.BytesIO(body))
        with patch.dict("os.environ", {"GLADIA_API_KEY": "test-key"}), patch.object(
            PIPELINE.urllib.request, "urlopen", side_effect=error
        ):
            with self.assertRaises(PIPELINE.LongAudioRequiresBackground):
                PIPELINE.upload_media_bytes("recording.m4a", b"test audio")

    def test_other_gladia_errors_are_not_mistaken_for_duration_limits(self):
        error = urllib.error.HTTPError("https://api.gladia.io/v2/upload", 401, "Unauthorized", {}, io.BytesIO(b'{"message":"invalid key"}'))
        with patch.dict("os.environ", {"GLADIA_API_KEY": "test-key"}), patch.object(
            PIPELINE.urllib.request, "urlopen", side_effect=error
        ):
            with self.assertRaisesRegex(RuntimeError, "HTTP 401") as caught:
                PIPELINE.upload_media_bytes("recording.m4a", b"test audio")
        self.assertNotIsInstance(caught.exception, PIPELINE.LongAudioRequiresBackground)


if __name__ == "__main__":
    unittest.main()
