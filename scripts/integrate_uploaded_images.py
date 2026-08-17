#!/usr/bin/env python3
"""Integra y ordena fotos manuales exclusivamente por Código Día o SKU internacional."""

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
MAX_IMAGES_PER_LOT = 100
LOT_NAMES = tuple(f"lote-{number:02d}" for number in range(1, 5))


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


def load_woe_catalog(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    raw = text.split("window.WOE_CATALOG = ", 1)[1].split(";\nwindow.WOE_META", 1)[0]
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
    source_dir.mkdir(parents=True, exist_ok=True)
    lots = [source_dir / name for name in LOT_NAMES]
    for lot in lots:
        lot.mkdir(exist_ok=True)
    images: list[Path] = []
    lot_report: list[dict] = []
    seen_keys: dict[str, Path] = {}
    seen_hashes: dict[str, Path] = {}
    for lot in lots:
        lot_images = sorted(path for path in lot.iterdir() if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES)
        if len(lot_images) > MAX_IMAGES_PER_LOT:
            raise ValueError(f"{lot.name}: admite como máximo {MAX_IMAGES_PER_LOT} imágenes")
        ignored: list[dict] = []
        for image in lot_images:
            key = normalize_name(re.sub(r"_\d+$", "", image.stem))
            if key in seen_keys:
                ignored.append({"file": image.name, "reason": "duplicate-name", "kept": seen_keys[key].relative_to(source_dir).as_posix()})
                continue
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            if digest in seen_hashes:
                ignored.append({"file": image.name, "reason": "duplicate-content", "kept": seen_hashes[digest].relative_to(source_dir).as_posix()})
                continue
            seen_keys[key] = image
            seen_hashes[digest] = image
            images.append(image)
        lot_report.append({"folder": lot.name, "images": len(lot_images), "accepted": len(lot_images) - len(ignored), "duplicatesIgnored": len(ignored), "ignoredFiles": ignored})
    return images, lot_report


def validate_published_lots(image_dir: Path) -> dict:
    lots = sorted(path for path in image_dir.iterdir() if path.is_dir())
    if [lot.name for lot in lots] != list(LOT_NAMES):
        raise ValueError(f"Publicación incompleta: se requieren {', '.join(LOT_NAMES)}")
    seen_keys: set[str] = set()
    seen_hashes: set[str] = set()
    total = 0
    for lot in lots:
        images = sorted(path for path in lot.iterdir() if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES)
        if len(images) > MAX_IMAGES_PER_LOT:
            raise ValueError(f"{lot.name}: publicación mayor a {MAX_IMAGES_PER_LOT} imágenes")
        for image in images:
            key = normalize_name(re.sub(r"_\d+$", "", image.stem))
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            if key in seen_keys or digest in seen_hashes:
                raise ValueError(f"Duplicado detectado después de publicar: {image.relative_to(image_dir)}")
            seen_keys.add(key)
            seen_hashes.add(digest)
        total += len(images)
    return {"status": "ok", "folders": len(lots), "images": total, "duplicates": 0}


def build_indices(products: list[dict]) -> dict[str, dict[str, list[dict]]]:
    fields = ("codigoDia", "skuIntl")
    indices = {field: defaultdict(list) for field in fields}
    for product in products:
        for field in fields:
            key = identifier(product.get(field))
            if key:
                indices[field][key].append(product)
    return indices


def add_operational_products(products: list[dict], operational_path: Path, image_keys: set[str]) -> int:
    indices = build_indices(products)
    existing_article_keys = {product.get("articleKey") for product in products}
    added = 0
    for row in load_operational_products(operational_path):
        matching_fields = [field for field in ("codigoDia", "skuIntl") if identifier(row.get(field)) in image_keys]
        if not matching_fields:
            continue
        if any(indices[field].get(identifier(row.get(field))) for field in matching_fields):
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
        for field in ("codigoDia", "skuIntl"):
            key = identifier(product.get(field))
            if key:
                indices[field][key].append(product)
        added += 1
    return added


def add_woe_merch_products(products: list[dict], woe_catalog_path: Path) -> int:
    """Añade Merch confirmado por SAP + Micros aunque todavía no tenga fotografía."""
    indices = build_indices(products)
    existing_article_keys = {product.get("articleKey") for product in products}
    added = 0
    for row in load_woe_catalog(woe_catalog_path):
        category = str(row.get("merchCategory") or "").strip()
        codigo = str(row.get("codigoDia") or "").strip()
        day_key = identifier(codigo)
        if not category or not day_key or indices["codigoDia"].get(day_key):
            continue
        display_name = next((clean for clean in (
            str((row.get("micros") or [""])[0]).strip(),
            str(row.get("descripcionSap") or "").strip(),
        ) if clean), "Artículo Merch")
        woe_id = str(row.get("idWoe") or "").strip()
        article_key = f"dia-{slug(codigo, 18)}--pos-sap-{slug(woe_id or display_name, 20)}"
        if article_key in existing_article_keys:
            continue
        product = {
            "articleKey": article_key,
            "nameKey": slug(display_name),
            "codigoDia": codigo,
            "skuPos": "",
            "skuIntl": "",
            "descripcionSci": str(row.get("descripcionSap") or "").strip(),
            "nombrePos": display_name,
            "nombreInventario": display_name,
            "displayName": display_name,
            "category": category,
            "section": "Cruce SAP + Micros",
            "source": "Cruce SAP + Micros",
            "sourceFile": "Lista_Precios_Base.xlsx",
            "sourceRow": row.get("sourceRow"),
        }
        products.append(product)
        existing_article_keys.add(article_key)
        indices["codigoDia"][day_key].append(product)
        added += 1
    return added


def integrate(
    catalog_path: Path,
    report_path: Path,
    active_list: Path,
    operational_products: Path,
    woe_catalog: Path,
    source_dir: Path,
    image_output: Path,
    coverage_output: Path,
) -> dict:
    payload = load_catalog(catalog_path)
    products = payload.get("products", [])
    active_names = load_active_names(active_list)
    images, lots = discover_images(source_dir)
    appended_woe_products = add_woe_merch_products(products, woe_catalog)
    appended_products = add_operational_products(products, operational_products, {image_identifier(path) for path in images})
    indices = build_indices(products)

    for product in products:
        active = product_is_active(product, active_names) if active_names else product.get("stockPriority") == "active"
        day_key = identifier(product.get("codigoDia"))
        product["stockPriority"] = "active" if active else "secondary"
        product["photoUploadName"] = f"{day_key}.jpg" if day_key else ""
        product["visualSource"] = "pending-upload"
        product["visual"] = None
        product["imageNote"] = "Foto pendiente de carga."
        product.pop("photoMatch", None)
        product.pop("photoFile", None)

    if image_output.exists():
        shutil.rmtree(image_output)
    image_output.mkdir(parents=True)
    output_lots = [image_output / name for name in LOT_NAMES]
    for lot in output_lots:
        lot.mkdir()

    file_rows: list[dict] = []
    matched_files = 0
    matched_products: set[str] = set()
    assigned_files: dict[str, Path] = {}
    used_output_lots: set[str] = set()
    published_files = 0
    duplicate_article_files = 0
    for source in images:
        key = image_identifier(source)
        match_field = ""
        matches: list[dict] = []
        for field in ("codigoDia", "skuIntl"):
            if key and indices[field].get(key):
                match_field = field
                matches = indices[field][key]
                break

        previous_files = {assigned_files[product.get("articleKey")] for product in matches if product.get("articleKey") in assigned_files}
        if previous_files:
            duplicate_article_files += 1
            file_rows.append({
                "file": None,
                "uploadedFrom": source.relative_to(source_dir).as_posix(),
                "identifier": key,
                "status": "ignored-duplicate-article",
                "matchedBy": match_field or None,
                "kept": sorted(path.relative_to(source_dir).as_posix() for path in previous_files),
                "products": [],
            })
            continue
        for product in matches:
            assigned_files[product.get("articleKey")] = source

        target_lot = LOT_NAMES[published_files // MAX_IMAGES_PER_LOT]
        relative = Path(target_lot) / source.name
        used_output_lots.add(target_lot)
        destination = image_output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        width, height = image_dimensions(destination)
        published_files += 1
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
            "uploadedFrom": source.relative_to(source_dir).as_posix(),
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

    for lot in output_lots:
        if lot.name not in used_output_lots:
            (lot / ".gitkeep").write_text("", encoding="utf-8")

    post_publish_audit = validate_published_lots(image_output)

    products.sort(key=lambda product: (
        product.get("visual") is None,
        product.get("stockPriority") != "active",
        int(product.get("codigoDia")) if str(product.get("codigoDia", "")).isdigit() else 999999,
        str(product.get("displayName", "")).casefold(),
    ))
    active_count = sum(product.get("stockPriority") == "active" for product in products)
    active_with_photo = sum(product.get("stockPriority") == "active" and bool(product.get("visual")) for product in products)
    with_photo = sum(bool(product.get("visual")) for product in products)
    uploaded_image_files = sum(lot["images"] for lot in lots)
    duplicate_name_or_content = sum(lot["duplicatesIgnored"] for lot in lots)
    unmatched_files = sum(row.get("status") == "unmatched" for row in file_rows)
    totals = {
        "imageFiles": uploaded_image_files,
        "publishedImageFiles": published_files,
        "matchedImageFiles": matched_files,
        "unmatchedImageFiles": unmatched_files,
        "duplicateImageFilesIgnored": duplicate_name_or_content + duplicate_article_files,
        "matchedProducts": with_photo,
        "activeProducts": active_count,
        "activeWithPhoto": active_with_photo,
        "activeMissingPhoto": active_count - active_with_photo,
        "secondaryProducts": len(products) - active_count,
        "appendedOperationalProducts": appended_products,
        "appendedWoeProducts": appended_woe_products,
    }
    meta = payload.setdefault("meta", {})
    meta.update({
        "imageMode": "manual-upload",
        "withSourceImage": with_photo,
        "withApproximation": 0,
        "featuredImages": 0,
        "restoredImageFiles": published_files,
        "publishedImageFiles": published_files,
        "matchedImageFiles": matched_files,
        "unmatchedImageFiles": unmatched_files,
        "activeStockProducts": active_count,
        "activeWithPhoto": active_with_photo,
        "activeMissingPhoto": active_count - active_with_photo,
        "secondaryProducts": len(products) - active_count,
        "manualImageLots": lots,
        "products": len(products),
        "appendedWoeProducts": appended_woe_products,
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
        "version": "manual-upload-v7",
        "source": "assets/catalog/images/lote-01..04",
        "matchOrder": ["codigoDia", "skuIntl"],
        "duplicateProtection": "one-photo-per-article",
        "duplicatePolicy": "keep-first-lot-ignore-later",
        "packing": "fill-lote-01-first-then-02-03-04",
        "crossCheck": ["SAP", "Catalogo Micros", "Base_Campaña", "Discovery", "Homologados", "Essentials"],
        "postPublishAudit": post_publish_audit,
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
    parser.add_argument("--woe-catalog", type=Path, default=Path("data/woe.js"))
    parser.add_argument("--source-dir", type=Path, default=Path("assets/catalog/images"))
    parser.add_argument("--image-output", type=Path, default=Path(".codebrew-build/images"))
    parser.add_argument("--coverage-output", type=Path, default=Path("data/photo-coverage.json"))
    args = parser.parse_args()
    result = integrate(args.catalog, args.report, args.active_list, args.operational_products, args.woe_catalog, args.source_dir, args.image_output, args.coverage_output)
    print(json.dumps(result["totals"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
