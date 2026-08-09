#!/usr/bin/env python3
"""Valida Lista_Precios_Base.xlsx y genera los datos públicos de CodeBrew."""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

from openpyxl import load_workbook


REQUIRED_SHEETS = ("Base_Campaña", "Discovery", "Homologados", "Essentials")
WOE_SHEETS = ("SAP", "Catalogo Micros")
CAMPAIGN_ALIASES = {
    "si": ("Summer", ("SI", "SII", "Summer")),
    "sii": ("Summer", ("SI", "SII", "Summer")),
    "summer": ("Summer", ("SI", "SII", "Summer")),
    "wc": ("World Cup", ("WC", "World Cup")),
    "world cup": ("World Cup", ("WC", "World Cup")),
    "sp": ("Spring", ("SP", "Spring")),
    "spring": ("Spring", ("SP", "Spring")),
    "wt": ("Winter", ("WT", "Winter")),
    "winter": ("Winter", ("WT", "Winter")),
    "xm": ("Christmas", ("XM", "Christmas")),
    "christmas": ("Christmas", ("XM", "Christmas")),
}
FIELD_ALIASES = {
    "skuIntl": ("sku intl",),
    "codigoDia": ("codigo dia",),
    "descripcion": ("descripcion sci", "descripcion"),
    "nombrePos": ("nombre pos",),
    "nombreInventario": ("nombre inventario",),
    "botonPos": ("boton pos",),
    "skuPos": ("sku pos",),
}
REQUIRED_FIELDS = (
    "skuIntl",
    "codigoDia",
    "descripcion",
    "nombrePos",
    "nombreInventario",
    "skuPos",
)


def normalize_header(value: object) -> str:
    text = unicodedata.normalize("NFD", str(value or "").strip())
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    return re.sub(r"\s+", " ", text).casefold()


def clean_text(value: object) -> str:
    return re.sub(r"[ \t]+", " ", str(value or "").strip())


def canonical_text(value: object) -> str:
    """Normaliza espacios sólo para comparar duplicados, sin alterar el dato visible."""
    return re.sub(r"\s+", " ", str(value or "").strip())


def homologate_campaign(value: object):
    """Devuelve campaña homologada sin aplicar coincidencias parciales ambiguas."""
    original = clean_text(value)
    if not original:
        return None
    normalized = normalize_header(original)
    match = CAMPAIGN_ALIASES.get(normalized)
    if not match:
        return None
    name, aliases = match
    return {"original": original, "name": name, "aliases": list(aliases)}


def campaign_from_product_name(value: object):
    """Extrae únicamente un código de campaña completo al inicio del Nombre POS."""
    original = clean_text(value)
    match = re.match(
        r"^(WORLD CUP|CHRISTMAS|SUMMER|SPRING|WINTER|SII|SI|WC|SP|WT|XM)(?=\d|\s|$)",
        original,
        flags=re.IGNORECASE,
    )
    return homologate_campaign(match.group(1)) if match else homologate_campaign(original)


def identifier(cell) -> str:
    value = cell.value
    if value is None:
        return ""
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, (int, float, Decimal)):
        number = Decimal(str(value))
        if number == number.to_integral():
            text = str(number.quantize(Decimal("1")))
            fmt = str(cell.number_format or "")
            zero_match = re.fullmatch(r"0+", fmt)
            return text.zfill(len(fmt)) if zero_match else text
        return format(number.normalize(), "f")
    return clean_text(value)


def money(value: object) -> str:
    if value is None or clean_text(value) == "":
        return ""
    if isinstance(value, str):
        raw = re.sub(r"[$,\s]", "", value)
    else:
        raw = str(value)
    try:
        amount = Decimal(raw)
    except InvalidOperation:
        raise ValueError(f"precio no numérico: {value!r}")
    return f"${amount:,.2f}"


