#!/usr/bin/env python3
"""Unified product CLI shell over the reusable core pipeline."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from core import PipelineConfig, expand_inputs, process_many


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Unified media -> txt/srt pipeline")
    parser.add_argument("inputs", nargs="+", help="media files or folders")
    parser.add_argument("--format", choices=("txt", "srt"), required=True, help="output format")
    parser.add_argument("--translate", action="store_true", help="translate English transcript to Chinese")
    parser.add_argument("--output-dir", type=Path, default=None, help="directory for final outputs")
    args = parser.parse_args(argv)

    paths = expand_inputs(args.inputs)
    if not paths:
        raise SystemExit("no supported media files found")

    config = PipelineConfig(
        output_format=args.format,
        translate=args.translate,
        output_dir=args.output_dir,
    )
    _results, failures = process_many(paths, config)
    if failures:
        print("\n=== Failures ===", flush=True)
        for source_path, exc in failures:
            print(f"- {source_path}: {exc}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
