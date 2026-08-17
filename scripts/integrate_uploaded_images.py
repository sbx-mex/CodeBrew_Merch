#!/usr/bin/env python3
"""Integra lotes manuales de fotos por SKU internacional, SKU POS o Código Día."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import unicodedata
from collections import defaultdict
from pathlib import Path

from PIL import Image


SUPPORTED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
MAX_FILE_BYTES = 25_000_000


def normalize_name(value: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def identifier(value: object) -> str:
    key = normalize_name(value)
    if not key or key in {"na", "none"}:
        return ""
    return key.lstrip("0") or "0" if key.isdigit() else key


def image_identifier(path: Path) -> str:
    stem = re.sub(r"_\d+$", "", path.stem)
    return identifier(stem)


def slug(value: object, limit: int = 52) -> str:
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9]+", "-", text.casefold()).strip("-")[:limit] or "articulo"


def category_for(value: object) -> str:
    key = normalize_name(value)
    if any(token in key for token in ("coldcup", "cldcup", "clcp", "ccup")):
        return "cold-cup"
    if any(token in key for token in ("waterbottle", "wtrbtl", "bottle", "wtbl")):
        return "bottle"
    if any(token in key for token in ("tumbler", "tmblr", "tumbl", "tumb")):
        return "tumbler"
    if any(token in key for token in ("mug", "taza", "cermc", "stnmug")):
        return "mug"
    if any(token in key for token in ("bag", "tote", "keyring", "iman", "magnet")):
        return "accessory"
    return "other"


def load_catalog(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    return json.loads(text.split("=", 1)[1].strip().rstrip(";"))


def load_operational_products(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    raw = text.split("window.PRODUCTS = ", 1)[1].split(";\nwindow.PRODUCT_META", 1)[0]
    return json.loads(raw)


def load_active_names(path: Path) -> set[str]:
    if not path.is_file():
        return set()
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {normalize_name(value) for value in payload.get("activeNames", []) if normalize_name(value)}


def product_is_active(product: dict, active_names: set[str]) -> bool:
    return any(
        normalize_name(product.get(field, "")) in active_names
        for field in ("nombreInventario", "nombrePos", "displayName")
        if product.get(field)
    )


def image_dimensions(path: Path) -> tuple[int, int]:
    if path.stat().st_size >= MAX_FILE_BYTES:
        raise ValueError(f"Imagen mayor a 25 MB: {path}")
    with Image.open(path) as image:
        image.verify()
        return image.width, image.height


def discover_images(source_dir: Path) -> tuple[list[Path], list[dict]]:
    lots = sorted(path for path in source_dir.iterdir() if path.is_dir())
    expected = [f"lote-{number:02d}" for number in range(1, 5)]
    if [lot.name for lot in lots] != expected:
        raise ValueError(f"Se requieren exactamente estas 4 carpetas: {', '.join(expected)}")
    images: list[Path] = []
    lot_report: list[dict] = []
    seen_keys: dict[str, Path] = {}
    seen_hashes: dict[str, Path] = {}
    for lot in lots:
        lot_images = sorted(path for path in lot.iterdir() if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES)
        if not 0 < len(lot_images) < 100:
            raise ValueError(f"{lot.name}: debe contener entre 1 y 99 imágenes")
        for image in lot_images:
            key = normalize_name(re.sub(r"_\d+$", "", image.stem))
            if key in seen_keys:
                raise ValueError(f"Foto duplicada por nombre: {seen_keys[key]} y {image}")
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            if digest in seen_hashes:
                raise ValueError(f"Foto duplicada por contenido: {seen_hashes[digest]} y {image}")
            seen_keys[key] = image
            seen_hashes[digest] = image
        images.extend(lot_images)
        lot_report.append({"folder": lot.name, "images": len(lot_images)})
    return images, lot_report


def build_indices(products: list[dict]) -> dict[str, dict[str, list[dict]]]:
    fields = ("skuIntl", "codigoDia", "skuPos", "displayName", "nombreInventario", "nombrePos")
    indices = {field: defaultdict(list) for field in fields}
    for product in products:
        for field in fields:
            key = identifier(product.get(field)) if field in {"skuIntl", "codigoDia", "skuPos"} else normalize_name(product.get(field))
            if key:
                indices[field][key].append(product)
    return indices


def add_operational_products(products: list[dict], operational_path: Path, image_keys: set[str], image_name_keys: set[str]) -> int:
    indices = build_indices(products)
    existing_article_keys = {product.get("articleKey") for product in products}
    added = 0
    for row in load_operational_products(operational_path):
        matching_fields = [field for field in ("skuIntl", "codigoDia", "skuPos") if identifier(row.get(field)) in image_keys]
        matching_fields.extend(field for field in ("nombreInventario", "nombrePos", "displayName") if normalize_name(row.get(field)) in image_name_keys)
        if not matching_fields:
            continue
        if any(indices[field].get(identifier(row.get(field)) if field in {"skuIntl", "codigoDia", "skuPos"} else normalize_name(row.get(field))) for field in matching_fields):
            continue
        display_name = row.get("nombreInventario") or row.get("nombrePos") or row.get("descripcion") or "Artículo"
        codigo = str(row.get("codigoDia") or "").strip()
        sku_pos = str(row.get("skuPos") or "").strip()
        article_key = f"dia-{slug(codigo, 18)}--pos-{slug(sku_pos or display_name, 24)}"
        if article_key in existing_article_keys:
            continue
        product = {
            "articleKey": article_key,
            "nameKey": slug(display_name),
            "codigoDia": codigo,
            "skuPos": sku_pos,
            "skuIntl": str(row.get("skuIntl") or "").strip(),
            "descripcionSci": str(row.get("descripcion") or "").strip(),
            "nombrePos": str(row.get("nombrePos") or "").strip(),
            "nombreInventario": str(row.get("nombreInventario") or "").strip(),
            "displayName": display_name,
            "category": category_for(f"{row.get('descripcion', '')} {display_name}"),
            "section": str(row.get("base") or row.get("sourceSheet") or "Lista de Precios Base"),
            "source": "Lista de Precios Base",
            "sourceFile": "Lista_Precios_Base.xlsx",
            "sourceRow": row.get("sourceRow"),
        }
        products.append(product)
        existing_article_keys.add(article_key)
        for field in ("skuIntl", "codigoDia", "skuPos", "displayName", "nombreInventario", "nombrePos"):
            key = identifier(product.get(field)) if field in {"skuIntl", "codigoDia", "skuPos"} else normalize_name(product.get(field))
            if key:
                indices[field][key].append(product)
        added += 1
    return added


def integrate(
    catalog_path: Path,
    report_path: Path,
    active_list: Path,
    operational_products: Path,
    source_dir: Path,
    image_output: Path,
    coverage_output: Path,
) -> dict:
    payload = load_catalog(catalog_path)
    products = payload.get("products", [])
    active_names = load_active_names(active_list)
    images, lots = discover_images(source_dir)
    appended_products = add_operational_products(
        products,
        operational_products,
        {image_identifier(path) for path in images},
        {normalize_name(re.sub(r"_\d+$", "", path.stem)) for path in images},
    )
    indices = build_indices(products)

    for product in products:
        active = product_is_active(product, active_names) if active_names else product.get("stockPriority") == "active"
        product["stockPriority"] = "active" if active else "secondary"
        product["visualSource"] = "pending-upload"
        product["visual"] = None
        product["imageNote"] = "Foto pendiente de carga."
        product.pop("photoMatch", None)
        product.pop("photoFile", None)

    if image_output.exists():
        shutil.rmtree(image_output)
    image_output.mkdir(parents=True)

    file_rows: list[dict] = []
    matched_files = 0
    matched_products: set[str] = set()
    assigned_files: dict[str, Path] = {}
    for source in images:
        key = image_identifier(source)
        name_key = normalize_name(re.sub(r"_\d+$", "", source.stem))
        match_field = ""
        matches: list[dict] = []
        for field in ("skuIntl", "codigoDia", "skuPos"):
            if key and indices[field].get(key):
                match_field = field
                matches = indices[field][key]
                break
        if not matches:
            for field in ("displayName", "nombreInventario", "nombrePos"):
                candidates = indices[field].get(name_key, [])
                article_keys = {candidate.get("articleKey") for candidate in candidates}
                if len(article_keys) == 1:
                    match_field = field
                    matches = candidates
                    break

        for product in matches:
            article_key = product.get("articleKey")
            previous = assigned_files.get(article_key)
            if previous and previous != source:
                raise ValueError(f"El artículo {article_key} tiene más de una foto: {previous} y {source}")
            assigned_files[article_key] = source

        relative = source.relative_to(source_dir)
        destination = image_output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        width, height = image_dimensions(destination)
        published = (Path("assets/catalog/images") / relative).as_posix()

        if matches:
            matched_files += 1
        for product in matches:
            product["visualSource"] = "manual-upload"
            product["visual"] = {
                "type": "direct",
                "src": published,
                "kind": "uploaded",
                "width": width,
                "height": height,
            }
            product["imageNote"] = f"Fotografía integrada y relacionada por {match_field}."
            product["photoMatch"] = match_field
            product["photoFile"] = relative.as_posix()
            matched_products.add(product["articleKey"])

        file_rows.append({
            "file": relative.as_posix(),
            "identifier": key,
            "status": "matched" if matches else "unmatched",
            "matchedBy": match_field or None,
            "products": [{
                "articleKey": product.get("articleKey"),
                "codigoDia": product.get("codigoDia"),
                "skuIntl": product.get("skuIntl"),
                "skuPos": product.get("skuPos"),
                "displayName": product.get("displayName"),
                "stockPriority": product.get("stockPriority"),
            } for product in matches],
        })

    products.sort(key=lambda product: (
        product.get("stockPriority") != "active",
        product.get("visual") is None,
        int(product.get("codigoDia")) if str(product.get("codigoDia", "")).isdigit() else 999999,
        str(product.get("displayName", "")).casefold(),
    ))
    active_count = sum(product.get("stockPriority") == "active" for product in products)
    active_with_photo = sum(product.get("stockPriority") == "active" and bool(product.get("visual")) for product in products)
    with_photo = sum(bool(product.get("visual")) for product in products)
    totals = {
        "imageFiles": len(images),
        "matchedImageFiles": matched_files,
        "unmatchedImageFiles": len(images) - matched_files,
        "matchedProducts": with_photo,
        "activeProducts": active_count,
        "activeWithPhoto": active_with_photo,
        "activeMissingPhoto": active_count - active_with_photo,
        "secondaryProducts": len(products) - active_count,
        "appendedOperationalProducts": appended_products,
    }
    meta = payload.setdefault("meta", {})
    meta.update({
        "imageMode": "manual-upload",
        "withSourceImage": with_photo,
        "withApproximation": 0,
        "featuredImages": 0,
        "restoredImageFiles": len(images),
        "publishedImageFiles": len(images),
        "matchedImageFiles": matched_files,
        "unmatchedImageFiles": len(images) - matched_files,
        "activeStockProducts": active_count,
        "activeWithPhoto": active_with_photo,
        "activeMissingPhoto": active_count - active_with_photo,
        "secondaryProducts": len(products) - active_count,
        "manualImageLots": lots,
        "products": len(products),
    })
    payload["products"] = products
    catalog_path.write_text(
        "window.MERCH_VISUAL_CATALOG=" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )

    report = json.loads(report_path.read_text(encoding="utf-8"))
    report.update(meta)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    coverage = {
        "status": "ok",
        "version": "manual-upload-v2",
        "source": "assets/catalog/images/lote-01..04",
        "matchOrder": ["skuIntl", "codigoDia", "skuPos", "displayName", "nombreInventario", "nombrePos"],
        "duplicateProtection": "one-photo-per-article",
        "lots": lots,
        "totals": totals,
        "files": file_rows,
    }
    coverage_output.parent.mkdir(parents=True, exist_ok=True)
    coverage_output.write_text(json.dumps(coverage, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return coverage


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, default=Path("data/merch-catalog.js"))
    parser.add_argument("--report", type=Path, default=Path("data/merch-catalog-report.json"))
    parser.add_argument("--active-list", type=Path, default=Path("data/merch-active-products.json"))
    parser.add_argument("--operational-products", type=Path, default=Path("data/products.js"))
    parser.add_argument("--source-dir", type=Path, default=Path("assets/catalog/images"))
    parser.add_argument("--image-output", type=Path, default=Path(".codebrew-build/images"))
    parser.add_argument("--coverage-output", type=Path, default=Path("data/photo-coverage.json"))
    args = parser.parse_args()
    result = integrate(args.catalog, args.report, args.active_list, args.operational_products, args.source_dir, args.image_output, args.coverage_output)
    print(json.dumps(result["totals"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
