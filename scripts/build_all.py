#!/usr/bin/env python3
"""Construye todos los datos de forma coordinada y ejecuta diez controles."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STAGE = ROOT / ".codebrew-build"


def run(*arguments: str) -> None:
    subprocess.run([sys.executable, *arguments], cwd=ROOT, check=True)


def main() -> int:
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)
    try:
        run(
            "scripts/generate_products.py",
            "--excel", "Lista_Precios_Base.xlsx",
            "--output", str(STAGE / "products.js"),
            "--woe-output", str(STAGE / "woe.js"),
            "--report", str(STAGE / "import-report.json"),
        )
        run(
            "scripts/build_woe_pdf_config.py",
            "--report", str(STAGE / "import-report.json"),
            "--output", str(STAGE / "woe-pdf-config.js"),
        )
        data = ROOT / "data"
        data.mkdir(exist_ok=True)
        for name in ("products.js", "woe.js", "import-report.json", "woe-pdf-config.js"):
            (STAGE / name).replace(data / name)
        run("scripts/audit_project.py")
    finally:
        if STAGE.exists():
            shutil.rmtree(STAGE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