def locate_headers(ws):
    original = [clean_text(cell.value) for cell in ws[1]]
    normalized = [normalize_header(value) for value in original]
    duplicates = [name for name, count in Counter(normalized).items() if name and count > 1]
    positions = {}
    for field, aliases in FIELD_ALIASES.items():
        matches = [index for index, header in enumerate(normalized) if header in aliases]
        if len(matches) > 1:
            raise ValueError(f"encabezado duplicado para {field}: {matches}")
        if matches:
            positions[field] = matches[0]
    missing = [field for field in REQUIRED_FIELDS if field not in positions]
    price_columns = {
        original[index].strip().upper(): index
        for index, header in enumerate(normalized)
        if re.fullmatch(r"c[1-6]", header)
    }
    if missing:
        raise ValueError(f"faltan encabezados indispensables: {', '.join(missing)}")
    if not price_columns:
        raise ValueError("no se detectó ningún encabezado de precio C1-C6")
    return original, positions, price_columns, duplicates


def sheet_button(sheet_name: str, row, positions) -> str:
    if "botonPos" in positions:
        return clean_text(row[positions["botonPos"]].value)
    if sheet_name == "Base_Campaña":
        return "Campaña"
    if sheet_name == "Essentials":
        return "Essentials"
    return ""


def parse_sheet(ws):
    headers, positions, price_columns, duplicate_headers = locate_headers(ws)
    products = []
    empty_rows = 0
    invalid_rows = []
    duplicate_rows = 0
    seen = set()

    for row_number, row in enumerate(ws.iter_rows(min_row=2), start=2):
        if all(cell.value is None or clean_text(cell.value) == "" for cell in row):
            empty_rows += 1
            continue
        try:
            nombre_pos = clean_text(row[positions["nombrePos"]].value)
            campaign = campaign_from_product_name(nombre_pos) if ws.title == "Base_Campaña" else None
            product = {
                "skuIntl": identifier(row[positions["skuIntl"]]),
                "codigoDia": identifier(row[positions["codigoDia"]]),
                "descripcion": clean_text(row[positions["descripcion"]].value),
                "nombrePos": nombre_pos,
                "nombreInventario": clean_text(row[positions["nombreInventario"]].value),
                "skuPos": identifier(row[positions["skuPos"]]),
                "botonPos": sheet_button(ws.title, row, positions),
                "tier": {
                    tier: money(row[index].value)
                    for tier, index in price_columns.items()
                    if row[index].value is not None and clean_text(row[index].value) != ""
                },
                "base": "Campaña" if ws.title == "Base_Campaña" else ws.title,
                "sourceSheet": ws.title,
                "sourceRow": row_number,
            }
            if campaign:
                product.update({
                    "campaignOriginal": campaign["original"],
                    "campaign": campaign["name"],
                    "campaignAliases": campaign["aliases"],
                })
        except (IndexError, ValueError) as error:
            invalid_rows.append({"row": row_number, "reason": str(error)})
            continue

        searchable = any(
            product[key] for key in ("skuIntl", "codigoDia", "nombrePos", "nombreInventario", "skuPos")
        )
        if not searchable or not product["tier"]:
            invalid_rows.append({"row": row_number, "reason": "sin identificador útil o sin precio"})
            continue

        fingerprint = json.dumps(
            {key: value for key, value in product.items() if key not in ("sourceRow",)},
            ensure_ascii=False,
            sort_keys=True,
        )
        if fingerprint in seen:
            duplicate_rows += 1
            continue
        seen.add(fingerprint)
        products.append(product)

    report = {
        "sheet": ws.title,
        "headers": headers,
        "records": ws.max_row - 1,
        "valid": len(products),
        "emptyRows": empty_rows,
        "duplicatesIgnored": duplicate_rows,
        "invalidRows": invalid_rows,
        "duplicateHeaders": duplicate_headers,
        "campaigns": dict(Counter(
            product["campaign"] for product in products if product.get("campaign")
        )),
    }
    return products, report


