#!/usr/bin/env python3
"""Auditoría integral y reproducible de CodeBrew PWA."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from html.parser import HTMLParser
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
PERFORMANCE_BUDGETS = {
    "index.html": 35_000,
    "styles.css": 45_000,
    "catalog.css": 30_000,
    "app.js": 125_000,
    "data/products.js": 500_000,
    "data/woe.js": 1_200_000,
    "data/merch-catalog.js": 1_000_000,
    "data/stock-config.js": 15_000,
    "data/ui-config.js": 10_000,
}
REQUIRED_SHEETS = {"Base_Campaña", "Discovery", "Homologados", "Essentials"}
OBSOLETE_ALLOWLIST = (Path("products.js"), Path("icon-512.png"), Path("VALIDACION_CORRECCION.md"))
GENERATED_TARGETS = {"data/app-audit.js", "data/app-audit.json", "data/stock-config.js", "data/ui-config.js", "data/merch-catalog.js", "data/merch-catalog-report.json"}


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


def image_is_readable(path: Path) -> bool:
    try:
        with Image.open(path) as image:
            image.verify()
        return True
    except (OSError, ValueError):
        return False


def audit(root: Path) -> dict:
    report = load_json(root / "data/import-report.json")
    catalog_report = load_json(root / "data/merch-catalog-report.json")
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
    restored_files = sorted((root / "assets/catalog/images").rglob("*.webp"))
    featured_files = sorted((root / "assets/catalog/featured").glob("*.webp"))
    engines = sorted((root / "engines/merch-lists").glob("*.xlsx"))
    visual_sources = sorted((root / "engines/visual-sources").glob("*.zip"))
    image_overrides = sorted((root / "engines/image-overrides").glob("*.*"))
    catalog_text = (root / "data/merch-catalog.js").read_text(encoding="utf-8")
    catalog_payload = json.loads(catalog_text.split("=", 1)[1].strip().rstrip(";"))
    referenced_visuals = {
        product.get("visual", {}).get("src", "")
        for product in catalog_payload.get("products", [])
        if product.get("visual", {}).get("src")
    }
    published_visuals = {
        path.relative_to(root).as_posix()
        for path in [*restored_files, *featured_files]
    }
    catalog_ok = (
        catalog_report.get("status") == "ok"
        and catalog_report.get("version") == "faithful-restoration-v4"
        and catalog_report.get("engineFiles") == len(engines) == 3
        and catalog_report.get("visualSourceFiles") == len(visual_sources) == 3
        and catalog_report.get("products", 0) > 0
        and catalog_report.get("withSourceImage", 0) > 800
        and catalog_report.get("canvasPixels", 0) >= 768
        and catalog_report.get("moneyFieldsPublished") == 0
        and '"prices"' not in catalog_text
        and catalog_report.get("atlases") == 0
        and catalog_report.get("restoredImageFiles") >= 800
        and catalog_report.get("featuredImages") == len(featured_files) >= 1
        and all(image_is_readable(path) for path in [*restored_files, *featured_files])
        and referenced_visuals == published_visuals
        and all(path.stat().st_size < 25_000_000 for path in [*engines, *visual_sources, *image_overrides, *restored_files, *featured_files])
    )
    checks.append(check(
        "Catálogo visual",
        catalog_ok,
        f"{catalog_report.get('products', 0):,} artículos, {catalog_report.get('restoredImageFiles', 0):,} fotografías restauradas individualmente y {len(featured_files)} imagen HD",
    ))
    cross_checked = sum(source.get("visualSources", {}).get("crossChecked", 0) for source in catalog_report.get("sources", []))
    premium = catalog_report.get("visualSources", {}).get("premium-override", 0)
    checks.append(check(
        "Doble auditoría visual",
        cross_checked >= 500 and premium >= 1 and catalog_report.get("visualSourceAudit"),
        f"{cross_checked:,} imágenes cotejadas Excel/HTML; {premium} reconstrucción premium verificada",
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
    ui_config_text = (root / "data/ui-config.js").read_text(encoding="utf-8")
    ui_config = json.loads(ui_config_text.split("=", 1)[1].strip().rstrip(";"))
    export_keys = [column.get("key") for column in pdf_config.get("columns", [])]
    stock_export_keys = [column.get("key") for column in stock_config.get("columns", [])]
    stock_security_ok = all(token in (root / "app.js").read_text(encoding="utf-8") for token in (
        "validateStockReading", "stockConfirmed", "signature!=='%PDF-'", "rememberConfirmedStock", "await generateStockPdf()", "detectStockLayout", "stockTokenIndex", "stockLoadToken", "stockMatchCache", "yieldToMain", "setStockBusy",
    )) and (root / "assets/stock_pdf_woe.jpeg").exists()
    export_ok = (
        pdf_config.get("audit", {}).get("fit") is True
        and pdf_config.get("page", {}).get("format") == "letter"
        and pdf_config.get("page", {}).get("orientation") == "portrait"
        and pdf_config.get("version") == "letter-portrait-v3-quantity"
        and export_keys == ["descripcionSap", "nombreMicros", "codigoDia", "idWoe", "qty"]
        and stock_config.get("audit", {}).get("fit") is True
        and stock_config.get("page", {}).get("format") == "letter"
        and stock_config.get("page", {}).get("orientation") == "portrait"
        and stock_config.get("version") == "stock-on-hand-v4-adaptive"
        and stock_config.get("parser", {}).get("adaptiveLayout") is True
        and stock_export_keys == ["codigoDia", "idWoe", "descripcionSap", "nombreMicros", "unidad", "qty", "estado"]
        and float(stock_config.get("parser", {}).get("zeroTolerance", 0)) >= 0.049
        and stock_security_ok
        and ui_config.get("version") == "operational-flow-v1"
        and len(ui_config.get("flows", {}).get("woe", [])) == 3
        and len(ui_config.get("flows", {}).get("stock", [])) == 3
    )
    checks.append(check(
        "Exportación PDF",
        export_ok,
        "WOE con piezas + Stock Premium; ambos en carta vertical y dentro del margen",
    ))
    duplicate_ids = sorted({value for value in parser.ids if parser.ids.count(value) > 1})
    required_ids = {"mainContent", "connectionStatus", "consulta", "woe", "etiquetado", "woeFlow", "woeNextAction", "woeSearch", "woeSearchClear", "catalogFilters", "catalogSummary", "catalogGrid", "catalogLoadMore", "catalogVisualDialog", "catalogVisualImage", "woeResults", "stockPanel", "stockFlow", "stockNextAction", "stockAttach", "stockPdfInput", "stockProgress", "stockExport", "stockResults", "stockConfirmDialog", "stockConfirmAccept"}
    redundant_controls = {"woeRun", "woeCopyList", "stockUploadGuideDialog", "stockUploadGuideAccept"}.intersection(parser.ids)
    app_text = (root / "app.js").read_text(encoding="utf-8")
    operational_tokens = ("ensureQrious", "persistWoeSelection", "restoreWoeSelection", "updateWoeFlow", "updateStockFlow", "renderCatalog", "openCatalogVisual", "catalogVisibleLimit", "quantity", "Añadir al conteo")
    checks.append(check(
        "Navegación e interfaz",
        not duplicate_ids and not redundant_controls and required_ids.issubset(parser.ids) and all(token in app_text for token in operational_tokens) and "qrious.min.js" not in html,
        f"{len(parser.ids)} controles con ID único, navegación por teclado y progreso accesible"
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
    sw_ok = bool(shell_refs) and not missing_shell and "Lista_Precios_Base.xlsx" not in shell_block and "navigationPreload" in sw_text and "SKIP_WAITING" in sw_text
    checks.append(check(
        "Caché y modo offline",
        sw_ok,
        f"{len(shell_refs)} recursos esenciales; Excel excluido del arranque" if sw_ok else f"Recursos faltantes: {', '.join(missing_shell)}",
    ))
    workflow_ok = all(token in workflow_update + workflow_cleanup for token in ("actions/checkout@v5", "actions/setup-python@v6")) and "engines/**" in workflow_update and "scripts/build_all.py" in workflow_update and "scripts/build_ui_config.py" in workflow_update and "scripts/generate_visual_catalog.py" in workflow_update and "data/merch-catalog.js" in workflow_update and "assets/catalog/images" in workflow_update and "assets/catalog/featured" in workflow_update and "unittest discover" in workflow_update and "scripts/cleanup_obsolete.py" in workflow_cleanup and "github.event_name == 'push'" in workflow_cleanup
    cleanup_candidates = [path.as_posix() for path in OBSOLETE_ALLOWLIST if (root / path).exists()]
    checks.append(check(
        "Workflows y obsoletos",
        workflow_ok,
        f"Actualización y limpieza protegidas; {len(cleanup_candidates)} candidatos controlados",
        warning=bool(cleanup_candidates),
    ))
    project_files = [path for path in root.rglob("*") if path.is_file() and not any(part in {".git", ".codebrew-build", "__pycache__"} for part in path.relative_to(root).parts)]
    oversized = [path.relative_to(root).as_posix() for path in project_files if path.stat().st_size >= 25_000_000]
    crowded = []
    for directory in [root, *(path for path in root.rglob("*") if path.is_dir())]:
        if any(part in {".git", ".codebrew-build", "__pycache__"} for part in directory.relative_to(root).parts):
            continue
        count = sum(child.is_file() for child in directory.iterdir())
        if count >= 100:
            crowded.append(f"{directory.relative_to(root).as_posix() or '.'} ({count})")
    checks.append(check(
        "Límites GitHub",
        not oversized and not crowded,
        "Ningún archivo alcanza 25 MB y ninguna carpeta contiene 100 archivos" if not oversized and not crowded else f"Grandes: {oversized}; carpetas: {crowded}",
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
    for item in result["checks"]:
        if item["status"] in {"error", "warning"}:
            level = "error" if item["status"] == "error" else "warning"
            print(f"::{level} title={item['name']}::{item['detail']}")
    print(json.dumps({key: result[key] for key in ("status", "checksTotal", "checksOk", "warnings", "errors")}, ensure_ascii=False))
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
