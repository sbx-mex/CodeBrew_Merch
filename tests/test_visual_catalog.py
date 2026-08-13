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

    def test_every_product_has_operational_fields_and_visual(self) -> None:
        for product in self.products:
            self.assertTrue(product["codigoDia"])
            self.assertTrue(product["displayName"])
            self.assertTrue(product["nameKey"])
            self.assertNotIn("prices", product)
            visual = product["visual"]
            asset = ROOT / (visual["src"] if visual.get("type") == "direct" else visual["atlas"])
            self.assertTrue(asset.is_file(), asset)
            self.assertLess(asset.stat().st_size, 25_000_000)

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

    def test_every_published_webp_is_readable_and_uniform(self) -> None:
        restored = list((ROOT / "assets/catalog/images").rglob("*.webp"))
        images = restored + list((ROOT / "assets/catalog/featured").glob("*.webp"))
        self.assertTrue(images)
        for path in images:
            with Image.open(path) as image:
                image.verify()
                if path in restored:
                    self.assertEqual(image.size, (768, 768), path)

    def test_interface_contains_catalog_and_quantity_contract(self) -> None:
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        for token in ("catalogGrid", "catalogFilters", "catalogLoadMore", "catalogVisualDialog", "microsGroupFilter", "microsFamilyFilter", "microsCatalogResults", "merch-catalog.js"):
            self.assertIn(token, html)
        self.assertIn("catalogVisibleLimit = 5", app)
        self.assertIn("Diseñado por Jorge Alcantar Aguiar & Enrique César Flores", app)
        for token in ("renderCatalog", "articleKey", "quantity", "Código Día", "Código SAP"):
            self.assertIn(token, app)
        self.assertNotIn("catalogPrice", app)
        self.assertNotIn("Agregar · $", app)

    def test_double_image_audit_and_premium_override(self) -> None:
        meta = self.catalog["meta"]
        cross_checked = sum(source["visualSources"].get("crossChecked", 0) for source in meta["sources"])
        self.assertGreaterEqual(meta["withSourceImage"], 800)
        self.assertGreaterEqual(cross_checked, 500)
        item = next(product for product in self.products if product["codigoDia"] == "16999")
        self.assertEqual(item["visualSource"], "premium-override")
        self.assertEqual(item["visual"]["type"], "direct")
        self.assertGreaterEqual(item["visual"]["width"], 1000)
        self.assertGreaterEqual(item["visual"]["height"], 1000)
        self.assertGreaterEqual(self.catalog["meta"]["canvasPixels"], 768)

    def test_all_source_photos_are_individual_restorations(self) -> None:
        meta = self.catalog["meta"]
        self.assertEqual(meta["atlases"], 0)
        self.assertGreaterEqual(meta["restoredImageFiles"], 800)
        self.assertGreaterEqual(meta["restorationAudit"]["restored"], meta["restoredImageFiles"])
        self.assertEqual(meta["restorationAudit"]["published"], meta["restoredImageFiles"])
        for product in self.products:
            self.assertEqual(product["visual"]["type"], "direct")
            self.assertIn("src", product["visual"])

    def test_no_orphan_or_duplicate_published_images(self) -> None:
        referenced = {product["visual"]["src"] for product in self.products}
        published = {
            path.relative_to(ROOT).as_posix()
            for path in [*(ROOT / "assets/catalog/images").rglob("*.webp"), *(ROOT / "assets/catalog/featured").glob("*.webp")]
        }
        self.assertEqual(referenced, published)


if __name__ == "__main__":
    unittest.main()
