"""Pruebas de contrato para motores Excel y catálogo visual."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from PIL import Image


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
        self.assertEqual(self.catalog["meta"]["visualSourceFiles"], 3)
        self.assertEqual(len(list((ROOT / "engines/merch-lists").glob("*.xlsx"))), 3)
        self.assertEqual(len(list((ROOT / "engines/visual-sources").glob("*.zip"))), 3)

    def test_stable_article_keys_are_unique(self) -> None:
        keys = [product["articleKey"] for product in self.products]
        self.assertTrue(keys)
        self.assertEqual(len(keys), len(set(keys)))
        self.assertTrue(all(key.startswith("dia-") and "--pos-" in key for key in keys))

    def test_every_product_has_operational_fields_and_clean_visual_state(self) -> None:
        for product in self.products:
            self.assertTrue(product["codigoDia"])
            self.assertTrue(product["displayName"])
            self.assertTrue(product["nameKey"])
            self.assertNotIn("prices", product)
            self.assertIsNone(product.get("visual"))
            self.assertEqual(product.get("visualSource"), "pending-upload")
            self.assertIn(product.get("stockPriority"), {"active", "secondary"})

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

    def test_catalog_image_directories_are_clean(self) -> None:
        restored = list((ROOT / "assets/catalog/images").rglob("*.webp")) if (ROOT / "assets/catalog/images").exists() else []
        featured = list((ROOT / "assets/catalog/featured").glob("*.webp")) if (ROOT / "assets/catalog/featured").exists() else []
        self.assertEqual(restored, [])
        self.assertEqual(featured, [])
        self.assertEqual(self.catalog["meta"].get("imageMode"), "clean-reset")

    def test_interface_contains_catalog_and_quantity_contract(self) -> None:
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        for token in ("modeMenu", "modeBack", "data-app-mode=\"catalog\"", "data-app-mode=\"merch\"", "data-app-mode=\"export\"", "catalogGrid", "catalogFilters", "catalogLoadMore", "catalogVisualDialog", "microsCatalogResults", "merch-catalog.js"):
            self.assertIn(token, html)
        self.assertNotIn("microsGroupFilter", html)
        self.assertNotIn("microsFamilyFilter", html)
        self.assertIn("catalogVisibleLimit = 5", app)
        self.assertIn("Diseñado por Jorge Alcantar Aguiar & Enrique César Flores", app)
        self.assertIn("exportStockExcel", app)
        self.assertIn("stockConfirmExcel", html)
        self.assertIn("Catálogo General", html)
        for token in ("renderCatalog", "selectAppMode", "showHome", "articleKey", "quantity", "Código Día", "Código SAP", "label:'CONTEO'", "'Conteo'"):
            self.assertIn(token, app)
        self.assertNotIn("catalogPrice", app)
        self.assertNotIn("Agregar · $", app)

    def test_stock_priority_and_visual_reset(self) -> None:
        active = [product for product in self.products if product.get("stockPriority") == "active"]
        secondary = [product for product in self.products if product.get("stockPriority") == "secondary"]
        self.assertTrue(active)
        self.assertTrue(secondary)
        self.assertEqual(self.catalog["meta"].get("activeStockProducts"), len(active))
        self.assertEqual(self.catalog["meta"].get("secondaryProducts"), len(secondary))
        first_secondary = next((i for i, product in enumerate(self.products) if product.get("stockPriority") == "secondary"), len(self.products))
        self.assertTrue(all(product.get("stockPriority") == "active" for product in self.products[:first_secondary]))
        self.assertTrue(all(product.get("visual") is None for product in self.products))


if __name__ == "__main__":
    unittest.main()
