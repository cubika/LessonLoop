"""Installer recovery uses synthetic bundles and never starts a database."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(os.name == "nt", "Windows installer")
class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lessonloop-installer-")
        self.addCleanup(self.temporary.cleanup)
        self.fixture = Path(self.temporary.name)
        self.bundle = self.fixture / "bundle"
        self.program = self.fixture / "安装 program"
        self.data = self.fixture / "数据 data"
        files = []
        for name in ("python/python.exe", "node/node.exe", "distribution/runtime.py", "distribution/launcher.ps1",
                     "distribution/check_runtime.py", "dist/cli/main.js", "config/components.json"):
            path = self.bundle / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"synthetic bytes; never execute")
            files.append({"path": name, "size": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        manifest = {"platform": "win32-x64", "version": "fixture-alpha.1", "channel": "alpha", "alphaReady": True, "files": files}
        self.save(self.bundle / "manifest.json", manifest)
        self.digest = hashlib.sha256((self.bundle / "manifest.json").read_bytes()).hexdigest()
        self.record = {"installationId": "isolated-fixture", "programRoot": str(self.program), "runtimeRoot": str(self.program),
                       "dataRoot": str(self.data), "setupState": "ready", "manifestDigest": self.digest}
        self.save(self.data / "installation.json", self.record)

    def save(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def install(self):
        script = Path(__file__).resolve().parents[1] / "distribution/install.ps1"
        return subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script),
            "-Bundle", str(self.bundle), "-InstallRoot", str(self.program), "-DataRoot", str(self.data)],
            capture_output=True, encoding="utf-8", errors="replace")

    def test_reinstall_preserves_ready_data_and_repeated_install_is_idempotent(self):
        (self.data / "preserved.txt").write_text("existing user data")
        result = self.install()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertTrue((self.program / "active.json").exists())
        self.assertFalse((self.program / "install-state.json").exists())
        self.assertEqual((self.data / "preserved.txt").read_text(), "existing user data")
        result = self.install()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("already installed", result.stdout)

    def test_same_bundle_resumes_an_owned_interrupted_copy(self):
        self.save(self.program / "install-state.json", {"programRoot": str(self.program), "dataRoot": str(self.data),
            "manifestDigest": self.digest, "installationId": self.record["installationId"]})
        (self.program / "node").mkdir()
        (self.program / "node/node.exe").write_bytes(b"partial copy")
        result = self.install()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual((self.program / "node/node.exe").read_bytes(), (self.bundle / "node/node.exe").read_bytes())
        self.assertFalse((self.program / "install-state.json").exists())

    def test_different_bundle_does_not_touch_existing_data(self):
        self.save(self.data / "installation.json", {**self.record, "manifestDigest": "other-version"})
        before = (self.data / "installation.json").read_bytes()
        result = self.install()
        self.assertNotEqual(result.returncode, 2)
        self.assertIn("same bundle", result.stderr)
        self.assertFalse(self.program.exists())
        self.assertEqual((self.data / "installation.json").read_bytes(), before)

    def test_unowned_existing_program_directory_is_never_overwritten(self):
        self.program.mkdir()
        (self.program / "user.txt").write_text("keep")
        result = self.install()
        self.assertNotEqual(result.returncode, 2)
        self.assertEqual((self.program / "user.txt").read_text(), "keep")
        self.assertFalse((self.program / "python").exists())

    def test_tampered_bundle_is_rejected_before_program_creation(self):
        (self.bundle / "python/python.exe").write_bytes(b"tampered")
        result = self.install()
        self.assertNotEqual(result.returncode, 2)
        self.assertRegex(result.stderr, r"hash\s+mismatch")
        self.assertFalse(self.program.exists())

    def test_system_reuse_reinstall_repairs_missing_environment(self):
        base = str(Path(sys._base_executable).resolve())
        quote = lambda value: "'" + str(value).replace("'", "''") + "'"
        dependency_script = "function Resolve-LessonLoopDependencies { param($PythonPath,$NodePath,$PostgresPath,[switch]$NonInteractive) "
        dependency_script += f"[pscustomobject]@{{PythonExe={quote(base)};NodeExe=$NodePath;PostgresPath=$PostgresPath;PostgresNeedsComponent=$false}} }}"
        environment_script = "import argparse\nfrom pathlib import Path\np=argparse.ArgumentParser();p.add_argument('--python');p.add_argument('--runtime');a=p.parse_args()\n"
        environment_script += "target=Path(a.runtime)/'.venv/Scripts/python.exe';target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'repaired fixture')\n"
        for name, content in [("distribution/dependencies.ps1", dependency_script),
                ("distribution/python_environment.py", environment_script), ("config/python-requirements.txt", "")]:
            path = self.bundle / name
            path.write_text(content, encoding="utf-8")
        manifest = json.loads((self.bundle / "manifest.json").read_text())
        manifest["runtimePolicy"] = "system_reuse"
        manifest["files"] = [{"path": path.relative_to(self.bundle).as_posix(), "size": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in self.bundle.rglob("*") if path.is_file() and path.name != "manifest.json"]
        self.save(self.bundle / "manifest.json", manifest)
        digest = hashlib.sha256((self.bundle / "manifest.json").read_bytes()).hexdigest()
        self.record.update(manifestDigest=digest, pythonBase=base, runtimeExecutables={
            "python": str(self.program / ".venv/Scripts/python.exe"), "node": str(self.fixture / "node.exe"), "postgres": str(self.fixture / "postgres")})
        self.save(self.data / "installation.json", self.record)
        first = self.install()
        self.assertEqual(first.returncode, 2, first.stdout + first.stderr)
        executable = self.program / ".venv/Scripts/python.exe"
        executable.unlink()
        second = self.install()
        self.assertEqual(second.returncode, 2, second.stdout + second.stderr)
        self.assertEqual(executable.read_bytes(), b"repaired fixture")


if __name__ == "__main__":
    unittest.main()