def parse_woe_catalog(workbook, products):
    """Construye el catálogo WOE sin perder relaciones uno-a-varios."""
    missing = [name for name in WOE_SHEETS if name not in workbook.sheetnames]
    if missing:
        raise ValueError(f"faltan pestañas WOE: {', '.join(missing)}")

    sap_ws = workbook["SAP"]
    micros_ws = workbook["Catalogo Micros"]
    sap_headers = [normalize_header(cell.value) for cell in sap_ws[1]]
    micros_headers = [normalize_header(cell.value) for cell in micros_ws[1]]
    if sap_headers[:3] != ["id woe", "codigo dia", "descripcion sap"]:
        raise ValueError("SAP requiere: ID WOE, Codigo DIA y Descripcion SAP")
    if micros_headers[:2] != ["codigo dia", "nombre micros"]:
        raise ValueError("Catalogo Micros requiere: Codigo DIA y Nombre Micros")

    micros_by_dia = {}
    micros_rows = 0
    for row_number, row in enumerate(micros_ws.iter_rows(min_row=2), start=2):
        code = identifier(row[0])
        name = clean_text(row[1].value if len(row) > 1 else "")
        if not code and not name:
            continue
        micros_rows += 1
        if not code:
            raise ValueError(f"Catalogo Micros fila {row_number}: falta Codigo DIA")
        values = micros_by_dia.setdefault(code, [])
        if name and name not in values:
            values.append(name)

    merch_by_dia = {}
    for product in products:
        code = clean_text(product.get("codigoDia"))
        if not code:
            continue
        compact = {
            "base": product.get("base", ""),
            "descripcionSci": product.get("descripcion", ""),
            "nombrePos": product.get("nombrePos", ""),
            "nombreInventario": product.get("nombreInventario", ""),
            "skuIntl": product.get("skuIntl", ""),
            "skuPos": product.get("skuPos", ""),
        }
        rows = merch_by_dia.setdefault(code, [])
        if compact not in rows:
            rows.append(compact)

    catalog = []
    seen_woe = Counter()
    seen_dia = Counter()
    sap_rows = 0
    exact_sap_duplicates = 0
    seen_sap_rows = set()
    sap_codes = set()
    for row_number, row in enumerate(sap_ws.iter_rows(min_row=2), start=2):
        woe_id = identifier(row[0])
        code = identifier(row[1])
        description = clean_text(row[2].value if len(row) > 2 else "")
        if not woe_id and not code and not description:
            continue
        sap_rows += 1
        if not woe_id or not code:
            raise ValueError(f"SAP fila {row_number}: ID WOE o Codigo DIA vacío")
        fingerprint = (woe_id, code, canonical_text(description))
        if fingerprint in seen_sap_rows:
            exact_sap_duplicates += 1
            continue
        seen_sap_rows.add(fingerprint)
        sap_codes.add(code)
        seen_woe[woe_id] += 1
        seen_dia[code] += 1
        micros = micros_by_dia.get(code, [])
        merch = merch_by_dia.get(code, [])
        catalog.append({
            "idWoe": woe_id,
            "codigoDia": code,
            "descripcionSap": description,
            "micros": micros,
            "merch": merch,
            "validation": {
                "sap": bool(description),
                "micros": bool(micros),
                "merch": bool(merch),
            },
            "operationalValidation": {
                "sapMicros": bool(description and micros),
                "merchRequired": False,
            },
            "sourceRow": row_number,
            "origin": "SAP",
        })

    orphan_codes = sorted(
        (set(micros_by_dia) | set(merch_by_dia)) - sap_codes,
        key=lambda value: (not value.isdigit(), int(value) if value.isdigit() else value),
    )
    for code in orphan_codes:
        micros = micros_by_dia.get(code, [])
        merch = merch_by_dia.get(code, [])
        catalog.append({
            "idWoe": "",
            "codigoDia": code,
            "descripcionSap": "",
            "micros": micros,
            "merch": merch,
            "validation": {"sap": False, "micros": bool(micros), "merch": bool(merch)},
            "operationalValidation": {"sapMicros": False, "merchRequired": False},
            "sourceRow": None,
            "origin": "Micros/MERCH",
        })

    if not catalog:
        raise ValueError("SAP no contiene registros válidos")

    report = {
        "sapRows": sap_rows,
        "catalogRows": len(catalog),
        "sapCatalogRows": len(seen_sap_rows),
        "orphanCatalogRows": len(orphan_codes),
        "uniqueWoe": len(seen_woe),
        "uniqueDiaSap": len(seen_dia),
        "exactSapDuplicatesIgnored": exact_sap_duplicates,
        "multiWoeRelations": sum(count - 1 for count in seen_woe.values()),
        "multiDiaRelations": sum(count - 1 for count in seen_dia.values()),
        "microsRows": micros_rows,
        "uniqueDiaMicros": len(micros_by_dia),
        "withMicros": sum(1 for item in catalog if item["validation"]["micros"]),
        "withMerch": sum(1 for item in catalog if item["validation"]["merch"]),
        "withoutSap": sum(1 for item in catalog if not item["validation"]["sap"]),
        "operationalSapMicrosMatch": sum(1 for item in catalog if item["operationalValidation"]["sapMicros"]),
        "operationalNeedsReview": sum(1 for item in catalog if not item["operationalValidation"]["sapMicros"]),
        "completeTripleMatch": sum(1 for item in catalog if item["validation"]["sap"] and item["validation"]["micros"] and item["validation"]["merch"]),
    }
    return catalog, report


