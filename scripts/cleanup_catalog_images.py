#!/usr/bin/env python3
"""Limpia imágenes publicadas del catálogo y prioriza artículos con stock nacional activo."""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "data/merch-catalog.js"
DEFAULT_ACTIVE_LIST = ROOT / "data/merch-active-products.json"
IMAGE_DIRS = (ROOT / "assets/catalog/images", ROOT / "assets/catalog/featured")


def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def active_names_from_csv(path: Path) -> set[str]:
    active: set[str] = set()
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            raw = str(row.get("Inventario Final (#)", "0")).replace(",", "").strip()
            try:
                quantity = float(raw or 0)
            except ValueError:
                quantity = 0
            if quantity > 0:
                key = normalize(row.get("Ingrediente", ""))
                if key:
                    active.add(key)
    return active


def active_names_from_json(path: Path) -> set[str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {normalize(value) for value in payload.get("activeNames", []) if normalize(value)}


def load_catalog() -> dict:
    text = CATALOG.read_text(encoding="utf-8")
    return json.loads(text.split("=", 1)[1].strip().rstrip(";"))


def product_is_active(product: dict, active_names: set[str]) -> bool:
    return any(
        normalize(product.get(field, "")) in active_names
        for field in ("nombreInventario", "nombrePos", "displayName")
        if product.get(field)
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stock-csv", type=Path, help="CSV nacional usado solo para marcar prioridad activa")
    parser.add_argument("--active-list", type=Path, default=DEFAULT_ACTIVE_LIST, help="JSON derivado del CSV con nombres activos")
    parser.add_argument("--apply", action="store_true", help="Aplica la limpieza; sin esta bandera solo informa")
    args = parser.parse_args()

    payload = load_catalog()
    products = payload.get("products", [])
    active_names = active_names_from_csv(args.stock_csv) if args.stock_csv and args.stock_csv.is_file() else (active_names_from_json(args.active_list) if args.active_list and args.active_list.is_file() else set())

    active_count = 0
    for product in products:
        is_active = product_is_active(product, active_names) if active_names else bool(product.get("stockPriority") == "active")
        product["stockPriority"] = "active" if is_active else "secondary"
        product["visual"] = None
        product["visualSource"] = "pending-upload"
        product["imageNote"] = "Foto pendiente de carga."
        if is_active:
            active_count += 1

    products.sort(key=lambda p: (
        p.get("stockPriority") != "active",
        int(p.get("codigoDia")) if str(p.get("codigoDia", "")).isdigit() else 999999,
        str(p.get("displayName", "")).casefold(),
    ))

    meta = payload.setdefault("meta", {})
    meta.update({
        "imageMode": "clean-reset",
        "featuredImages": 0,
        "restoredImageFiles": 0,
        "withSourceImage": 0,
        "withApproximation": 0,
        "activeStockProducts": active_count,
        "secondaryProducts": max(0, len(products) - active_count),
    })
    payload["products"] = products

    image_files = sum(1 for directory in IMAGE_DIRS if directory.exists() for path in directory.rglob("*") if path.is_file())
    print(json.dumps({"products": len(products), "active": active_count, "imagesToDelete": image_files}, ensure_ascii=False))

    if not args.apply:
        return 0

    for directory in IMAGE_DIRS:
        if directory.exists():
            shutil.rmtree(directory)

    CATALOG.write_text(
        "window.MERCH_VISUAL_CATALOG=" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    report = ROOT / "data/merch-catalog-report.json"
    if report.exists():
        report_payload = json.loads(report.read_text(encoding="utf-8"))
        report_payload.update({
            "imageMode": "clean-reset",
            "featuredImages": 0,
            "restoredImageFiles": 0,
            "withSourceImage": 0,
            "withApproximation": 0,
            "activeStockProducts": active_count,
            "secondaryProducts": max(0, len(products) - active_count),
        })
        report.write_text(json.dumps(report_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
