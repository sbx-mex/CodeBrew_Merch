#!/usr/bin/env python3
"""Genera y audita la configuración del módulo opcional Stock on Hand."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


PAGE_WIDTH = 612
PAGE_HEIGHT = 792
MARGIN = 24
COLUMNS = (
    {"key": "codigoDia", "label": "#DIA", "width": 55},
    {"key": "idWoe", "label": "#SAP", "width": 55},
    {"key": "descripcionSap", "label": "DESCRIPCION SAP", "width": 190},
    {"key": "nombreMicros", "label": "NOMBRE MICROS", "width": 160},
    {"key": "unidad", "label": "UNIDAD STOCK", "width": 60},
    {"key": "qty", "label": "QTY", "width": 44},
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
        "version": "stock-on-hand-v1",
        "parser": {
            "yTolerance": 2.0,
            "itemMaxX": 210,
            "unitMinX": 205,
            "unitMaxX": 330,
            "qtyMinX": 330,
            "qtyMaxX": 410,
            "zeroTolerance": 0.000001,
            "previewLimit": 250,
        },
        "page": {
            "orientation": "portrait",
            "format": "letter",
            "unit": "pt",
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "margin": MARGIN,
            "tableTop": 112,
            "tableBottom": 754,
            "footerY": 778,
        },
        "columns": list(COLUMNS),
        "style": {
            "titleSize": 17,
            "metaSize": 7.5,
            "headerSize": 6.8,
            "bodySize": 7.0,
            "lineHeight": 8.2,
            "cellPadding": 4,
            "maxLinesPerCell": 3,
            "green": [0, 98, 65],
            "dark": [7, 63, 47],
            "cream": [249, 246, 239],
            "line": [221, 225, 220],
            "warning": [180, 83, 9],
        },
        "messages": {
            "disclaimer": "Este reporte es un estimado. Realiza un doble check con tu conteo físico del libro y captura en la app al finalizar el servicio.",
            "nameVariation": "El nombre Micros puede variar. Valida por Código DIA cuando el cruce no sea exacto.",
        },
        "audit": {
            "catalogRows": int(woe.get("catalogRows", 0)),
            "microsRows": int(woe.get("microsRows", 0)),
            "microsUnitsPopulated": int(woe.get("microsUnitsPopulated", 0)),
            "tableWidth": table_width,
            "printableWidth": printable_width,
            "fit": table_width == printable_width,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", default="data/import-report.json")
    parser.add_argument("--output", default="data/stock-config.js")
    args = parser.parse_args()
    config = build(Path(args.report))
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        "window.STOCK_CONFIG = "
        + json.dumps(config, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    print(json.dumps({"status": "ok", "output": str(destination), **config["audit"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
