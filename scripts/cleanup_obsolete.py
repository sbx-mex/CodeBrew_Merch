#!/usr/bin/env python3
"""Audita y elimina sólo archivos obsoletos permitidos y no referenciados."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

ALLOWLIST = (
    Path("products.js"),
    Path("icon-512.png"),
    Path("VALIDACION_CORRECCION.md"),
    Path("ELIMINAR_OBSOLETOS.txt"),
    Path("AUDITORIA_HTML_SAP.json"),
    Path("scripts/generate_visual_catalog.py"),
    Path("scripts/cleanup_catalog_images.py"),
    Path(".github/workflows/cleanup-catalog-images.yml"),
    Path("engines/image-overrides/16999.png"),
)
TEXT_SUFFIXES = {".html", ".js", ".css", ".json", ".webmanifest", ".md", ".yml", ".yaml", ".py"}
SKIP_PARTS = {".git", "__pycache__"}
METADATA_FILES = {
    "data/app-audit.js",
    "data/app-audit.json",
    "scripts/audit_project.py",
    "scripts/build_all.py",
}


def references(root: Path, candidate: Path) -> list[str]:
    # Evita falsos positivos: "products.js" no equivale a "data/products.js".
    escaped = re.escape(candidate.as_posix())
    pattern = re.compile(rf"(?<![A-Za-z0-9_./-])(?:\./)?{escaped}(?![A-Za-z0-9_./-])")
    found = []
    for path in root.rglob("*"):
        relative = path.relative_to(root).as_posix()
        if not path.is_file() or path == root / candidate or relative in METADATA_FILES or path.name == "cleanup_obsolete.py" or "cleanup" in path.stem or any(part in SKIP_PARTS for part in path.parts):
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


def fingerprint(path: Path) -> dict:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}


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
        metadata = fingerprint(path)
        if refs:
            report["protected"].append({"file": candidate.as_posix(), "references": refs, **metadata})
            continue
        report["safeCandidates"].append({"file": candidate.as_posix(), **metadata})
        if args.apply:
            path.unlink()
            report["deleted"].append(candidate.as_posix())
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
