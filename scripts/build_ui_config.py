#!/usr/bin/env python3
"""Genera el flujo operativo que consume la interfaz sin duplicar datos del Excel."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", default="data/import-report.json")
    parser.add_argument("--output", default="data/ui-config.js")
    args = parser.parse_args()
    report_path = Path(args.report)
    if not report_path.is_absolute():
        report_path = ROOT / report_path
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("status") != "ok":
        raise ValueError("El reporte del motor Excel no está validado.")

    woe = report.get("woe", {})
    config = {
        "version": "operational-flow-v1",
        "catalogRows": int(woe.get("catalogRows", 0)),
        "validProducts": int(report.get("totalValidProducts", 0)),
        "flows": {
            "woe": [
                {"id": "search", "label": "Busca"},
                {"id": "select", "label": "Agrega"},
                {"id": "export", "label": "Exporta"},
            ],
            "stock": [
                {"id": "attach", "label": "Adjunta"},
                {"id": "review", "label": "Confirma"},
                {"id": "export", "label": "Exporta"},
            ],
        },
        "messages": {
            "woeEmpty": "Empieza con WOE, DIA, nombre o SKU.",
            "woeReady": "Listado listo para validar y exportar.",
            "stockEmpty": "Adjunta el Stock on Hand más actual.",
            "stockReady": "Lectura lista para confirmar y exportar.",
        },
    }
    output = Path(args.output)
    if not output.is_absolute():
        output = ROOT / output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        "window.UI_CONFIG = " + json.dumps(config, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(json.dumps({"status": "ok", "output": str(output), "catalogRows": config["catalogRows"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
