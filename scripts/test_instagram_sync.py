from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import instagram_sync


class InstagramSyncTest(unittest.TestCase):
    def test_post_id_from_url(self) -> None:
        self.assertEqual(
            instagram_sync.post_id_from_url("https://www.instagram.com/reel/ABC123/?utm_source=test"),
            "reel/ABC123",
        )

    def test_normalize_classification_rejects_unknown_ids(self) -> None:
        result = instagram_sync.normalize_classification(
            {
                "shouldUpdate": True,
                "memberId": "unknown",
                "cellId": "unknown",
                "value": "  35,000歩  ",
                "confidence": 2,
                "evidence": "  screenshot  ",
            }
        )

        self.assertIsNone(result["memberId"])
        self.assertIsNone(result["cellId"])
        self.assertEqual(result["value"], "35,000歩")
        self.assertEqual(result["confidence"], 1)

    def test_secret_setting_preserves_whitespace(self) -> None:
        with patch.dict(os.environ, {"TEST_SECRET": " secret value "}, clear=False):
            self.assertEqual(
                instagram_sync.setting("TEST_SECRET", "unused", secret=True),
                " secret value ",
            )

    def test_parse_json_body_handles_non_object(self) -> None:
        self.assertEqual(instagram_sync.parse_json_body(b"[1, 2]"), {"response": [1, 2]})


if __name__ == "__main__":
    unittest.main()
