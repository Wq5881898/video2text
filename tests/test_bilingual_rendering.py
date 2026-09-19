from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from packages.shared_core.media_pipeline import render_srt_bilingual, render_txt_bilingual


class BilingualRenderingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.en = [
            {"start": 0.0, "end": 2.0, "text": "First sentence."},
            {"start": 2.0, "end": 4.0, "text": "Second sentence."},
            {"start": 4.0, "end": 6.0, "text": "Third sentence."},
        ]
        self.zh = [
            {"start": en["start"], "end": en["end"], "source_text": en["text"], "text": text}
            for en, text in zip(self.en, ["第一句。", "第二句。", "第三句。"])
        ]

    def test_srt_keeps_one_to_one_pairs_at_touching_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.srt"
            render_srt_bilingual(self.en, self.zh, path)
            content = path.read_text(encoding="utf-8")
        self.assertEqual(content.count(" --> "), 3)
        self.assertIn("00:00:00,000 --> 00:00:02,000\n第一句。\nFirst sentence.", content)
        self.assertIn("00:00:02,000 --> 00:00:04,000\n第二句。\nSecond sentence.", content)
        self.assertIn("00:00:04,000 --> 00:00:06,000\n第三句。\nThird sentence.", content)

    def test_txt_keeps_one_to_one_pairs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.txt"
            render_txt_bilingual(self.en, self.zh, path)
            content = path.read_text(encoding="utf-8")
        self.assertEqual(
            content,
            "第一句。\nFirst sentence.\n\n第二句。\nSecond sentence.\n\n第三句。\nThird sentence.\n",
        )

    def test_mismatched_source_is_rejected(self) -> None:
        wrong = [dict(item) for item in self.zh]
        wrong[1]["source_text"] = "Wrong source."
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "source text differs"):
                render_srt_bilingual(self.en, wrong, Path(directory) / "result.srt")


if __name__ == "__main__":
    unittest.main()
