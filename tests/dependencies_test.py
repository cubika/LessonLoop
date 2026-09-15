"""Dependency decisions use isolated fixtures and never install software."""
import json
import os
from pathlib import Path
import struct
import shutil
import subprocess
import sys
import tempfile
import unittest


def ps_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


@unittest.skipUnless(os.name == "nt", "Windows dependency installer")
class DependencyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lessonloop-dependencies-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.script = Path(__file__).resolve().parents[1] / "distribution/dependencies.ps1"

    def run_ps(self, body, prelude=""):
        script = self.root / "fixture.ps1"
        script.write_text(
            "$ErrorActionPreference='Stop'\n"
            "[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false\n"
            f". {ps_literal(self.script)}\n"
            "$script:installs=0;$script:prompts=@()\n"
            # Always replace the installer before any test runs.
            "function Install-LessonLoopDependency([string]$Name){$script:installs++;$script:installed=$true}\n"
            "function Read-Host([string]$Prompt){$script:prompts+=$Prompt;return 'no'}\n"
            + prelude
            + "\ntry { $value=& {\n"
            + body
            + "\n};$report=@{ok=$true;value=$value} } catch { $report=@{ok=$false;error=$_.Exception.Message} }\n"
            "$report.installs=$script:installs;$report.prompts=$script:prompts\n"
            "Write-Output ('RESULT:' + ($report | ConvertTo-Json -Depth 12 -Compress))\n",
            encoding="utf-8-sig",
        )
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script)],
            capture_output=True, encoding="utf-8", errors="replace", timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        lines = [line[7:] for line in result.stdout.splitlines() if line.startswith("RESULT:")]
        self.assertEqual(len(lines), 1, result.stdout + result.stderr)
        return json.loads(lines[0])

    def probes(self, python="3.11.0", node="18.14.1", arch="x64"):
        return rf"""
function Get-LessonLoopPythonCandidates([string]$Path){{if($Path){{$Path}}else{{'C:\fixture\python.exe'}}}}
function Get-LessonLoopNodeCandidates([string]$Path){{if($Path){{$Path}}else{{'C:\fixture\node.exe'}}}}
function Get-LessonLoopPostgresCandidates([string]$Path){{if($Path){{$Path}}else{{'C:\fixture\postgres'}}}}
function Test-LessonLoopPostgresRuntime([string]$Path){{[pscustomobject]@{{Path=$Path;Version='15.0';PgvectorVersion='0.5.0';Compatible=$true;Reason=$null}}}}
function Invoke-LessonLoopProbe([string]$Path,[string[]]$Arguments){{
  if($Path -like '*python*'){{return (@{{version='{python}';arch='{'win-amd64' if arch == 'x64' else 'win32'}';path=$Path}} | ConvertTo-Json -Compress)}}
  return (@{{version='{node}';arch='{arch}';path=$Path}} | ConvertTo-Json -Compress)
}}
"""

    def postgres_fixture(self, machine=0x8664, vector="0.5.0"):
        root = self.root / "postgres runtime"
        (root / "bin").mkdir(parents=True)
        (root / "share/extension").mkdir(parents=True)
        (root / "lib").mkdir()
        image = bytearray(256)
        image[:2] = b"MZ"
        struct.pack_into("<I", image, 0x3C, 0x80)
        image[0x80:0x84] = b"PE\0\0"
        struct.pack_into("<H", image, 0x84, machine)
        (root / "bin/postgres.exe").write_bytes(image)
        for name in ("initdb", "pg_ctl", "pg_dump"):
            (root / f"bin/{name}.exe").write_bytes(b"fixture; never executed")
        for name, version in (("vector", vector), ("pg_trgm", "1.6")):
            (root / f"share/extension/{name}.control").write_text(f"default_version = '{version}'\n")
            (root / f"share/extension/{name}--{version}.sql").write_text("fixture; never executed")
            (root / f"lib/{name}.dll").write_bytes(b"fixture; never loaded")
        return root

    def test_minimum_and_newer_versions_are_reused_without_prompt_or_install(self):
        for python, node in (("3.11.0", "18.14.1"), ("3.11.0", "18.20.8"), ("3.11.0", "20.0.0"), ("3.12.11", "22.18.0"), ("3.13.5", "24.3.0")):
            with self.subTest(python=python, node=node):
                result = self.run_ps("Resolve-LessonLoopDependencies -NonInteractive", self.probes(python, node))
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["value"]["PythonVersion"], python)
                self.assertEqual(result["value"]["NodeVersion"], node)
                self.assertEqual(result["value"]["PostgresPath"], r"C:\fixture\postgres")
                self.assertFalse(result["value"]["PostgresNeedsComponent"])
                self.assertEqual(result["installs"], 0)
                self.assertEqual(result["prompts"], [])

    def test_explicit_executable_paths_are_checked(self):
        result = self.run_ps(
            r"Resolve-LessonLoopDependencies -PythonPath 'C:\chosen\python.exe' -NodePath 'C:\chosen\node.exe' -PostgresPath 'C:\chosen\postgres' -NonInteractive",
            self.probes(),
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["value"]["PythonExe"], r"C:\chosen\python.exe")
        self.assertEqual(result["value"]["NodeExe"], r"C:\chosen\node.exe")
        result = self.run_ps(r"Resolve-LessonLoopDependencies -PythonPath 'C:\old\python.exe' -NonInteractive", self.probes(python="3.10.9"))
        self.assertFalse(result["ok"])
        self.assertEqual(result["installs"], 0)

    def test_old_python_and_node_require_upgrade_confirmation(self):
        for versions in (("3.10.9", "18.14.1"), ("3.11.0", "18.14.0"), ("3.11.0", "16.20.2")):
            with self.subTest(versions=versions):
                result = self.run_ps("Resolve-LessonLoopDependencies", self.probes(*versions))
                self.assertFalse(result["ok"])
                self.assertIn("declined", result["error"])
                self.assertIn("Upgrade", result["prompts"][0])
                self.assertEqual(result["installs"], 0)

    def test_missing_runtime_requires_install_confirmation(self):
        for name in ("Python", "Node"):
            with self.subTest(name=name):
                prelude = self.probes() + f"\nfunction Get-LessonLoop{name}Candidates {{}}\n"
                result = self.run_ps("Resolve-LessonLoopDependencies", prelude)
                self.assertFalse(result["ok"])
                self.assertIn("was not found. Install", result["prompts"][0])
                self.assertEqual(result["installs"], 0)

    def test_noninteractive_missing_dependency_stops_without_read_host(self):
        prelude = self.probes() + "\nfunction Get-LessonLoopPythonCandidates {}\n"
        result = self.run_ps("Resolve-LessonLoopDependencies -NonInteractive", prelude)
        self.assertFalse(result["ok"])
        self.assertIn("interactively", result["error"])
        self.assertEqual(result["installs"], 0)
        self.assertEqual(result["prompts"], [])

    def test_declining_default_answer_stops_installation(self):
        for answer in ("", "no", "sure"):
            with self.subTest(answer=answer):
                prelude = self.probes("3.10.9") + f"\nfunction Read-Host([string]$Prompt){{return {ps_literal(answer)}}}\n"
                result = self.run_ps("Resolve-LessonLoopDependencies", prelude)
                self.assertFalse(result["ok"])
                self.assertEqual(result["installs"], 0)

    def test_approval_installs_then_rechecks_runtime(self):
        prelude = self.probes() + r"""
function Get-LessonLoopPythonCandidates { if($script:installed){'C:\fixture\python.exe'} }
function Read-Host([string]$Prompt){$script:prompts+=$Prompt;return 'YES'}
"""
        result = self.run_ps("Resolve-LessonLoopDependencies", prelude)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["installs"], 1)
        self.assertEqual(result["value"]["PythonVersion"], "3.11.0")

    def test_approved_install_without_working_runtime_is_failure(self):
        prelude = self.probes() + """
function Get-LessonLoopPythonCandidates {}
function Read-Host([string]$Prompt){return 'yes'}
"""
        result = self.run_ps("Resolve-LessonLoopDependencies", prelude)
        self.assertFalse(result["ok"])
        self.assertIn("not found after installation", result["error"])
        self.assertEqual(result["installs"], 1)

    def test_winget_unavailable_gives_official_install_link(self):
        prelude = f". {ps_literal(self.script)}\nfunction Get-Command {{}}\n"
        for name, link in (("Python", "https://www.python.org/downloads/windows/"), ("Node", "https://nodejs.org/en/download")):
            with self.subTest(name=name):
                result = self.run_ps(f"Install-LessonLoopDependency {name}", prelude)
                self.assertFalse(result["ok"])
                self.assertIn("winget is unavailable", result["error"])
                self.assertIn(link, result["error"])

    def test_winget_uses_official_packages_without_accepting_agreements(self):
        prelude = f". {ps_literal(self.script)}\n" + """
function Invoke-FakeWinget {$script:wingetArguments=@($args);$global:LASTEXITCODE=0}
function Get-Command {[pscustomobject]@{Source='Invoke-FakeWinget'}}
"""
        for name, package in (("Python", "Python.Python.3.12"), ("Node", "OpenJS.NodeJS.LTS")):
            with self.subTest(name=name):
                result = self.run_ps(f"Install-LessonLoopDependency {name}\n$script:wingetArguments", prelude)
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["value"], ["install", "--id", package, "--exact", "--source", "winget", "--architecture", "x64", "--interactive"])

    def test_python_launcher_finds_compatible_runtime_when_path_has_old_python(self):
        prelude = r"""
function Get-Command([string[]]$Name){
  if($Name[0] -eq 'py.exe'){[pscustomobject]@{Source='C:\fixture\py.exe'}}
  elseif($Name[0] -eq 'python.exe'){[pscustomobject]@{Source='C:\old\python.exe'}}
}
function Invoke-LessonLoopProbe([string]$Path,[string[]]$Arguments){
  if($Path -like '*\py.exe'){return ' -V:3.11 * C:\Users\Test User\Python311\python.exe'}
  if($Path -like '*\old\*'){$version='3.10.0'}else{$version='3.11.0'}
  return (@{version=$version;arch='win-amd64';path=$Path} | ConvertTo-Json -Compress)
}
"""
        result = self.run_ps("@(Get-LessonLoopPythonCandidates | ForEach-Object {Test-LessonLoopPython $_}) | Where-Object Compatible | Select-Object -First 1", prelude)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["value"]["Path"], r"C:\Users\Test User\Python311\python.exe")
        self.assertEqual(result["installs"], 0)

    def test_wrong_architecture_is_not_reused(self):
        result = self.run_ps("Resolve-LessonLoopDependencies -NonInteractive", self.probes(arch="ia32"))
        self.assertFalse(result["ok"])
        self.assertEqual(result["installs"], 0)

    def test_missing_postgres_requires_approval_before_component_download(self):
        prelude = self.probes() + "\nfunction Get-LessonLoopPostgresCandidates {}\n"
        result = self.run_ps("Resolve-LessonLoopDependencies", prelude)
        self.assertFalse(result["ok"])
        self.assertEqual(result["installs"], 0)
        prelude += "function Read-Host([string]$Prompt){$script:prompts+=$Prompt;return 'yes'}\n"
        result = self.run_ps("Resolve-LessonLoopDependencies", prelude)
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["value"]["PostgresNeedsComponent"])
        self.assertIsNone(result["value"]["PostgresPath"])
        self.assertEqual(result["installs"], 0)

    def test_component_available_on_disk_still_needs_confirmation(self):
        prelude = self.probes() + "\nfunction Get-LessonLoopPostgresCandidates {}\n"
        result = self.run_ps(r"Resolve-LessonLoopDependencies -PostgresComponentPath 'C:\bundle\postgres'", prelude)
        self.assertFalse(result["ok"])
        prelude += "function Read-Host([string]$Prompt){return 'yes'}\n"
        result = self.run_ps(r"Resolve-LessonLoopDependencies -PostgresComponentPath 'C:\bundle\postgres'", prelude)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["value"]["PostgresPath"], r"C:\bundle\postgres")
        self.assertFalse(result["value"]["PostgresNeedsComponent"])

    def test_postgres_probe_checks_version_extensions_and_preserves_existing_data(self):
        root = self.postgres_fixture()
        existing = root / "data"
        existing.mkdir()
        (existing / "PG_VERSION").write_text("15")
        before = {str(path): path.read_bytes() for path in root.rglob("*") if path.is_file()}
        probe = "function Invoke-LessonLoopProbe {return 'postgres (PostgreSQL) 15.0'}\n"
        result = self.run_ps(f"Test-LessonLoopPostgresRuntime {ps_literal(root)}", probe)
        self.assertTrue(result["value"]["Compatible"], result)
        self.assertEqual(result["value"]["PgvectorVersion"], "0.5.0")
        self.assertEqual(before, {str(path): path.read_bytes() for path in root.rglob("*") if path.is_file()})
        (root / "share/extension/pg_trgm.control").unlink()
        result = self.run_ps(f"Test-LessonLoopPostgresRuntime {ps_literal(root)}", probe)
        self.assertFalse(result["value"]["Compatible"])
        self.assertIn("pg_trgm", result["value"]["Reason"])

    def test_postgres_old_version_or_old_vector_is_rejected(self):
        root = self.postgres_fixture(vector="0.4.4")
        for version, reason in (("14.12", "PostgreSQL 15"), ("15.0", "pgvector 0.5.0")):
            with self.subTest(version=version):
                probe = f"function Invoke-LessonLoopProbe {{return 'postgres (PostgreSQL) {version}'}}\n"
                result = self.run_ps(f"Test-LessonLoopPostgresRuntime {ps_literal(root)}", probe)
                self.assertFalse(result["value"]["Compatible"])
                self.assertIn(reason, result["value"]["Reason"])

    def test_postgres_requires_x64_binary(self):
        root = self.postgres_fixture(machine=0x14C)
        result = self.run_ps(f"Test-LessonLoopPostgresRuntime {ps_literal(root)}")
        self.assertFalse(result["value"]["Compatible"])
        self.assertIn("x64", result["value"]["Reason"])

    def test_python_probe_works_with_real_interpreter_without_changes(self):
        result = self.run_ps(f"Test-LessonLoopPython {ps_literal(sys.executable)}")
        self.assertTrue(result["value"]["Compatible"], result)
        self.assertEqual(Path(result["value"]["Path"]), Path(sys._base_executable))

    def test_activated_venv_selects_its_base_interpreter(self):
        venv = self.root / "active venv"
        subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(venv)], check=True, capture_output=True)
        result = self.run_ps(f"Test-LessonLoopPython {ps_literal(venv / 'Scripts/python.exe')}")
        self.assertTrue(result["value"]["Compatible"], result)
        self.assertEqual(Path(result["value"]["Path"]), Path(sys._base_executable))

    def test_managed_postgres_component_is_reused_on_retry(self):
        component = self.root / "LessonLoopComponents/postgresql-fixture/postgres"
        component.mkdir(parents=True)
        (self.root / "LessonLoopComponents/postgresql-fixture.staging-partial/postgres").mkdir(parents=True)
        prelude = self.probes() + f"\n. {ps_literal(self.script)}\n"
        prelude += f"$env:LOCALAPPDATA={ps_literal(self.root)}\n$env:ProgramFiles={ps_literal(self.root)}\nfunction Get-Command {{}}\n"
        result = self.run_ps("Get-LessonLoopPostgresCandidates", prelude)
        self.assertTrue(result["ok"], result)
        self.assertEqual(Path(result["value"]), component)

    @unittest.skipUnless(shutil.which("node.exe"), "Node executable required")
    def test_node_probe_ignores_loading_options_and_restores_environment(self):
        node = shutil.which("node.exe")
        prelude = "$env:NODE_OPTIONS='--require=C:/lessonloop-missing-fixture.cjs'\n"
        result = self.run_ps(f"$probe=Test-LessonLoopNode {ps_literal(node)}\n@{{probe=$probe;options=$env:NODE_OPTIONS}}", prelude)
        self.assertTrue(result["value"]["probe"]["Compatible"], result)
        self.assertEqual(result["value"]["options"], "--require=C:/lessonloop-missing-fixture.cjs")

    def test_old_postgres_prompts_for_upgrade(self):
        prelude = self.probes() + "\nfunction Test-LessonLoopPostgresRuntime { [pscustomobject]@{Path='C:/old';Version='14.0';Compatible=$false;Reason='PostgreSQL 15 or newer is required'} }\n"
        result = self.run_ps("Resolve-LessonLoopDependencies", prelude)
        self.assertFalse(result["ok"])
        self.assertIn("Upgrade", result["prompts"][0])
        self.assertEqual(result["installs"], 0)


if __name__ == "__main__":
    unittest.main()
