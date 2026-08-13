#!/usr/bin/env python3
"""Construye el catálogo visual desde listas de precio Excel independientes."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import re
import shutil
import unicodedata
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

from openpyxl import load_workbook
from PIL import Image, ImageDraw, ImageFilter

TILE = 256
GRID = 8
ATLAS_CAPACITY = GRID * GRID
MAX_FILE_BYTES = 25_000_000
MAX_XLSX_UNCOMPRESSED = 120_000_000
IMAGE_NOTE = "Imagen recreada de la Lista de Precio; es una aproximación visual."
FIELD_ALIASES = {
    "skuIntl": {"sku intl"},
    "codigoDia": {"codigo dia"},
    "descripcion": {"descripcion sci", "descripcion"},
    "nombrePos": {"nombre pos"},
    "nombreInventario": {"nombre inventario"},
    "skuPos": {"sku pos"},
    "imagen": {"imagen"},
}
REQUIRED_FIELDS = {"codigoDia", "descripcion", "nombrePos", "nombreInventario", "skuPos", "imagen"}


def normalize(value: object) -> str:
    text = unicodedata.normalize("NFD", str(value or ""))
    ascii_text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", ascii_text.casefold()).strip()


def clean(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def identifier(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return clean(value)


def slug(value: object, limit: int = 52) -> str:
    return normalize(value).replace(" ", "-")[:limit].strip("-") or "articulo"


def validate_xlsx(path: Path) -> None:
    if not path.is_file() or path.stat().st_size >= MAX_FILE_BYTES or not zipfile.is_zipfile(path):
        raise ValueError(f"Motor inválido o mayor a 25 MB: {path.name}")
    with zipfile.ZipFile(path) as archive:
        total = sum(item.file_size for item in archive.infolist())
        if total > MAX_XLSX_UNCOMPRESSED:
            raise ValueError(f"Motor descomprimido demasiado grande: {path.name}")
        for item in archive.infolist():
            if item.filename.startswith(("/", "\\")) or ".." in Path(item.filename).parts:
                raise ValueError(f"Ruta interna insegura en {path.name}")


def locate_headers(sheet) -> tuple[int, dict[str, int], dict[str, int]]:
    for row_number in range(1, min(sheet.max_row, 12) + 1):
        headers = [normalize(sheet.cell(row_number, column).value) for column in range(1, sheet.max_column + 1)]
        if "codigo dia" not in headers:
            continue
        positions: dict[str, int] = {}
        for field, aliases in FIELD_ALIASES.items():
            matches = [index + 1 for index, header in enumerate(headers) if header in aliases]
            if len(matches) > 1:
                raise ValueError(f"{sheet.title}: encabezado duplicado {field}")
            if matches:
                positions[field] = matches[0]
        if missing := REQUIRED_FIELDS.difference(positions):
            raise ValueError(f"{sheet.title}: faltan encabezados {sorted(missing)}")
        prices = {header.upper(): index + 1 for index, header in enumerate(headers) if re.fullmatch(r"c[1-6]", header)}
        if not prices:
            raise ValueError(f"{sheet.title}: no contiene precios C1-C6")
        return row_number, positions, prices
    raise ValueError(f"{sheet.title}: no se localizó el encabezado Código Día")


def category_for(text: str) -> str:
    key = normalize(text)
    if any(token in key for token in ("cold cup", "cld cup", "ccup")):
        return "cold-cup"
    if any(token in key for token in ("water bottle", "wtr btl", "bottle", "btl")):
        return "bottle"
    if any(token in key for token in ("tumbler", "tmblr", "tumb ")):
        return "tumbler"
    if any(token in key for token in ("mug", "taza", "ceramic", "cermc")):
        return "mug"
    if any(token in key for token in ("press", "chemex", "cafetera", "pour over", "brew")):
        return "brew"
    if any(token in key for token in ("bag", "tote", "key ring", "iman", "magnet")):
        return "accessory"
    return "other"


def fallback_tile(category: str) -> Image.Image:
    palette = {
        "mug": (0, 98, 65), "tumbler": (35, 62, 52), "cold-cup": (42, 113, 88),
        "bottle": (92, 124, 111), "brew": (137, 86, 47), "accessory": (196, 155, 81), "other": (111, 126, 119),
    }
    color = palette[category]
    canvas = Image.new("RGB", (TILE, TILE), "#f5f0e7")
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((20, 20, 236, 236), 28, fill="#fffdf9")
    if category == "mug":
        draw.rounded_rectangle((70, 72, 174, 192), 18, fill=color)
        draw.ellipse((150, 98, 210, 164), outline=color, width=18)
    elif category in {"tumbler", "cold-cup"}:
        draw.rounded_rectangle((78, 48, 178, 210), 28, fill=color)
        draw.rounded_rectangle((68, 42, 188, 66), 10, fill=(31, 44, 39))
        if category == "cold-cup":
            draw.line((154, 46, 174, 20), fill=color, width=8)
    elif category == "bottle":
        draw.rounded_rectangle((88, 58, 168, 214), 30, fill=color)
        draw.rounded_rectangle((102, 38, 154, 78), 12, fill=(31, 44, 39))
    elif category == "brew":
        draw.rounded_rectangle((70, 68, 180, 202), 16, outline=color, width=13)
        draw.rectangle((83, 88, 167, 188), fill=(231, 223, 209))
        draw.line((125, 38, 125, 90), fill=(31, 44, 39), width=10)
        draw.ellipse((106, 30, 144, 54), fill=(31, 44, 39))
    elif category == "accessory":
        draw.rounded_rectangle((64, 72, 192, 198), 14, fill=(238, 228, 209), outline=color, width=8)
        draw.arc((82, 38, 174, 124), 180, 360, fill=color, width=10)
    else:
        draw.rounded_rectangle((72, 64, 184, 196), 26, fill=color)
        draw.ellipse((104, 96, 152, 144), fill="#f5f0e7")
    return canvas


def product_tile(data: bytes) -> Image.Image:
    with Image.open(io.BytesIO(data)) as image:
        image = image.convert("RGBA")
        if max(image.size) < 96:
            factor = max(2, math.ceil(128 / max(image.size)))
            image = image.resize((image.width * factor, image.height * factor), Image.Resampling.LANCZOS)
            image = image.filter(ImageFilter.UnsharpMask(radius=1.1, percent=145, threshold=2))
        image.thumbnail((214, 214), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (TILE, TILE), "#fffdf9")
        x = (TILE - image.width) // 2
        y = (TILE - image.height) // 2
        canvas.alpha_composite(image, (x, y))
        return canvas.convert("RGB")


def source_label(path: Path) -> str:
    name = normalize(path.stem)
    if "summer 2026" in name:
        return "Summer 2026"
    if "winter 2026" in name or "core winter" in name:
        return "Core Winter 2026"
    if "generico" in name:
        return "Genéricos homologados"
    return clean(path.stem)


def parse_workbook(path: Path, priority: int) -> tuple[list[dict], dict[str, bytes], dict]:
    validate_xlsx(path)
    workbook = load_workbook(path, data_only=True, read_only=False, keep_links=False)
    sheet = workbook.active
    header_row, positions, price_columns = locate_headers(sheet)
    image_end = positions["descripcion"] - 1
    image_candidates: defaultdict[int, list] = defaultdict(list)
    for image in getattr(sheet, "_images", []):
        if not hasattr(image.anchor, "_from"):
            continue
        row = image.anchor._from.row + 1
        column = image.anchor._from.col + 1
        if positions["imagen"] <= column <= image_end:
            image_candidates[row].append(image)

    products: list[dict] = []
    images: dict[str, bytes] = {}
    current_section = "Catálogo"
    rows_with_images = 0
    for row_number in range(header_row + 1, sheet.max_row + 1):
        row_values = [sheet.cell(row_number, column).value for column in range(1, sheet.max_column + 1)]
        codigo = identifier(sheet.cell(row_number, positions["codigoDia"]).value)
        descripcion = clean(sheet.cell(row_number, positions["descripcion"]).value)
        sku_pos = identifier(sheet.cell(row_number, positions["skuPos"]).value)
        if not codigo or not (descripcion or sku_pos):
            nonempty = [clean(value) for value in row_values if clean(value)]
            if len(nonempty) == 1:
                current_section = nonempty[0]
            continue
        nombre_pos = clean(sheet.cell(row_number, positions["nombrePos"]).value)
        nombre_inventario = clean(sheet.cell(row_number, positions["nombreInventario"]).value)
        display_name = nombre_inventario or nombre_pos or descripcion
        name_key = slug(display_name)
        article_key = f"dia-{slug(codigo, 18)}--pos-{slug(sku_pos or name_key, 24)}"
        category = category_for(f"{descripcion} {display_name}")
        prices = {}
        for tier, column in price_columns.items():
            value = sheet.cell(row_number, column).value
            if isinstance(value, (int, float)):
                prices[tier] = round(float(value), 2)
        visual_key = f"fallback:{category}"
        candidates = image_candidates.get(row_number, [])
        if candidates:
            selected = max(candidates, key=lambda item: int(item.width) * int(item.height))
            try:
                raw = selected._data()
                digest = hashlib.sha256(raw).hexdigest()[:20]
                visual_key = f"real:{digest}"
                images.setdefault(visual_key, raw)
                rows_with_images += 1
            except (OSError, ValueError):
                pass
        products.append({
            "articleKey": article_key,
            "nameKey": name_key,
            "codigoDia": codigo,
            "skuPos": sku_pos,
            "skuIntl": identifier(sheet.cell(row_number, positions.get("skuIntl", 1)).value),
            "descripcionSci": descripcion,
            "nombrePos": nombre_pos,
            "nombreInventario": nombre_inventario,
            "displayName": display_name,
            "category": category,
            "section": current_section,
            "prices": prices,
            "source": source_label(path),
            "sourceFile": path.name,
            "sourceRow": row_number,
            "priority": priority,
            "visualKey": visual_key,
        })
    workbook.close()
    return products, images, {
        "file": path.name, "sheet": sheet.title, "rows": sheet.max_row,
        "products": len(products), "productsWithImage": rows_with_images,
    }


def write_atlases(visuals: dict[str, bytes], output: Path) -> dict[str, dict]:
    output.mkdir(parents=True, exist_ok=True)
    tiles: list[tuple[str, Image.Image, str]] = []
    for key in sorted(visuals):
        tiles.append((key, product_tile(visuals[key]), "excel"))
    for category in ("mug", "tumbler", "cold-cup", "bottle", "brew", "accessory", "other"):
        tiles.append((f"fallback:{category}", fallback_tile(category), "approximation"))
    descriptors: dict[str, dict] = {}
    for atlas_index in range(math.ceil(len(tiles) / ATLAS_CAPACITY)):
        atlas = Image.new("RGB", (TILE * GRID, TILE * GRID), "#fffdf9")
        batch = tiles[atlas_index * ATLAS_CAPACITY:(atlas_index + 1) * ATLAS_CAPACITY]
        for local_index, (key, tile, kind) in enumerate(batch):
            column, row = local_index % GRID, local_index // GRID
            atlas.paste(tile, (column * TILE, row * TILE))
            descriptors[key] = {
                "atlas": f"assets/catalog/atlases/catalog-{atlas_index + 1:02d}.webp",
                "x": round(column * 100 / (GRID - 1), 6),
                "y": round(row * 100 / (GRID - 1), 6),
                "kind": kind,
            }
        destination = output / f"catalog-{atlas_index + 1:02d}.webp"
        atlas.save(destination, "WEBP", quality=86, method=6)
        if destination.stat().st_size >= MAX_FILE_BYTES:
            raise ValueError(f"Atlas mayor a 25 MB: {destination.name}")
    if len(list(output.iterdir())) >= 100:
        raise ValueError("La carpeta de atlas alcanzó 100 archivos")
    return descriptors


def generate(engine_dir: Path, js_output: Path, report_output: Path, atlas_output: Path) -> dict:
    def engine_priority(path: Path) -> tuple[int, str]:
        name = normalize(path.stem)
        if "summer 2026" in name:
            return (0, name)
        if "winter 2026" in name or "core winter" in name:
            return (1, name)
        return (2, name)

    paths = sorted(engine_dir.glob("*.xlsx"), key=engine_priority)
    if not paths or len(paths) >= 100:
        raise ValueError("La carpeta de motores requiere entre 1 y 99 Excel")
    parsed: list[dict] = []
    visuals: dict[str, bytes] = {}
    sources = []
    for priority, path in enumerate(paths):
        products, images, report = parse_workbook(path, priority)
        parsed.extend(products)
        visuals.update(images)
        sources.append(report)
    deduplicated: dict[tuple[str, str, str], dict] = {}
    duplicate_count = 0
    for product in sorted(parsed, key=lambda item: item["priority"]):
        fingerprint = (product["codigoDia"], product["skuPos"], product["nameKey"])
        if fingerprint in deduplicated:
            duplicate_count += 1
            continue
        deduplicated[fingerprint] = product
    products = sorted(deduplicated.values(), key=lambda item: (item["priority"], int(item["codigoDia"]) if item["codigoDia"].isdigit() else 999999, item["displayName"]))
    if atlas_output.exists():
        shutil.rmtree(atlas_output)
    descriptors = write_atlases(visuals, atlas_output)
    for product in products:
        product["visual"] = descriptors[product.pop("visualKey")]
        product.pop("priority", None)
        product["imageNote"] = IMAGE_NOTE
    counts = Counter(product["category"] for product in products)
    approximation_count = sum(product["visual"]["kind"] == "approximation" for product in products)
    report = {
        "status": "ok", "engineFiles": len(paths), "products": len(products),
        "duplicateRowsIgnored": duplicate_count, "withExcelImage": len(products) - approximation_count,
        "withApproximation": approximation_count, "uniqueVisuals": len(visuals),
        "atlases": len(list(atlas_output.glob("*.webp"))), "categories": dict(counts),
        "sources": sources, "imageNote": IMAGE_NOTE,
    }
    payload = {"version": "premium-visual-catalog-v1", "products": products, "meta": report}
    js_output.parent.mkdir(parents=True, exist_ok=True)
    report_output.parent.mkdir(parents=True, exist_ok=True)
    js_output.write_text("window.MERCH_VISUAL_CATALOG=" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    report_output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-dir", type=Path, default=Path("engines/merch-lists"))
    parser.add_argument("--output", type=Path, default=Path("data/merch-catalog.js"))
    parser.add_argument("--report", type=Path, default=Path("data/merch-catalog-report.json"))
    parser.add_argument("--atlas-output", type=Path, default=Path("assets/catalog/atlases"))
    args = parser.parse_args()
    report = generate(args.engine_dir, args.output, args.report, args.atlas_output)
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
