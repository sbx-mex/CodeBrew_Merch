#!/usr/bin/env python3
"""Instala el lote corregido sobre la raíz de CodeBrew_Merch y lo valida."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


PACKAGE = Path(__file__).resolve().parent
PAYLOAD = PACKAGE / "actualizacion"
OBSOLETE = (
    "assets/catalog/images/lote-02/16889.webp",
    "assets/catalog/images/lote-02/16972.webp",
    "assets/catalog/images/lote-02/16990.webp",
    "assets/catalog/images/lote-02/17336.webp",
    "assets/catalog/images/lote-02/17337.webp",
    "assets/catalog/images/lote-02/17338.webp",
)


def main() -> int:
    target = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else Path.cwd().resolve()
    if not (target / "app.js").is_file() or not (target / "scripts").is_dir():
        raise SystemExit("Indica la raíz de CodeBrew_Merch: python aplicar_actualizacion.py /ruta/CodeBrew_Merch")
    copied = 0
    for source in sorted(path for path in PAYLOAD.rglob("*") if path.is_file()):
        destination = target / source.relative_to(PAYLOAD)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        copied += 1
    removed = 0
    for relative in OBSOLETE:
        path = target / relative
        if path.is_file():
            path.unlink()
            removed += 1
    subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
        cwd=target,
        check=True,
    )
    subprocess.run([sys.executable, "scripts/audit_project.py"], cwd=target, check=True)
    print(f"Actualización aplicada: {copied} archivos copiados, {removed} obsoletos eliminados, auditoría correcta.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
