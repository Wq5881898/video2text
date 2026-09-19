from __future__ import annotations

import json
import math
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from packages.shared_core import audio_chunks as chunks
from packages.shared_core import media_pipeline as pipeline


class AudioChunkTests(unittest.TestCase):
    def test_long_recording_is_balanced_and_below_limit(self):
        parts = chunks.plan_audio_parts(12309)
        self.assertEqual(len(parts), 2)
        self.assertEqual([item["duration_seconds"] for item in parts], [6154.5, 6154.5])
        self.assertEqual(parts[1]["offset_seconds"], 6154.5)
        for duration in (8000.001, 16000, 32001, 86400):
            parts = chunks.plan_audio_parts(duration)
            self.assertAlmostEqual(sum(part["duration_seconds"] for part in parts), duration)
            self.assertTrue(all(part["duration_seconds"] < 8000 for part in parts))

    def test_exact_limit_does_not_split(self):
        self.assertEqual(len(chunks.plan_audio_parts(8000)), 1)
        self.assertEqual(len(chunks.plan_audio_parts(8000.001)), 2)

    def test_invalid_duration_and_unsafe_limit_are_rejected(self):
        for duration in (0, -1, math.nan, math.inf):
            with self.assertRaises(ValueError):
                chunks.plan_audio_parts(duration)
        for limit in (0, 2, 8100, math.nan, math.inf):
            with self.assertRaises(ValueError):
                chunks.plan_audio_parts(12309, limit)

    def test_probe_uses_format_duration_when_stream_duration_is_missing(self):
        response = {"streams": [{"codec_name": "aac", "duration": "N/A"}], "format": {"duration": "12309"}}
        with patch.object(chunks, "run_media_tool", return_value=json.dumps(response)):
            self.assertEqual(chunks.probe_audio("ffprobe", Path("source.m4a")),
                             {"duration_seconds": 12309, "codec": "aac"})

    def test_probe_rejects_missing_track_and_duration(self):
        for response in ({"streams": []}, {"streams": [{"duration": "nan"}]}):
            with patch.object(chunks, "run_media_tool", return_value=json.dumps(response)):
                with self.assertRaises(RuntimeError):
                    chunks.probe_audio("ffprobe", Path("source.m4a"))

    def test_timestamp_rounding_carries_and_uses_srt_comma(self):
        self.assertEqual(pipeline.fmt_srt_timestamp(59.9996), "00:01:00,000")
        self.assertEqual(pipeline.fmt_srt_timestamp(6155.5), "01:42:35,500")
        self.assertEqual(pipeline.fmt_srt_timestamp(-1), "00:00:00,000")

    def test_merge_keeps_global_time_languages_and_separate_speaker_ids(self):
        parts = chunks.plan_audio_parts(12309)
        transcripts = [{"job_id": f"job-{i}", "languages": [language],
                        "segments": [{"start": 1, "end": 2, "speaker": 0, "text": "Speech"}]}
                       for i, language in enumerate(("en", "zh"))]
        merged = chunks.merge_part_transcripts(parts, transcripts, 12309)
        self.assertEqual(merged["languages"], ["en", "zh"])
        self.assertEqual(merged["segments"][1]["start"], 6155.5)
        self.assertNotEqual(merged["segments"][0]["speaker"], merged["segments"][1]["speaker"])
        self.assertEqual(merged["job_ids"], ["job-0", "job-1"])

    def test_silent_part_is_allowed_but_missing_or_all_silent_parts_are_rejected(self):
        parts = chunks.plan_audio_parts(12309)
        silence = {"job_id": "silent", "segments": [], "languages": []}
        speech = {"job_id": "speech", "segments": [{"start": 0, "end": 1, "text": "Hello"}]}
        self.assertEqual(len(chunks.merge_part_transcripts(parts, [silence, speech], 12309)["segments"]), 1)
        with self.assertRaises(RuntimeError):
            chunks.merge_part_transcripts(parts, [silence, silence], 12309)
        with self.assertRaises(ValueError):
            chunks.merge_part_transcripts(parts, [speech], 12309)

    def test_atomic_write_failure_preserves_existing_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache.json"
            chunks.write_json_atomic(path, {"old": True})
            with patch.object(Path, "replace", side_effect=OSError("write failed")):
                with self.assertRaises(OSError):
                    chunks.write_json_atomic(path, {"new": True})
            self.assertEqual(json.loads(path.read_text()), {"old": True})
            self.assertEqual(list(path.parent.iterdir()), [path])

    def test_stream_copy_failure_falls_back_to_aac_container(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            source = folder / "original.mp3"
            source.write_bytes(b"original")
            commands = []

            def run(arguments):
                commands.append(arguments)
                Path(arguments[-1]).write_bytes(b"generated")
                if "copy" in arguments:
                    raise RuntimeError("copy failed")
                return ""

            with patch.object(chunks, "run_media_tool", side_effect=run), \
                    patch.object(chunks, "probe_audio", return_value={"duration_seconds": 70}):
                path = chunks.prepare_audio_part(source, folder / "part.mp3",
                                                 {"offset_seconds": 0, "duration_seconds": 70}, "mp3", "ffmpeg", "ffprobe")
            self.assertEqual(path.suffix, ".m4a")
            self.assertEqual(source.read_bytes(), b"original")
            self.assertEqual(len(commands), 2)
            self.assertFalse(any("preparing" in child.name for child in folder.iterdir()))


class DesktopLongAudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.source = self.folder / "recording.m4a"
        self.source.write_bytes(b"original recording")
        self.config = pipeline.PipelineConfig(output_format="txt", translate=False, source_language="zh",
                                              jobs_root=self.folder / "jobs", poll_interval=0)
        self.events = []
        self.logs = []
        self.stages = []
        self.duration = 12309
        self.fail_job = None
        self.terminal_failure = False
        self.keys = ["test-key-1", "test-key-2"]
        self.submissions = 0
        for target, name, kwargs in (
            (pipeline.g, "load_keys", {"side_effect": lambda: self.keys}),
            (pipeline, "find_binary", {"return_value": "fake-media-tool"}),
            (pipeline, "probe_audio", {"side_effect": lambda *args: {"duration_seconds": self.duration, "codec": "aac"}}),
            (pipeline, "prepare_audio_part", {"side_effect": self.prepare}),
            (pipeline.g, "upload", {"side_effect": self.upload}),
            (pipeline.g, "transcribe", {"side_effect": self.submit}),
            (pipeline, "wait_for_gladia_result", {"side_effect": self.wait}),
            (pipeline.g, "test_key", {"side_effect": AssertionError("Never create a fake transcription to test keys")}),
        ):
            patcher = patch.object(target, name, **kwargs)
            mock = patcher.start()
            setattr(self, f"mock_{name}", mock)
            self.addCleanup(patcher.stop)

    def prepare(self, source, destination, part, *args):
        self.events.append(f"prepare-{part['index'] + 1}")
        destination.write_bytes(b"generated audio")
        return destination

    def upload(self, rotator, src):
        self.assertTrue(src.is_file())
        self.events.append("upload")
        return "uploaded-audio"

    def submit(self, *args, **kwargs):
        self.submissions += 1
        self.events.append(f"submit-{self.submissions}")
        return f"job-{self.submissions}"

    def wait(self, key, job_id, **kwargs):
        self.events.append(f"poll-{job_id}")
        if job_id == self.fail_job:
            if self.terminal_failure:
                raise pipeline.GladiaJobFailedError("terminal error")
            raise TimeoutError("Temporary polling timeout")
        return {"metadata": {"audio_duration": self.duration / 2},
                "transcription": {"languages": ["zh"], "utterances": [
                    {"start": 1, "end": 2, "speaker": 0, "text": f"Speech {job_id}", "language": "zh"}]}}

    def process(self):
        return pipeline.process_one(self.source, self.config, log=self.logs.append,
                                    stage_callback=lambda *args: self.stages.append(args))

    def job_dir(self):
        return self.config.jobs_root / f"{pipeline.stable_job_tag(self.source)}__zh"

    def chunks_in_cache(self):
        return list(self.job_dir().rglob("*.m4a"))

    def test_serial_processing_one_output_and_cleanup_after_success(self):
        result = self.process()
        self.assertEqual(self.events, ["prepare-1", "upload", "submit-1", "poll-job-1",
                                       "prepare-2", "upload", "submit-2", "poll-job-2"])
        self.assertEqual(result.output_path, self.source.with_suffix(".txt"))
        self.assertEqual(result.output_path.read_text(), "Speech job-1\nSpeech job-2")
        self.assertEqual(self.source.read_bytes(), b"original recording")
        self.assertEqual(self.chunks_in_cache(), [])
        self.assertTrue((result.job_dir / "audio_parts.json").is_file())
        self.assertTrue(all(stage[0] == self.source for stage in self.stages))
        self.assertTrue(any("Part 2/2" in stage[2] for stage in self.stages))

    def test_pending_second_part_resumes_without_resubmission_after_key_reorder(self):
        self.fail_job = "job-2"
        with self.assertRaises(TimeoutError):
            self.process()
        self.assertEqual(len(self.chunks_in_cache()), 2)
        self.assertFalse(self.source.with_suffix(".txt").exists())
        self.keys.reverse()
        self.fail_job = None
        self.config.output_format = "srt"
        result = self.process()
        self.assertEqual(self.submissions, 2)
        self.assertEqual(self.mock_upload.call_count, 2)
        self.assertEqual(self.mock_prepare_audio_part.call_count, 2)
        self.assertEqual(self.mock_wait_for_gladia_result.call_args.args[0], "test-key-1")
        self.assertIn("01:42:35,500 --> 01:42:36,500", result.output_path.read_text())
        self.assertEqual(self.chunks_in_cache(), [])
        checkpoint = (result.job_dir / "audio_parts/part_0002/gladia_request.json").read_text()
        self.assertNotIn("test-key", checkpoint)

    def test_terminal_failure_is_resubmitted_only_on_next_retry(self):
        self.fail_job = "job-2"
        self.terminal_failure = True
        with self.assertRaises(pipeline.GladiaJobFailedError):
            self.process()
        self.assertEqual(self.submissions, 2)
        self.assertEqual(len(self.chunks_in_cache()), 2)
        self.fail_job = None
        result = self.process()
        self.assertEqual(self.submissions, 3)
        self.assertEqual(result.output_path.read_text(), "Speech job-1\nSpeech job-3")
        self.assertEqual(self.chunks_in_cache(), [])

    def test_render_failure_retains_audio_and_retry_reuses_merged_transcript(self):
        with patch.object(pipeline, "render_output", side_effect=RuntimeError("render failed")):
            with self.assertRaisesRegex(RuntimeError, "render failed"):
                self.process()
        self.assertEqual(len(self.chunks_in_cache()), 2)
        self.assertTrue((self.job_dir() / "gladia_raw.json").is_file())
        self.mock_probe_audio.side_effect = AssertionError("Do not probe a completed transcript again")
        self.process()
        self.assertEqual(self.submissions, 2)
        self.assertEqual(self.chunks_in_cache(), [])

    def test_modified_original_does_not_use_stale_transcript(self):
        self.process()
        self.source.write_bytes(b"changed recording content")
        with self.assertRaisesRegex(RuntimeError, "source recording changed"):
            self.process()
        self.assertEqual(self.submissions, 2)
        self.assertEqual(self.source.read_bytes(), b"changed recording content")

    def test_short_audio_pending_job_is_also_resumed(self):
        self.duration = 140
        self.fail_job = "job-1"
        with self.assertRaises(TimeoutError):
            self.process()
        self.fail_job = None
        self.process()
        self.assertEqual(self.submissions, 1)
        self.mock_prepare_audio_part.assert_not_called()
        self.assertEqual(self.source.read_bytes(), b"original recording")

    def test_removed_submitting_key_does_not_create_another_paid_job(self):
        self.duration = 140
        self.fail_job = "job-1"
        with self.assertRaises(TimeoutError):
            self.process()
        self.keys = ["test-key-2"]
        with self.assertRaisesRegex(RuntimeError, "Restore the original Gladia key"):
            self.process()
        self.assertEqual(self.submissions, 1)

    def test_legacy_job_id_tries_keys_only_on_authorization_errors(self):
        self.duration = 140
        directory = self.job_dir()
        directory.mkdir(parents=True)
        (directory / "gladia_raw.job_id").write_text("legacy-job")
        success = self.wait("test-key-2", "legacy-job")
        self.mock_wait_for_gladia_result.side_effect = [
            urllib.error.HTTPError("https://example.invalid", 401, "Unauthorized", {}, None), success]
        self.process()
        self.assertEqual(self.submissions, 0)
        self.mock_upload.assert_not_called()
        request = json.loads((directory / "gladia_request.json").read_text())
        self.assertEqual(request["key_fingerprint"], pipeline._key_fingerprint("test-key-2"))

    def test_remote_key_rejection_rotates_before_retrying_upload(self):
        self.duration = 140
        self.mock_upload.side_effect = [pipeline.g.AudioUrlKeyMismatch("quota exceeded"), "uploaded-audio"]
        self.process()
        self.assertEqual(self.submissions, 1)
        self.assertEqual(self.mock_wait_for_gladia_result.call_args.args[0], "test-key-2")

    def test_video_cleanup_and_completed_retry_preserve_original_video(self):
        self.source = self.source.with_suffix(".mp4")
        self.source.write_bytes(b"original video")

        def extract(source, output, **kwargs):
            output.write_bytes(b"extracted audio")

        with patch.object(pipeline, "extract_audio_for_video", side_effect=extract) as mock:
            result = self.process()
            self.assertFalse(result.prepared_audio_path.exists())
            self.process()
            self.assertEqual(mock.call_count, 1)
        self.assertEqual(self.submissions, 2)
        self.assertEqual(self.source.read_bytes(), b"original video")
        self.assertTrue(all(stage[0] == self.source for stage in self.stages))


if __name__ == "__main__":
    unittest.main()
