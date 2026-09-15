"""Bundled runtime policy and tested-host reporting; no services or models."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).parents[1] / "distribution"))
from integration import compatibility_report, private_environment

class CompatibilityTests(unittest.TestCase):
    def test_private_runtimes_ignore_unrelated_python_and_node_loading_settings(self):
        source = {"PYTHONHOME": "python-3.9", "PythonPath": "conda-packages",
                  "PYTHONUSERBASE": "user-packages", "NODE_OPTIONS": "--require=unrelated.js",
                  "NODE_PATH": "node-18", "VIRTUAL_ENV": "venv", "CONDA_PREFIX": "conda",
                  "PATH": "system-path", "GH_TOKEN": "fixture-token", "HTTPS_PROXY": "fixture-proxy"}
        actual = private_environment(source)
        self.assertEqual(actual, {"PATH": "system-path", "GH_TOKEN": "fixture-token", "HTTPS_PROXY": "fixture-proxy",
                                  "PYTHONNOUSERSITE": "1", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
        self.assertIn("PYTHONHOME", source)

    def test_host_matrix_reports_observed_tested_and_untested_without_inventing_support(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / "config").mkdir()
            values = json.loads((Path(__file__).parents[1] / "config/components.json").read_text())
            (root / "config/components.json").write_text(json.dumps(values))
            tested = compatibility_report(root, "GitHub Copilot CLI 1.0.84-6.\nRun copilot update.")
            self.assertEqual(tested["copilotCli"]["status"], "tested")
            self.assertEqual(tested["systemPythonNodePostgres"], "selected_at_installation")
            self.assertEqual(tested["runtimePolicy"], "system_reuse")
            self.assertEqual(tested["minimumVersions"]["python"], "3.11.0")
            self.assertEqual(tested["testedVersions"]["python"], "3.12.11")
            other = compatibility_report(root, "GitHub Copilot CLI 1.0.99-1")
            self.assertEqual(other["copilotCli"]["status"], "untested")
            self.assertEqual(other["copilotCli"]["observed"], "1.0.99-1")
            self.assertEqual(compatibility_report(root, None)["copilotCli"]["status"], "unknown")

if __name__ == "__main__": unittest.main()
