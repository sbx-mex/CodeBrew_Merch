#!/usr/bin/env python3
"""Genera y audita la configuración del PDF WOE tamaño carta."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


PAGE_WIDTH = 792
PAGE_HEIGHT = 612
MARGIN = 24
COLUMNS = (
    {"key": "descripcionSap", "label": "DESCRIPCION SAP", "width": 240},
    {"key": "nombreMicros", "label": "NOMBRE MICROS", "width": 165},
    {"key": "codigoDia", "label": "#DIA", "width": 50},
    {"key": "idWoe", "label": "#SAP", "width": 60},
    {"key": "validacion", "label": "VALIDACION", "width": 105},
    {"key": "skuMerch", "label": "SKU MERCH - APOYO", "width": 124},
)


def build(report_path: Path) -> dict:
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("status") != "ok":
        raise ValueError("La auditoría del Excel no está en estado OK")
    printable_width = PAGE_WIDTH - (MARGIN * 2)
    table_width = sum(column["width"] for column in COLUMNS)
    if table_width != printable_width:
        raise ValueError(
            f"Las columnas usan {table_width} pt y el área disponible es {printable_width} pt"
        )
    woe = report.get("woe", {})
    return {
        "version": "letter-v1",
        "page": {
            "orientation": "landscape",
            "format": "letter",
            "unit": "pt",
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "margin": MARGIN,
            "tableTop": 78,
            "tableBottom": 574,
            "footerY": 598,
        },
        "columns": list(COLUMNS),
        "style": {
            "titleSize": 18,
            "metaSize": 8,
            "headerSize": 7.2,
            "bodySize": 7.4,
            "lineHeight": 8.6,
            "cellPadding": 5,
            "maxLinesPerCell": 4,
            "green": [0, 98, 65],
            "dark": [7, 63, 47],
            "cream": [249, 246, 239],
            "line": [221, 225, 220],
            "warning": [180, 83, 9],
        },
        "audit": {
            "catalogRows": int(woe.get("catalogRows", 0)),
            "operationalMatches": int(woe.get("operationalSapMicrosMatch", 0)),
            "operationalNeedsReview": int(woe.get("operationalNeedsReview", 0)),
            "tableWidth": table_width,
            "printableWidth": printable_width,
            "fit": table_width == printable_width,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", default="data/import-report.json")
    parser.add_argument("--output", default="data/woe-pdf-config.js")
    args = parser.parse_args()
    config = build(Path(args.report))
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        "window.WOE_PDF_CONFIG = "
        + json.dumps(config, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    print(json.dumps({"status": "ok", "output": str(destination), **config["audit"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
