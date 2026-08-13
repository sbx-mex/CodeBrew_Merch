"""Pruebas de contrato para motores Excel y catálogo visual."""

from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_catalog() -> dict:
    text = (ROOT / "data/merch-catalog.js").read_text(encoding="utf-8")
    return json.loads(text.split("=", 1)[1].strip().rstrip(";"))


class VisualCatalogContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = load_catalog()
        cls.products = cls.catalog["products"]

    def test_three_independent_engines_are_reported(self) -> None:
        self.assertEqual(self.catalog["meta"]["engineFiles"], 3)
        self.assertEqual(len(list((ROOT / "engines/merch-lists").glob("*.xlsx"))), 3)

    def test_stable_article_keys_are_unique(self) -> None:
        keys = [product["articleKey"] for product in self.products]
        self.assertTrue(keys)
        self.assertEqual(len(keys), len(set(keys)))
        self.assertTrue(all(key.startswith("dia-") and "--pos-" in key for key in keys))

    def test_every_product_has_operational_fields_and_visual(self) -> None:
        for product in self.products:
            self.assertTrue(product["codigoDia"])
            self.assertTrue(product["displayName"])
            self.assertTrue(product["nameKey"])
            atlas = ROOT / product["visual"]["atlas"]
            self.assertTrue(atlas.is_file(), atlas)
            self.assertLess(atlas.stat().st_size, 25_000_000)

    def test_github_limits_are_respected(self) -> None:
        excluded = {".git", ".codebrew-build", "__pycache__"}
        for path in ROOT.rglob("*"):
            relative = path.relative_to(ROOT)
            if any(part in excluded for part in relative.parts):
                continue
            if path.is_file():
                self.assertLess(path.stat().st_size, 25_000_000, relative.as_posix())
            elif path.is_dir():
                self.assertLess(sum(child.is_file() for child in path.iterdir()), 100, relative.as_posix())

    def test_interface_contains_catalog_and_quantity_contract(self) -> None:
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        for token in ("catalogGrid", "catalogFilters", "catalogVisualDialog", "merch-catalog.js"):
            self.assertIn(token, html)
        for token in ("renderCatalog", "articleKey", "quantity", "Código Día", "Código SAP"):
            self.assertIn(token, app)


if __name__ == "__main__":
    unittest.main()
