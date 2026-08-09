#!/usr/bin/env python3
"""Audita y elimina sólo archivos obsoletos permitidos y no referenciados."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ALLOWLIST = (Path("products.js"), Path("icon-512.png"))
TEXT_SUFFIXES = {".html", ".js", ".css", ".json", ".webmanifest", ".md", ".yml", ".yaml", ".py"}
SKIP_PARTS = {".git", "__pycache__"}


def references(root: Path, candidate: Path) -> list[str]:
    # Evita falsos positivos: "products.js" no equivale a "data/products.js".
    escaped = re.escape(candidate.as_posix())
    pattern = re.compile(rf"(?<![A-Za-z0-9_./-])(?:\./)?{escaped}(?![A-Za-z0-9_./-])")
    found = []
    for path in root.rglob("*"):
        if not path.is_file() or path == root / candidate or path.name == "cleanup_obsolete.py" or "cleanup" in path.stem or any(part in SKIP_PARTS for part in path.parts):
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if pattern.search(text):
            found.append(path.relative_to(root).as_posix())
    return sorted(found)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--report", type=Path, default=Path("cleanup-report.json"))
    args = parser.parse_args()
    root = Path.cwd()
    report = {"mode": "apply" if args.apply else "audit", "deleted": [], "safeCandidates": [], "protected": [], "missing": []}
    for candidate in ALLOWLIST:
        path = root / candidate
        if not path.exists():
            report["missing"].append(candidate.as_posix())
            continue
        refs = references(root, candidate)
        if refs:
            report["protected"].append({"file": candidate.as_posix(), "references": refs})
            continue
        report["safeCandidates"].append(candidate.as_posix())
        if args.apply:
            path.unlink()
            report["deleted"].append(candidate.as_posix())
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
