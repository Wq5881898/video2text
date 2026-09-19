#!/usr/bin/env python3
"""Backward-compatible MiniMax entry point for the generic streaming translator."""

from __future__ import annotations

import sys
from pathlib import Path

import llm_translate


def load_config() -> dict[str, str]:
    return llm_translate.load_config("minimax")


def translate_segments(en_segments: list[dict], out_path: Path) -> list[dict]:
    return llm_translate.translate_segments(en_segments, out_path, "minimax")


def main(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        raise SystemExit("usage: minimax_translate.py <utt_clean.json> <gladia_zh.json>")
    llm_translate.main([args[0], args[1], "minimax"])


if __name__ == "__main__":
    main()
