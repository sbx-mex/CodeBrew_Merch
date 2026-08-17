#!/usr/bin/env python3
"""Normaliza el inventario nacional y genera prioridad por existencia."""

from __future__ import annotations

import argparse
import csv
import json
import re
import unicodedata
from collections import defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path


FIELD_ALIASES = {
    "category": {"categoria inventario", "categoria"},
    "name": {"ingrediente", "articulo", "nombre inventario", "nombre"},
    "unit": {"unidad de medida", "unidad", "umb"},
    "quantity": {"inventario final #", "inventario final", "existencia", "stock", "cantidad"},
}
OUTPUT_HEADERS = ("Categoría Inventario", "Ingrediente", "Unidad de Medida", "Inventario Final (#)")


def normalize_header(value: object) -> str:
    text = unicodedata.normalize("NFD", str(value or "").strip())
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()


def normalize_name(value: object) -> str:
    return re.sub(r"[^a-z0-9]", "", normalize_header(value))


def clean_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def parse_quantity(value: object) -> Decimal:
    raw = clean_text(value).replace("$", "").replace(",", "")
    if not raw:
        return Decimal("0")
    try:
        return Decimal(raw)
    except InvalidOperation as error:
        raise ValueError(f"existencia no numérica: {value!r}") from error


def number(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral() else float(value)


def locate_fields(headers: list[str]) -> dict[str, int]:
    normalized = [normalize_header(value) for value in headers]
    positions: dict[str, int] = {}
    for field, aliases in FIELD_ALIASES.items():
        matches = [index for index, header in enumerate(normalized) if header in aliases]
        if len(matches) != 1:
            raise ValueError(f"encabezado {field}: se esperaba una coincidencia y se encontraron {len(matches)}")
        positions[field] = matches[0]
    return positions


def load_stock(path: Path) -> tuple[list[dict], dict]:
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        sample = stream.read(8192)
        stream.seek(0)
        dialect = csv.Sniffer().sniff(sample, delimiters=",;|\t")
        rows = list(csv.reader(stream, dialect))
    if not rows:
        raise ValueError("el CSV de existencia está vacío")
    positions = locate_fields(rows[0])
    grouped: dict[str, dict] = {}
    invalid_rows: list[dict] = []
    for row_number, row in enumerate(rows[1:], start=2):
        if not any(clean_text(value) for value in row):
            continue
        try:
            name = clean_text(row[positions["name"]])
            key = normalize_name(name)
            quantity = parse_quantity(row[positions["quantity"]])
        except (IndexError, ValueError) as error:
            invalid_rows.append({"row": row_number, "reason": str(error)})
            continue
        if not key:
            invalid_rows.append({"row": row_number, "reason": "Ingrediente vacío"})
            continue
        category = clean_text(row[positions["category"]])
        unit = clean_text(row[positions["unit"]])
        if key not in grouped:
            grouped[key] = {
                "key": key,
                "ingredient": name,
                "category": category,
                "unit": unit,
                "quantity": Decimal("0"),
                "sourceRows": [],
            }
        item = grouped[key]
        item["quantity"] += quantity
        item["sourceRows"].append(row_number)
        if category and not item["category"]:
            item["category"] = category
        if unit and not item["unit"]:
            item["unit"] = unit

    items = sorted(grouped.values(), key=lambda item: (-item["quantity"], item["ingredient"].casefold()))
    output = [{**item, "quantity": number(item["quantity"])} for item in items]
    report = {
        "sourceRows": len(rows) - 1,
        "uniqueItems": len(output),
        "positiveItems": sum(item["quantity"] > 0 for item in output),
        "duplicateRowsConsolidated": sum(max(0, len(item["sourceRows"]) - 1) for item in output),
        "invalidRows": invalid_rows,
    }
    return output, report


def write_clean_csv(path: Path, items: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(OUTPUT_HEADERS)
        for item in items:
            writer.writerow((item["category"], item["ingredient"], item["unit"], item["quantity"]))


def write_json(path: Path, source: Path, items: list[dict], report: dict) -> None:
    active = [item for item in items if item["quantity"] > 0]
    payload = {
        "version": "stock-priority-v2",
        "source": source.name,
        "purpose": "prioridad-fotos-pendientes-por-existencia",
        "activeNames": [item["key"] for item in active],
        "stockByName": {
            item["key"]: {
                "ingredient": item["ingredient"],
                "quantity": item["quantity"],
                "category": item["category"],
                "unit": item["unit"],
            }
            for item in active
        },
        "stockItems": active,
        "audit": report,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", type=Path, default=Path("Merch_Existente15_08(1).csv"))
    parser.add_argument("--output", type=Path, default=Path("data/merch-active-products.json"))
    parser.add_argument("--clean-csv", type=Path)
    args = parser.parse_args()
    items, report = load_stock(args.csv)
    write_json(args.output, args.csv, items, report)
    if args.clean_csv:
        write_clean_csv(args.clean_csv, items)
    print(json.dumps({"status": "ok", **report}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
