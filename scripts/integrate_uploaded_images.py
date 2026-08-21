#!/usr/bin/env python3
"""Integra y ordena fotos manuales exclusivamente por Código Día o SKU internacional."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import io
import shutil
import unicodedata
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageOps


SUPPORTED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
MAX_FILE_BYTES = 25_000_000
MAX_IMAGES_PER_LOT = 100
LOT_NAMES = tuple(f"lote-{number:02d}" for number in range(1, 5))
PUBLISHED_SUFFIX = ".webp"
PUBLISHED_MAX_SIZE = (960, 960)
PUBLISHED_PRODUCT_SIZE = (900, 900)
PUBLISHED_BACKGROUND = (255, 253, 249)
PUBLISHED_QUALITY = 84

CAMPAIGN_PATTERNS = (
    (r"\bSII\s*(\d{2})", "Summer II"),
    (r"\bSI\s*(\d{2})", "Summer I"),
    (r"\bWC\s*(\d{2})", "World Cup"),
    (r"\bFL\s*(\d{2})", "Fall"),
    (r"\bSP\s*(\d{2})", "Spring"),
    (r"\bWT\s*(\d{2})", "Winter"),
    (r"\bCH(?:R|RISTMAS)?\s*(\d{2})", "Christmas"),
)
MERCH_TYPE_LABELS = {
    "mug": "Tazas",
    "tumbler": "Tumblers",
    "cold-cup": "Cold Cups",
    "bottle": "Botellas",
    "accessory": "Accesorios",
    "other": "Otros",
}


def normalize_name(value: object) -> str:
    text = unicodedata.normalize("NFD", str(value or "").casefold())
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9]", "", text)


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


def catalog_facets(product: dict, source_sheet: str = "") -> dict:
    """Deriva Año, Campaña y Tipo desde Nombre Inventario y Descripción SCI."""
    inventory = str(product.get("nombreInventario") or product.get("nombrePos") or product.get("displayName") or "").strip()
    description = str(product.get("descripcionSci") or "").strip()
    text = f"{inventory} {description}".upper()
    sheet = str(source_sheet or product.get("sourceSheet") or product.get("section") or "").strip()
    campaign = ""
    year = ""
    for pattern, label in CAMPAIGN_PATTERNS:
        match = re.search(pattern, text, re.I)
        if match:
            campaign = label
            year = f"20{match.group(1)}"
            break
    fy_match = re.search(r"\bFY\s*(\d{2})\b", text, re.I)
    if not year and fy_match:
        year = f"20{fy_match.group(1)}"
    if sheet == "Discovery":
        campaign = "Discovery"
    elif sheet == "Homologados":
        campaign = "Homologados"
    elif sheet == "Essentials":
        campaign = campaign or "Essentials"
    elif sheet in {"Base_Campaña", "Campaña"}:
        campaign = campaign or "Campaña"
    if not campaign:
        source = str(product.get("source") or "")
        campaign = next((label for label in ("Summer II", "Summer I", "World Cup", "Fall", "Spring", "Winter", "Christmas") if label.casefold() in source.casefold()), "Sin campaña")
    if not year:
        source_year = re.search(r"\b(20\d{2})\b", str(product.get("source") or ""))
        year = source_year.group(1) if source_year else "Sin año"
    category = str(product.get("category") or category_for(text))
    return {
        "catalogYear": year,
        "catalogCampaign": campaign,
        "catalogMerchType": MERCH_TYPE_LABELS.get(category, "Otros"),
        "catalogSource": sheet or "Catálogo",
    }


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


def load_stock_profile(path: Path) -> dict[str, dict]:
    if not path.is_file():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    stock = payload.get("stockByName", {})
    if stock:
        return {
            normalize_name(key): {
                "ingredient": str(value.get("ingredient") or key),
                "quantity": float(value.get("quantity") or 0),
                "category": str(value.get("category") or ""),
                "unit": str(value.get("unit") or ""),
            }
            for key, value in stock.items()
            if normalize_name(key) and float(value.get("quantity") or 0) > 0
        }
    return {
        normalize_name(value): {"ingredient": str(value), "quantity": 1.0, "category": "", "unit": ""}
        for value in payload.get("activeNames", [])
        if normalize_name(value)
    }


def product_stock(product: dict, stock_profile: dict[str, dict]) -> dict | None:
    matches = [
        stock_profile[key]
        for field in ("nombreInventario", "nombrePos", "displayName")
        if product.get(field)
        for key in (normalize_name(product.get(field)),)
        if key in stock_profile
    ]
    return max(matches, key=lambda row: row["quantity"]) if matches else None


def product_is_active(product: dict, active_names: set[str]) -> bool:
    """Compatibilidad con auditorías anteriores que sólo entregan nombres activos."""
    return any(normalize_name(product.get(field, "")) in active_names for field in ("nombreInventario", "nombrePos", "displayName") if product.get(field))


def image_dimensions(path: Path) -> tuple[int, int]:
    if path.stat().st_size >= MAX_FILE_BYTES:
        raise ValueError(f"Imagen mayor a 25 MB: {path}")
    with Image.open(path) as image:
        image.verify()
        return image.width, image.height


def canonical_day(matches: list[dict], source: Path) -> str:
    """Devuelve un único Código Día; nunca adivina entre relaciones ambiguas."""
    days = {identifier(product.get("codigoDia")) for product in matches if identifier(product.get("codigoDia"))}
    if len(days) > 1:
        raise ValueError(
            f"{source}: el identificador coincide con varios Códigos Día: {', '.join(sorted(days))}"
        )
    return next(iter(days), "")


def encode_catalog_image(source: Path, destination: Path) -> tuple[int, int, str]:
    """Publica un lienzo WebP uniforme sin recortar ni deformar el artículo."""
    if source.stat().st_size >= MAX_FILE_BYTES:
        raise ValueError(f"Imagen mayor a 25 MB: {source}")
    with Image.open(source) as opened:
        source_size = opened.size
        source_format = opened.format
        opened.verify()
    if source_format == "WEBP" and source_size == PUBLISHED_MAX_SIZE:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        return source_size[0], source_size[1], digest
    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        image.thumbnail(PUBLISHED_PRODUCT_SIZE, Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", PUBLISHED_MAX_SIZE, PUBLISHED_BACKGROUND)
        offset = (
            (PUBLISHED_MAX_SIZE[0] - image.width) // 2,
            (PUBLISHED_MAX_SIZE[1] - image.height) // 2,
        )
        canvas.paste(image, offset)
        encoded = io.BytesIO()
        canvas.save(encoded, "WEBP", quality=PUBLISHED_QUALITY, method=6)
        width, height = canvas.size
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(encoded.getvalue())
    with Image.open(destination) as saved:
        saved.verify()
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    return width, height, digest


def discover_images(source_dir: Path) -> tuple[list[Path], list[dict]]:
    source_dir.mkdir(parents=True, exist_ok=True)
    lots = [source_dir / name for name in LOT_NAMES]
    for lot in lots:
        lot.mkdir(exist_ok=True)
    images: list[Path] = []
    lot_report: list[dict] = []
    lot_files: dict[str, list[Path]] = {}
    for lot in lots:
        lot_images = sorted(path for path in lot.iterdir() if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES)
        if len(lot_images) > MAX_IMAGES_PER_LOT:
            raise ValueError(f"{lot.name}: admite como máximo {MAX_IMAGES_PER_LOT} imágenes")
        lot_files[lot.name] = lot_images
    # El lote más reciente gana cuando el mismo Código Día fue copiado en más
    # de una carpeta. Así una carga nueva en lote-02 sustituye la copia antigua
    # de lote-01 y la sincronización posterior elimina el duplicado.
    chosen: dict[str, Path] = {}
    for lot in lots:
        for image in lot_files[lot.name]:
            chosen[normalize_name(re.sub(r"_\d+$", "", image.stem))] = image
    for lot in lots:
        lot_images = lot_files[lot.name]
        ignored: list[dict] = []
        for image in lot_images:
            key = normalize_name(re.sub(r"_\d+$", "", image.stem))
            if chosen[key] != image:
                ignored.append({"file": image.name, "reason": "duplicate-name-superseded", "kept": chosen[key].relative_to(source_dir).as_posix()})
                continue
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


def add_operational_products(products: list[dict], operational_path: Path, image_keys: set[str], stock_keys: set[str]) -> int:
    indices = build_indices(products)
    existing_article_keys = {product.get("articleKey") for product in products}
    added = 0
    for row in load_operational_products(operational_path):
        matching_fields = [field for field in ("codigoDia", "skuIntl") if identifier(row.get(field)) in image_keys]
        active_name = any(
            normalize_name(row.get(field)) in stock_keys
            for field in ("nombreInventario", "nombrePos")
            if row.get(field)
        )
        if not matching_fields and not active_name:
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


def enrich_products_with_woe(products: list[dict], woe_catalog_path: Path) -> None:
    """Cruza nombres por Código Día respetando SAP y Micros como fuentes maestras."""
    by_day: dict[str, list[dict]] = defaultdict(list)
    for row in load_woe_catalog(woe_catalog_path):
        day_key = identifier(row.get("codigoDia"))
        if day_key:
            by_day[day_key].append(row)
    for product in products:
        relations = by_day.get(identifier(product.get("codigoDia")), [])
        def unique_in_source_order(values):
            result = []
            seen = set()
            for value in values:
                clean = str(value or "").strip()
                key = normalize_name(clean)
                if clean and key not in seen:
                    seen.add(key)
                    result.append(clean)
            return result

        product["sapIds"] = unique_in_source_order(row.get("idWoe") for row in relations)
        product["sapDescriptions"] = unique_in_source_order(row.get("descripcionSap") for row in relations)
        product["microsNames"] = unique_in_source_order(
            name for row in relations for name in row.get("micros", [])
        )


def enrich_products_with_operational(products: list[dict], operational_path: Path) -> None:
    """Cruza las pestañas Excel y conserva la clasificación comercial más específica."""
    rows = load_operational_products(operational_path)
    priority = {"Base_Campaña": 0, "Discovery": 1, "Essentials": 2, "Homologados": 3}
    by_day: dict[str, list[dict]] = defaultdict(list)
    by_sku: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        if identifier(row.get("codigoDia")):
            by_day[identifier(row.get("codigoDia"))].append(row)
        if identifier(row.get("skuIntl")):
            by_sku[identifier(row.get("skuIntl"))].append(row)
    for product in products:
        matches = by_day.get(identifier(product.get("codigoDia")), []) or by_sku.get(identifier(product.get("skuIntl")), [])
        row = min(matches, key=lambda value: priority.get(str(value.get("sourceSheet") or ""), 9)) if matches else None
        if row:
            for target, source in (("nombreInventario", "nombreInventario"), ("nombrePos", "nombrePos"), ("descripcionSci", "descripcion"), ("skuIntl", "skuIntl"), ("skuPos", "skuPos")):
                if row.get(source):
                    product[target] = str(row[source]).strip()
            product["displayName"] = product.get("nombreInventario") or product.get("nombrePos") or product.get("displayName")
            product["sourceSheet"] = str(row.get("sourceSheet") or "")
        product.update(catalog_facets(product, str(row.get("sourceSheet") or "") if row else ""))


def add_woe_merch_products(products: list[dict], woe_catalog_path: Path, image_keys: set[str] | None = None) -> int:
    """Añade Merch confirmado o respaldado por una foto con Código Día exacto."""
    image_keys = image_keys or set()
    indices = build_indices(products)
    existing_article_keys = {product.get("articleKey") for product in products}
    added = 0
    for row in load_woe_catalog(woe_catalog_path):
        category = str(row.get("merchCategory") or "").strip()
        codigo = str(row.get("codigoDia") or "").strip()
        day_key = identifier(codigo)
        photo_backed = bool(day_key and day_key in image_keys)
        if (not category and not photo_backed) or not day_key or indices["codigoDia"].get(day_key):
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
            "category": category or category_for(f"{row.get('descripcionSap', '')} {display_name}"),
            "section": "Cruce SAP + Foto" if photo_backed and not category else "Cruce SAP + Micros",
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
    stock_profile = load_stock_profile(active_list)
    images, lots = discover_images(source_dir)
    uploaded_keys = {image_identifier(path) for path in images}
    base_indices = build_indices(products)
    image_keys = set(uploaded_keys)
    for key in uploaded_keys:
        for field in ("codigoDia", "skuIntl"):
            for product in base_indices[field].get(key, []):
                image_keys.update(
                    identifier(product.get(candidate))
                    for candidate in ("codigoDia", "skuIntl")
                    if identifier(product.get(candidate))
                )
    appended_woe_products = add_woe_merch_products(products, woe_catalog, image_keys)
    appended_products = add_operational_products(products, operational_products, image_keys, set(stock_profile))
    enrich_products_with_woe(products, woe_catalog)
    enrich_products_with_operational(products, operational_products)
    indices = build_indices(products)
    images.sort(key=lambda path: (
        0 if image_identifier(path) in indices["codigoDia"] else
        1 if image_identifier(path) in indices["skuIntl"] else 2,
        path.relative_to(source_dir).as_posix(),
    ))

    for product in products:
        stock = product_stock(product, stock_profile)
        active = bool(stock) if stock_profile else product.get("stockPriority") == "active"
        day_key = identifier(product.get("codigoDia"))
        product["stockPriority"] = "active" if active else "secondary"
        product["stockQuantity"] = stock["quantity"] if stock else 0
        product["stockMatchName"] = stock["ingredient"] if stock else ""
        product["stockUnit"] = stock["unit"] if stock else ""
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
    duplicate_content_files = 0
    seen_content: dict[str, Path] = {}
    published_days: dict[str, Path] = {}
    invalid_unmatched: list[str] = []
    for source in images:
        key = image_identifier(source)
        match_field = ""
        matches: list[dict] = []
        for field in ("codigoDia", "skuIntl"):
            if key and indices[field].get(key):
                match_field = field
                matches = indices[field][key]
                break

        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if digest in seen_content:
            duplicate_content_files += 1
            file_rows.append({
                "file": None,
                "uploadedFrom": source.relative_to(source_dir).as_posix(),
                "identifier": key,
                "status": "ignored-duplicate-content",
                "matchedBy": match_field or None,
                "kept": seen_content[digest].relative_to(source_dir).as_posix(),
                "products": [],
            })
            continue
        seen_content[digest] = source

        day_key = canonical_day(matches, source)
        if not day_key:
            invalid_unmatched.append(source.relative_to(source_dir).as_posix())
            continue
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
        if day_key in published_days:
            raise ValueError(
                f"Dos fotografías distintas intentan publicar el Código Día {day_key}: "
                f"{published_days[day_key].relative_to(source_dir)} y {source.relative_to(source_dir)}"
            )
        for product in matches:
            assigned_files[product.get("articleKey")] = source

        # Cada lote es una fuente independiente. No reempaquetar lote-02 en lote-01:
        # hacerlo duplica archivos y rompe las rutas que el usuario subió a GitHub.
        target_lot = source.parent.name
        if target_lot not in LOT_NAMES:
            raise ValueError(f"Lote de origen no permitido: {source.relative_to(source_dir)}")
        relative = Path(target_lot) / f"{day_key}{PUBLISHED_SUFFIX}"
        used_output_lots.add(target_lot)
        destination = image_output / relative
        width, height, published_digest = encode_catalog_image(source, destination)
        published_days[day_key] = source
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
                "revision": published_digest[:12],
            }
            product["imageNote"] = f"Fotografía integrada y relacionada por {match_field}."
            product["photoMatch"] = match_field
            product["photoFile"] = relative.as_posix()
            matched_products.add(product["articleKey"])

        file_rows.append({
            "file": relative.as_posix(),
            "uploadedFrom": relative.as_posix(),
            "identifier": key,
            "status": "matched" if matches else "pending-match",
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

    if invalid_unmatched:
        raise ValueError(
            "Hay imágenes sin Código Día verificable; corrige estos nombres antes de publicar: "
            + ", ".join(invalid_unmatched)
        )

    for lot in output_lots:
        if lot.name not in used_output_lots:
            (lot / ".gitkeep").write_text("", encoding="utf-8")

    post_publish_audit = validate_published_lots(image_output)

    products.sort(key=lambda product: (
        product.get("visual") is None,
        product.get("stockPriority") != "active",
        -float(product.get("stockQuantity") or 0),
        int(product.get("codigoDia")) if str(product.get("codigoDia", "")).isdigit() else 999999,
        str(product.get("displayName", "")).casefold(),
    ))
    active_count = sum(product.get("stockPriority") == "active" for product in products)
    active_with_photo = sum(product.get("stockPriority") == "active" and bool(product.get("visual")) for product in products)
    with_photo = sum(bool(product.get("visual")) for product in products)
    uploaded_image_files = sum(lot["images"] for lot in lots)
    duplicate_identifiers = sum(lot["duplicatesIgnored"] for lot in lots)
    unmatched_files = sum(row.get("status") == "pending-match" for row in file_rows)
    totals = {
        "imageFiles": uploaded_image_files,
        "publishedImageFiles": published_files,
        "matchedImageFiles": matched_files,
        "unmatchedImageFiles": unmatched_files,
        "pendingRelationImageFiles": unmatched_files,
        "duplicateImageFilesIgnored": duplicate_identifiers + duplicate_article_files + duplicate_content_files,
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
        "pendingRelationImageFiles": unmatched_files,
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
        "version": "manual-upload-v14-preserve-lots",
        "source": "assets/catalog/images/lote-01..04",
        "matchOrder": ["codigoDia", "skuIntl"],
        "duplicateProtection": "one-photo-per-article",
        "duplicatePolicy": "prefer-codigo-dia-remove-repeated-identifier-or-content",
        "unmatchedPolicy": "reject-and-report-do-not-guess",
        "publishedNaming": "codigo-dia.webp",
        "publishedMaxPixels": list(PUBLISHED_MAX_SIZE),
        "publishedQuality": PUBLISHED_QUALITY,
        "packing": "preserve-source-lote-01..04",
        "crossCheck": ["SAP", "Catalogo Micros", "Base_Campaña", "Discovery", "Homologados", "Essentials"],
        "stockPriority": "Merch_Existente15_08(1).csv · existencia mayor a menor",
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
