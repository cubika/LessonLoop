import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


package = load_module("package_release", ROOT / "distribution/package-release.py")
audit = load_module("check_alpha_bundle", ROOT / "scripts/check-alpha-bundle.py")


def write(root, name, content="fixture"):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


class PackagingTests(unittest.TestCase):
    def fixture(self, root):
        repo, base, reranker = root / "repo", root / "base", root / "reranker"
        for name in package.REQUIRED_PRODUCT_FILES:
            write(repo, name)
        components = {"hindsight": "0.9.2", "postgresql": "18.1.0", "pgvector": "0.8.5"}
        write(repo, "config/components.json", json.dumps(components))
        write(repo, "config/python-requirements.txt", "hindsight-api-slim==0.9.2\n")
        for name in ["package.json", "package-lock.json"]:
            write(repo, name, "{}")
        for name in ["docs/14-alpha-release.md", "docs/15-runtime-compatibility.md"]:
            write(repo, name)
        for name in ["models/e5/onnx/model.onnx", "models/e5/tokenizer.json", "models/e5/config.json",
                     "models/e5/tokenizer_config.json", "models/e5/special_tokens_map.json", "python/python.exe",
                     "python/Lib/site-packages/hindsight_api/alembic/versions/initial.py",
                     "node/node.exe", "postgres/bin/postgres.exe"]:
            write(base, name)
        for name in ["models/reranker/pinned/model.onnx", "third-party/flashrank/flashrank/Ranker.py",
                     "third-party/flashrank/LICENSE"]:
            write(reranker, name)
        return repo, base, reranker

    @staticmethod
    def run_command(command, **kwargs):
        if command[0] == "npm.cmd":
            write(Path(kwargs["cwd"]), "node_modules/@vectorize-io/hindsight-client/index.js")
            return subprocess.CompletedProcess(command, 0)
        if command[:3] == ["git", "rev-parse", "HEAD"]:
            return subprocess.CompletedProcess(command, 0, stdout="a" * 40 + "\n")
        raise AssertionError("Unexpected process: " + str(command))

    def build_fixture(self, directory, archive=False):
        root = Path(directory)
        repo, base, reranker = self.fixture(root)
        output = root / "output"
        args = ["package-release.py", "--output", str(output), "--base", str(base), "--reranker", str(reranker)]
        if archive:
            args += ["--archive", str(root / "product.zip")]
        fake_reranker = types.SimpleNamespace(configuration=lambda _: {"status": "ready"})
        with patch.object(package, "ROOT", repo), patch.object(sys, "argv", args), \
             patch.dict(sys.modules, {"reranker": fake_reranker}), \
             patch.object(package.subprocess, "run", side_effect=self.run_command):
            package.main()
        return output

    def test_main_package_excludes_models_and_runtimes_and_pins_model_downloads(self):
        with tempfile.TemporaryDirectory() as directory:
            output = self.build_fixture(directory, archive=True)
            manifest = audit.audit_files(output)
            self.assertEqual(manifest["version"], "0.1.0-alpha.2")
            self.assertEqual(manifest["runtimePolicy"], "system_reuse")
            self.assertEqual(manifest["minimumVersions"], package.MINIMUM_VERSIONS)
            for name in ["python", "node", "postgres", "models"]:
                self.assertFalse((output / name).exists())
            for name in ["node_modules/@vectorize-io/hindsight-client/index.js",
                         "third-party/flashrank/flashrank/Ranker.py", "third-party/hindsight-LICENSE",
                         "config/python-requirements.txt"]:
                self.assertTrue((output / name).is_file(), name)
            self.assertEqual(manifest["modelPolicy"], "download_on_install")
            self.assertEqual({model["name"] for model in manifest["modelComponents"]}, {"e5", "reranker"})
            for model in manifest["modelComponents"]:
                archive = Path(directory) / "output-model-assets" / model["archive"]
                self.assertEqual(package.sha(archive), model["sha256"])
                with zipfile.ZipFile(archive) as zipped:
                    self.assertEqual(set(zipped.namelist()), {item["path"] for item in model["files"]})
            self.assertFalse(any("alembic/versions" in item["path"] for item in manifest["files"]))
            with zipfile.ZipFile(Path(directory) / "product.zip") as archive:
                self.assertEqual(set(archive.namelist()), {item["path"] for item in manifest["files"]} | {"manifest.json"})

    def test_runtime_injection_and_missing_install_dependency_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            output = self.build_fixture(directory)
            write(output, "python/python.exe")
            with self.assertRaisesRegex(RuntimeError, "runtime components"):
                package.manifest(output, "0.1.0-alpha.2")
            (output / "python/python.exe").unlink()
            (output / "config/python-requirements.txt").unlink()
            with self.assertRaisesRegex(RuntimeError, "Required product file"):
                package.manifest(output, "0.1.0-alpha.2")

    def test_each_release_uses_fresh_code_and_installs_its_locked_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, base, reranker = self.fixture(root)
            retired = write(repo, "dist/retired.js", "retired module")
            commands = []

            def dependency(version):
                write(repo, "package.json", json.dumps({"dependencies": {"fixture-dependency": version}}))
                write(repo, "package-lock.json", json.dumps({"lockfileVersion": 3,
                    "packages": {"node_modules/fixture-dependency": {"version": version}}}))

            def run(command, **kwargs):
                commands.append(command)
                if command[0] == "npm.cmd":
                    output = Path(kwargs["cwd"])
                    locked = json.loads((output / "package-lock.json").read_text())["packages"]
                    write(output, "node_modules/fixture-dependency/package.json",
                          json.dumps(locked["node_modules/fixture-dependency"]))
                return self.run_command(command, **kwargs)

            def build(output, *flags):
                args = ["package-release.py", "--output", str(output), "--base", str(base), "--reranker", str(reranker), *flags]
                with patch.object(sys, "argv", args):
                    package.main()

            fake_reranker = types.SimpleNamespace(configuration=lambda _: {"status": "ready"})
            with patch.object(package, "ROOT", repo), patch.dict(sys.modules, {"reranker": fake_reranker}), \
                 patch.object(package.subprocess, "run", side_effect=run):
                dependency("1.0.0")
                previous = root / "previous"
                build(previous)
                retired.unlink()
                dependency("2.0.0")
                with patch.object(sys, "stderr", io.StringIO()), self.assertRaises(SystemExit) as rejected:
                    build(previous, "--refresh-code")
                self.assertEqual(rejected.exception.code, 2)
                with self.assertRaisesRegex(RuntimeError, "new output directory"):
                    build(previous)
                current = root / "current"
                build(current)

            manifest = audit.audit_files(current)
            self.assertFalse((current / "dist/retired.js").exists())
            self.assertNotIn("dist/retired.js", {item["path"] for item in manifest["files"]})
            self.assertTrue((previous / "dist/retired.js").is_file())
            self.assertEqual(json.loads((previous / "node_modules/fixture-dependency/package.json").read_text())["version"], "1.0.0")
            self.assertEqual(json.loads((current / "node_modules/fixture-dependency/package.json").read_text())["version"], "2.0.0")
            self.assertEqual((current / "package-lock.json").read_bytes(), (repo / "package-lock.json").read_bytes())
            installs = [command for command in commands if command[0] == "npm.cmd"]
            self.assertEqual(len(installs), 2)
            self.assertTrue(all(command[1:3] == ["ci", "--omit=dev"] for command in installs))

    def test_existing_published_archive_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = write(root, "alpha.1.zip", "published bytes")
            with self.assertRaisesRegex(RuntimeError, "not be overwritten"):
                package.archive_files(archive, [])
            self.assertEqual(archive.read_text(), "published bytes")

    def test_complete_release_uses_install_ps1_and_checksums_every_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = self.build_fixture(directory)
            write(output, "distribution/bootstrap.ps1", '$version="0.1.0-alpha.1"\n')
            def postgres(source, target, components):
                return package.archive_files(target, [])
            destination = root / "release"
            with patch.object(package, "postgres_archive", side_effect=postgres):
                package.release_assets(output, root / "postgres", destination, "0.1.0-alpha.2", {}, root / "output-model-assets")
            self.assertEqual((destination / "install.ps1").read_text(), '$version="0.1.0-alpha.2"\n')
            self.assertFalse((destination / "install-alpha.ps1").exists())
            lines = (destination / "SHA256SUMS.txt").read_text().splitlines()
            assets = set()
            for line in lines:
                digest, name = line.split("  ", 1)
                self.assertEqual(digest, package.sha(destination / name))
                assets.add(name)
            self.assertEqual(assets, {path.name for path in destination.iterdir()} - {"SHA256SUMS.txt"})
            self.assertIn("dependencies.ps1", assets)
            self.assertIn("LessonLoop-0.1.0-alpha.2-postgresql-windows-x64.zip", assets)

    def test_installed_python_check_requires_venv_and_official_migrations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); venv = root / "venv"
            write(root, "config/components.json", json.dumps({"hindsight": "0.9.2"}))
            state = {"version": [3, 12, 11], "bits": 64, "hindsightVersion": "0.9.2",
                     "prefix": str(venv), "base": str(root / "system-python"),
                     "hindsightPath": str(venv / "Lib/site-packages/hindsight_api/__init__.py")}
            with patch.object(audit.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(state))) as run:
                self.assertEqual(audit.check_python(venv / "Scripts/python.exe", root, True), "venv_imports_and_official_migrations_passed")
                command = run.call_args.args[0]
                self.assertEqual(command[1:4], ["-I", "-B", "-c"])
                self.assertIn("get_heads()", command[4])
            state["prefix"] = state["base"]
            with patch.object(audit.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(state))):
                with self.assertRaisesRegex(RuntimeError, "private venv"):
                    audit.check_python(venv / "Scripts/python.exe", root, True)

    def test_postgres_archive_is_separate_and_hashes_runtime_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "postgres"
            names = ["bin/postgres.exe", "bin/pg_ctl.exe", "bin/initdb.exe", "bin/pg_dump.exe", "bin/pg_restore.exe",
                     "lib/vector.dll", "lib/pg_trgm.dll", "lib/other-runtime.dll",
                     "share/extension/vector.control", "share/extension/pg_trgm.control", "LICENSE", "README.md"]
            for name in names + ["include/postgres.h", "StackBuilder/setup.exe", "doc/index.html"]:
                write(source, name)
            write(source, "share/extension/vector.control", "default_version = '0.8.5'\n")
            components = {"postgresql": "18.1.0", "pgvector": "0.8.5"}
            completed = subprocess.CompletedProcess([], 0, stdout="postgres (PostgreSQL) 18.1\n")
            with patch.object(package.subprocess, "run", return_value=completed):
                result = package.postgres_archive(source, root / "postgres.zip", components)
            self.assertEqual(result["sha256"], package.sha(root / "postgres.zip"))
            with zipfile.ZipFile(root / "postgres.zip") as archive:
                self.assertEqual(set(archive.namelist()), {"postgres/" + name for name in names} | {"postgres/component-manifest.json"})
                component = json.loads(archive.read("postgres/component-manifest.json"))
                self.assertEqual(component["platform"], "win32-x64")
                self.assertEqual(component["version"], "18.1.0")
                self.assertEqual(component["pgvector"], "0.8.5")
                for item in component["files"]:
                    data = archive.read(item["path"])
                    self.assertEqual(item["size"], len(data))
                    self.assertEqual(item["sha256"], hashlib.sha256(data).hexdigest())

    def test_postgres_component_rejects_wrong_version_before_archiving(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ["bin/postgres.exe", "bin/pg_ctl.exe", "bin/initdb.exe", "bin/pg_dump.exe", "bin/pg_restore.exe",
                         "lib/vector.dll", "lib/pg_trgm.dll", "share/extension/pg_trgm.control", "LICENSE"]:
                write(root / "source", name)
            write(root / "source", "share/extension/vector.control", "default_version = '0.7.0'\n")
            with self.assertRaisesRegex(RuntimeError, "pgvector version mismatch"):
                package.postgres_archive(root / "source", root / "postgres.zip", {"postgresql": "18.1.0", "pgvector": "0.8.5"})
            self.assertFalse((root / "postgres.zip").exists())


if __name__ == "__main__":
    unittest.main()
