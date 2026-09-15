import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "distribution"))
import python_environment as environment


class PythonEnvironmentTests(unittest.TestCase):
    def test_pip_settings_cannot_redirect_installation_outside_venv(self):
        with patch.dict(os.environ, {"PIP_TARGET": "C:/outside", "PIP_PREFIX": "C:/outside", "PIP_USER": "1",
                "PIP_CONFIG_FILE": "C:/custom.ini", "HTTPS_PROXY": "http://proxy.example"}, clear=True):
            result = environment.package_environment()
        self.assertEqual({key: value for key, value in result.items() if key.startswith("PIP_")}, {"PIP_CONFIG_FILE": os.devnull})
        self.assertEqual(result["HTTPS_PROXY"], "http://proxy.example")

    def test_damaged_owned_environment_is_repaired_and_missing_pip_bootstrapped(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory).resolve()
            base = Path(sys._base_executable).resolve()
            venv = runtime / ".venv"
            executable = venv / "Scripts/python.exe"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"fixture; never executed")
            (venv / "pyvenv.cfg").write_text("home = " + str(base.parent))
            requirements = runtime / "config/python-requirements.txt"
            requirements.parent.mkdir()
            requirements.write_text("fixture==1.0\n")
            (venv / "lessonloop-environment.json").write_text(json.dumps({"basePython": str(base),
                "baseVersion": [3, 11, 13], "requirementsSha256": hashlib.sha256(requirements.read_bytes()).hexdigest()}))
            commands = []
            def run(command, **kwargs):
                commands.append(command)
                return subprocess.CompletedProcess(command, 1 if command[-2:] == ["pip", "--version"] else 0)
            with patch.object(environment, "probe_python", return_value={"version": [3, 11, 13], "executable": str(base)}), \
                 patch.object(environment, "check_packages", side_effect=[RuntimeError("package missing"), {"prefix": str(venv)}]), \
                 patch.object(environment.subprocess, "run", side_effect=run):
                self.assertEqual(environment.prepare_environment(base, runtime), executable)
            self.assertTrue(any(command[-2:] == ["ensurepip", "--upgrade"] for command in commands))
            self.assertTrue(any("--force-reinstall" in command and "install" in command for command in commands))
            executable.unlink()
            commands.clear()
            with patch.object(environment, "probe_python", return_value={"version": [3, 11, 13], "executable": str(base)}), \
                 patch.object(environment, "check_packages", return_value={"prefix": str(venv)}), \
                 patch.object(environment.subprocess, "run", side_effect=run):
                self.assertEqual(environment.prepare_environment(base, runtime), executable)
            self.assertTrue(any(command[-2:] == ["venv", str(venv)] for command in commands))


if __name__ == "__main__":
    unittest.main()
