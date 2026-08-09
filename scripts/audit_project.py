#!/usr/bin/env python3
"""Auditoría integral y reproducible de CodeBrew PWA."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PERFORMANCE_BUDGETS = {
    "index.html": 25_000,
    "styles.css": 40_000,
    "app.js": 90_000,
    "data/products.js": 500_000,
    "data/woe.js": 1_200_000,
    "data/stock-config.js": 15_000,
}
REQUIRED_SHEETS = {"Base_Campaña", "Discovery", "Homologados", "Essentials"}
OBSOLETE_ALLOWLIST = (Path("products.js"), Path("icon-512.png"))
GENERATED_TARGETS = {"data/app-audit.js", "data/app-audit.json", "data/stock-config.js"}


class HtmlAuditParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: list[str] = []
        self.references: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        attributes = dict(attrs)
        if attributes.get("id"):
            self.ids.append(attributes["id"])
        for name in ("src", "href"):
            value = attributes.get(name)
            if value:
                self.references.append(value)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def check(name: str, ok: bool, detail: str, *, warning: bool = False) -> dict:
    return {"name": name, "status": "warning" if warning and ok else ("ok" if ok else "error"), "detail": detail}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def audit(root: Path) -> dict:
    report = load_json(root / "data/import-report.json")
    manifest = load_json(root / "manifest.webmanifest")
    html = (root / "index.html").read_text(encoding="utf-8")
    parser = HtmlAuditParser()
    parser.feed(html)
    workflow_update = (root / ".github/workflows/update-price-list.yml").read_text(encoding="utf-8")
    workflow_cleanup = (root / ".github/workflows/cleanup-obsolete.yml").read_text(encoding="utf-8")
    sw_text = (root / "sw.js").read_text(encoding="utf-8")

    checks: list[dict] = []
    checks.append(check(
        "Motor Excel",
        report.get("status") == "ok" and report.get("totalValidProducts", 0) > 0,
        f"{report.get('totalValidProducts', 0):,} artículos MERCH válidos",
    ))
    present_sheets = set(report.get("sheets", {}) if isinstance(report.get("sheets"), dict) else (item.get("sheet") for item in report.get("sheets", [])))
    checks.append(check(
        "Estructura MERCH",
        REQUIRED_SHEETS.issubset(present_sheets),
        "4 pestañas operativas localizadas" if REQUIRED_SHEETS.issubset(present_sheets) else f"Faltan: {', '.join(sorted(REQUIRED_SHEETS - present_sheets))}",
    ))
    woe = report.get("woe", {})
    woe_ok = woe.get("catalogRows", 0) > 0 and woe.get("microsRows", 0) > 0 and woe.get("exactSapDuplicatesIgnored", 0) == 0
    checks.append(check(
        "Integridad WOE",
        woe_ok,
        f"{woe.get('catalogRows', 0):,} relaciones; {woe.get('operationalSapMicrosMatch', 0):,} cruces SAP + Micros",
    ))
    pdf_config_text = (root / "data/woe-pdf-config.js").read_text(encoding="utf-8")
    pdf_config = json.loads(pdf_config_text.split("=", 1)[1].strip().rstrip(";"))
    stock_config_text = (root / "data/stock-config.js").read_text(encoding="utf-8")
    stock_config = json.loads(stock_config_text.split("=", 1)[1].strip().rstrip(";"))
    export_keys = [column.get("key") for column in pdf_config.get("columns", [])]
    stock_export_keys = [column.get("key") for column in stock_config.get("columns", [])]
    export_ok = (
        pdf_config.get("audit", {}).get("fit") is True
        and pdf_config.get("page", {}).get("format") == "letter"
        and pdf_config.get("page", {}).get("orientation") == "portrait"
        and export_keys == ["descripcionSap", "nombreMicros", "codigoDia", "idWoe"]
        and stock_config.get("audit", {}).get("fit") is True
        and stock_config.get("page", {}).get("format") == "letter"
        and stock_config.get("page", {}).get("orientation") == "portrait"
        and stock_export_keys == ["codigoDia", "idWoe", "descripcionSap", "nombreMicros", "unidad", "qty"]
    )
    checks.append(check(
        "Exportación PDF",
        export_ok,
        f"WOE 4 columnas + Stock 6 columnas; ambos en carta vertical",
    ))
    duplicate_ids = sorted({value for value in parser.ids if parser.ids.count(value) > 1})
    required_ids = {"consulta", "woe", "etiquetado", "woeSearch", "woeResults", "stockPdfInput", "stockExport", "stockResults"}
    redundant_controls = {"woeRun", "woeCopyList"}.intersection(parser.ids)
    checks.append(check(
        "Navegación e interfaz",
        not duplicate_ids and not redundant_controls and required_ids.issubset(parser.ids),
        f"{len(parser.ids)} controles con ID único y sin acciones redundantes"
        if not duplicate_ids and not redundant_controls
        else f"Revisar controles: {', '.join(sorted(set(duplicate_ids) | redundant_controls))}",
    ))
    local_refs = [value.split("?", 1)[0] for value in parser.references if not re.match(r"^(?:https?:|mailto:|tel:|#)", value)]
    missing_refs = sorted(value for value in set(local_refs) if value and value.lstrip("./") not in GENERATED_TARGETS and not (root / value.lstrip("./")).exists())
    checks.append(check(
        "Referencias locales",
        not missing_refs,
        "Todos los recursos HTML existen" if not missing_refs else f"Faltan: {', '.join(missing_refs)}",
    ))
    icon_paths = [root / str(icon.get("src", "")).lstrip("./") for icon in manifest.get("icons", [])]
    pwa_ok = manifest.get("display") == "standalone" and manifest.get("start_url") == "./" and icon_paths and all(path.exists() for path in icon_paths)
    checks.append(check(
        "Manifest PWA",
        bool(pwa_ok),
        f"{len(icon_paths)} iconos y modo instalable",
    ))
    shell_block = sw_text.split("const APP_SHELL = [", 1)[1].split("];", 1)[0] if "const APP_SHELL = [" in sw_text else ""
    shell_refs = re.findall(r"['\"](\./[^'\"]+)['\"]", shell_block)
    missing_shell = [value for value in shell_refs if value != "./" and value[2:] not in GENERATED_TARGETS and not (root / value[2:]).exists()]
    sw_ok = bool(shell_refs) and not missing_shell and "Lista_Precios_Base.xlsx" not in shell_block
    checks.append(check(
        "Caché y modo offline",
        sw_ok,
        f"{len(shell_refs)} recursos esenciales; Excel excluido del arranque" if sw_ok else f"Recursos faltantes: {', '.join(missing_shell)}",
    ))
    workflow_ok = all(token in workflow_update + workflow_cleanup for token in ("actions/checkout@v5", "actions/setup-python@v6")) and "scripts/build_all.py" in workflow_update and "data/stock-config.js" in workflow_update and "scripts/cleanup_obsolete.py" in workflow_cleanup
    cleanup_candidates = [path.as_posix() for path in OBSOLETE_ALLOWLIST if (root / path).exists()]
    checks.append(check(
        "Workflows y obsoletos",
        workflow_ok,
        f"Actualización y limpieza protegidas; {len(cleanup_candidates)} candidatos controlados",
        warning=bool(cleanup_candidates),
    ))
    sizes = {path: (root / path).stat().st_size for path in PERFORMANCE_BUDGETS}
    over_budget = {path: size for path, size in sizes.items() if size > PERFORMANCE_BUDGETS[path]}
    checks.append(check(
        "Presupuesto de rendimiento",
        not over_budget,
        f"{sum(sizes.values()) / 1024:.0f} KB auditados en archivos críticos" if not over_budget else "Fuera de presupuesto: " + ", ".join(over_budget),
    ))

    errors = sum(item["status"] == "error" for item in checks)
    warnings = sum(item["status"] == "warning" for item in checks)
    return {
        "status": "ok" if not errors else "error",
        "auditedAtUtc": report.get("sourceModifiedAtUtc") or report.get("generatedAtUtc") or "unknown",
        "sourceFile": report.get("sourceFile", "Lista_Precios_Base.xlsx"),
        "sourceSha256": sha256(root / "Lista_Precios_Base.xlsx"),
        "checksTotal": len(checks),
        "checksOk": sum(item["status"] == "ok" for item in checks),
        "warnings": warnings,
        "errors": errors,
        "checks": checks,
        "performance": {"sizes": sizes, "budgets": PERFORMANCE_BUDGETS},
        "cleanupCandidates": cleanup_candidates,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, default=Path("data/app-audit.json"))
    parser.add_argument("--js-output", type=Path, default=Path("data/app-audit.js"))
    args = parser.parse_args()
    root = args.root.resolve()
    result = audit(root)
    output = args.output if args.output.is_absolute() else root / args.output
    js_output = args.js_output if args.js_output.is_absolute() else root / args.js_output
    output.parent.mkdir(parents=True, exist_ok=True)
    js_output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    js_output.write_text("window.APP_AUDIT = " + json.dumps(result, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in ("status", "checksTotal", "checksOk", "warnings", "errors")}, ensure_ascii=False))
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
