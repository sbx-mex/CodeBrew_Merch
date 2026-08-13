#!/usr/bin/env python3
"""Genera y audita el PDF WOE ejecutivo en carta vertical."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


PAGE_WIDTH = 612
PAGE_HEIGHT = 792
MARGIN = 24
COLUMNS = (
    {"key": "descripcionSap", "label": "DESCRIPCION SAP", "width": 226},
    {"key": "nombreMicros", "label": "NOMBRE MICROS", "width": 142},
    {"key": "codigoDia", "label": "#DIA", "width": 58},
    {"key": "idWoe", "label": "#SAP", "width": 58},
    {"key": "qty", "label": "PZAS", "width": 80},
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
        "version": "letter-portrait-v3-quantity",
        "page": {
            "orientation": "portrait",
            "format": "letter",
            "unit": "pt",
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "margin": MARGIN,
            "tableTop": 82,
            "tableBottom": 754,
            "footerY": 778,
        },
        "columns": list(COLUMNS),
        "style": {
            "titleSize": 18,
            "metaSize": 8,
            "headerSize": 7.5,
            "bodySize": 7.8,
            "lineHeight": 9.2,
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
