import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / "evals/lib/copilot-complete.py"
spec = importlib.util.spec_from_file_location("evaluation_provider", source)
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)

class DiagnosticsTest(unittest.TestCase):
    def test_credentials_and_user_paths_are_redacted(self):
        with patch.dict(os.environ, {"GH_TOKEN": "secret-test-value", "USERPROFILE": "C:/Users/test-person"}):
            result = provider.diagnostic(RuntimeError("Authentication failed for Bearer extra-secret secret-test-value in C:/Users/test-person/cache https://local.example/path?token=secret-test-value"))
        self.assertEqual(result["error"], "authentication")
        self.assertNotIn("secret-test-value", result["message"])
        self.assertNotIn("extra-secret", result["message"])
        self.assertNotIn("test-person", result["message"])
        self.assertNotIn("https://", result["message"])

    def test_permission_is_distinct_from_missing_runtime(self):
        self.assertEqual(provider.diagnostic(PermissionError("WinError 5 access is denied"))["error"], "permission")
        self.assertEqual(provider.diagnostic(FileNotFoundError("COPILOT_CLI_PATH is missing"))["error"], "runtime_missing")

if __name__ == "__main__":
    unittest.main()
