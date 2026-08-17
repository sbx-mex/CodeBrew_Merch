#!/usr/bin/env python3
"""Construye todos los datos de forma coordinada y ejecuta la auditoría integral."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STAGE = ROOT / ".codebrew-build"
STATIC_ASSETS = (ROOT / "assets/catalog/catalog-hero.webp",)


def run(*arguments: str) -> None:
    subprocess.run([sys.executable, *arguments], cwd=ROOT, check=True)


def validate_stage() -> None:
    required = ("products.js", "woe.js", "import-report.json", "woe-pdf-config.js", "stock-config.js", "ui-config.js", "merch-catalog.js", "merch-catalog-report.json", "photo-coverage.json")
    missing = [name for name in required if not (STAGE / name).is_file()]
    if missing or not (STAGE / "images").is_dir() or not (STAGE / "featured").is_dir():
        raise RuntimeError(f"Construcción incompleta: {missing}")


def validate_static_assets() -> None:
    missing = [path.relative_to(ROOT).as_posix() for path in STATIC_ASSETS if not path.is_file()]
    if missing:
        raise RuntimeError(f"Recursos estáticos faltantes: {', '.join(missing)}")


def main() -> int:
    validate_static_assets()
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
            "scripts/generate_manual_catalog.py",
            "--engine-dir", "engines/merch-lists",
            "--output", str(STAGE / "merch-catalog.js"),
            "--report", str(STAGE / "merch-catalog-report.json"),
        )
        run(
            "scripts/integrate_uploaded_images.py",
            "--catalog", str(STAGE / "merch-catalog.js"),
            "--report", str(STAGE / "merch-catalog-report.json"),
            "--active-list", "data/merch-active-products.json",
            "--operational-products", str(STAGE / "products.js"),
            "--woe-catalog", str(STAGE / "woe.js"),
            "--source-dir", "assets/catalog/images",
            "--image-output", str(STAGE / "images"),
            "--coverage-output", str(STAGE / "photo-coverage.json"),
        )
        (STAGE / "featured").mkdir(exist_ok=True)
        validate_stage()
        data = ROOT / "data"
        data.mkdir(exist_ok=True)
        for name in ("products.js", "woe.js", "import-report.json", "woe-pdf-config.js", "stock-config.js", "ui-config.js", "merch-catalog.js", "merch-catalog-report.json", "photo-coverage.json"):
            (STAGE / name).replace(data / name)
        image_target = ROOT / "assets/catalog/images"
        if image_target.exists():
            shutil.rmtree(image_target)
        image_target.parent.mkdir(parents=True, exist_ok=True)
        (STAGE / "images").replace(image_target)
        obsolete_atlases = ROOT / "assets/catalog/atlases"
        if obsolete_atlases.exists():
            shutil.rmtree(obsolete_atlases)
        featured_target = ROOT / "assets/catalog/featured"
        if featured_target.exists():
            shutil.rmtree(featured_target)
        (STAGE / "featured").replace(featured_target)
        run(
            "scripts/export_photo_control.py",
            "--catalog", "data/merch-catalog.js",
            "--xlsx", "Control_Fotos_CodeBrew.xlsx",
            "--csv", "data/Listado_Codigo_Dia_Fotos.csv",
        )
        run("scripts/audit_project.py")
    finally:
        if STAGE.exists():
            shutil.rmtree(STAGE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