def generate(excel_path: Path, js_path: Path, woe_path: Path, report_path: Path):
    workbook = load_workbook(excel_path, data_only=True, read_only=False)
    missing_sheets = [name for name in REQUIRED_SHEETS if name not in workbook.sheetnames]
    if missing_sheets:
        raise ValueError(f"faltan pestañas obligatorias: {', '.join(missing_sheets)}")

    products = []
    reports = []
    for sheet_name in REQUIRED_SHEETS:
        parsed, report = parse_sheet(workbook[sheet_name])
        products.extend(parsed)
        reports.append(report)

    woe_catalog, woe_report = parse_woe_catalog(workbook, products)

    campaign = workbook["Base_Campaña"]
    if normalize_header(campaign["D1"].value) != "nombre pos":
        raise ValueError("Base_Campaña!D1 no corresponde al encabezado NOMBRE POS")
    latest_item = clean_text(campaign["D2"].value)
    if latest_item and not any(
        product["sourceSheet"] == "Base_Campaña" and product["nombrePos"] == latest_item
        for product in products
    ):
        raise ValueError("Base_Campaña!D2 no coincide con un artículo válido procesado")

    processed_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    source_modified = workbook.properties.modified
    if source_modified:
        if source_modified.tzinfo is None:
            source_modified = source_modified.replace(tzinfo=timezone.utc)
        generated_at = source_modified.astimezone(timezone.utc).isoformat(timespec="seconds")
    else:
        generated_at = "unknown"
    meta = {
        "sourceFile": excel_path.name,
        "generatedAtUtc": generated_at,
        "latestItem": latest_item,
        "totalProducts": len(products),
        "sheets": {item["sheet"]: item["valid"] for item in reports},
        "woeRecords": len(woe_catalog),
    }
    report = {
        "status": "ok",
        "sourceFile": excel_path.name,
        "generatedAtUtc": processed_at,
        "sourceModifiedAtUtc": generated_at,
        "latestItemCell": "Base_Campaña!D2",
        "latestItem": latest_item,
        "totalValidProducts": len(products),
        "sheets": reports,
        "woe": woe_report,
    }

    js_path.parent.mkdir(parents=True, exist_ok=True)
    woe_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    js_path.write_text(
        "window.PRODUCTS = "
        + json.dumps(products, ensure_ascii=False, separators=(",", ":"))
        + ";\nwindow.PRODUCT_META = "
        + json.dumps(meta, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    woe_path.write_text(
        "window.WOE_CATALOG = "
        + json.dumps(woe_catalog, ensure_ascii=False, separators=(",", ":"))
        + ";\nwindow.WOE_META = "
        + json.dumps(woe_report, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--excel", default="Lista_Precios_Base.xlsx")
    parser.add_argument("--output", default="data/products.js")
    parser.add_argument("--woe-output", default="data/woe.js")
    parser.add_argument("--report", default="data/import-report.json")
    args = parser.parse_args()
    try:
        generate(Path(args.excel), Path(args.output), Path(args.woe_output), Path(args.report))
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
