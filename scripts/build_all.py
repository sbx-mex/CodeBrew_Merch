#!/usr/bin/env python3
"""Construye todos los datos de forma coordinada y ejecuta la auditoría integral."""

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
        run(
            "scripts/build_stock_config.py",
            "--report", str(STAGE / "import-report.json"),
            "--output", str(STAGE / "stock-config.js"),
        )
        run(
            "scripts/build_ui_config.py",
            "--report", str(STAGE / "import-report.json"),
            "--output", str(STAGE / "ui-config.js"),
        )
        run(
            "scripts/generate_visual_catalog.py",
            "--engine-dir", "engines/merch-lists",
            "--output", str(STAGE / "merch-catalog.js"),
            "--report", str(STAGE / "merch-catalog-report.json"),
            "--atlas-output", str(STAGE / "atlases"),
            "--featured-output", str(STAGE / "featured"),
        )
        data = ROOT / "data"
        data.mkdir(exist_ok=True)
        for name in ("products.js", "woe.js", "import-report.json", "woe-pdf-config.js", "stock-config.js", "ui-config.js", "merch-catalog.js", "merch-catalog-report.json"):
            (STAGE / name).replace(data / name)
        atlas_target = ROOT / "assets/catalog/atlases"
        if atlas_target.exists():
            shutil.rmtree(atlas_target)
        atlas_target.parent.mkdir(parents=True, exist_ok=True)
        (STAGE / "atlases").replace(atlas_target)
        featured_target = ROOT / "assets/catalog/featured"
        if featured_target.exists():
            shutil.rmtree(featured_target)
        (STAGE / "featured").replace(featured_target)
        run("scripts/audit_project.py")
    finally:
        if STAGE.exists():
            shutil.rmtree(STAGE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
