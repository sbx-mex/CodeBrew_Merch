import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PosExcelAuthorityTests(unittest.TestCase):
    def test_runtime_has_no_mirror_patch(self):
        text = "\n".join((ROOT / name).read_text(encoding="utf-8") for name in ("app.js", "index.html", "sw.js"))
        self.assertNotIn("POS_MIRROR", text)
        self.assertNotIn("SKU POS · ESPEJO", text)
        self.assertNotIn("pos-operational-overrides.js", text)

    def test_pos_validation_report_is_ok(self):
        report = json.loads((ROOT / "data/pos-excel-validation.json").read_text(encoding="utf-8"))
        self.assertTrue(report["ok"])
        self.assertEqual(report["mismatches"], [])
        self.assertEqual(report["missingSkuPos"], [])
        self.assertEqual(report["forbiddenRuntimeOverrides"], [])




if __name__ == "__main__":
    unittest.main()
