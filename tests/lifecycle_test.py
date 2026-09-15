import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "distribution"))
import lifecycle


class Registry:
    HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_SZ = 1, 2, 4, 1

    def __init__(self):
        self.values = {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def OpenKey(self, *args):
        return self

    CreateKeyEx = OpenKey

    def QueryValueEx(self, key, name):
        if name not in self.values:
            raise FileNotFoundError(name)
        return self.values[name]

    def SetValueEx(self, key, name, reserved, kind, value):
        self.values[name] = (value, kind)

    def DeleteValue(self, key, name):
        del self.values[name]


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lessonloop-lifecycle-")
        self.addCleanup(self.temporary.cleanup)
        self.fixture = Path(self.temporary.name).resolve()
        self.program, self.data = self.fixture / "program 安装", self.fixture / "data 数据"
        self.program.mkdir()
        self.data.mkdir()
        self.record = {"installationId": "fixture-owned", "runtimeRoot": str(self.program),
            "programRoot": str(self.program), "dataRoot": str(self.data), "setupState": "ready", "autostart": False}
        self.write(self.data / "installation.json", self.record)
        self.write(self.program / "active.json", self.record)
        (self.program / "lessonloop.ps1").write_text("fixture")
        (self.program / "owned.txt").write_text("owned bytes")
        self.write(self.program / "manifest.json", {"platform": "win32-x64", "files": [{"path": "owned.txt"}]})

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def test_autostart_is_opt_in_idempotent_and_preserves_other_entries(self):
        registry = Registry()
        registry.values["OtherApp"] = ("untouched", 1)
        run = lambda action: lifecycle.autostart(action, self.record, self.program, self.data, registry)
        self.assertEqual(run("status")["autostart"], "disabled")
        self.assertEqual(run("enable")["autostart"], "enabled")
        self.assertEqual(run("enable")["autostart"], "enabled")
        command = registry.values["LessonLoop.fixture-owned"][0]
        self.assertIn('-WindowStyle Hidden', command)
        self.assertIn(str(self.program / "lessonloop.ps1"), command)
        self.assertEqual(run("disable")["autostart"], "disabled")
        self.assertEqual(run("disable")["autostart"], "disabled")
        self.assertEqual(registry.values, {"OtherApp": ("untouched", 1)})

    def test_modified_startup_entry_is_not_removed(self):
        registry = Registry()
        registry.values["LessonLoop.fixture-owned"] = ("user modified command", 1)
        with self.assertRaisesRegex(ValueError, "modified"):
            lifecycle.autostart("disable", self.record, self.program, self.data, registry)
        self.assertEqual(registry.values["LessonLoop.fixture-owned"][0], "user modified command")

    def test_purge_requires_specific_installation_and_lists_controlled_targets(self):
        with self.assertRaisesRegex(ValueError, "--confirm fixture-owned"):
            lifecycle.removal_plan("purge", self.record, self.program, self.data, "yes")
        plan = lifecycle.removal_plan("purge", self.record, self.program, self.data, "fixture-owned")
        self.assertIn("backups", plan["dataItems"])
        self.assertNotIn("installation.json", plan["dataItems"])
        self.assertFalse(plan["programFiles"])

    def test_identity_and_overlap_rejected(self):
        self.write(self.program / "active.json", {**self.record, "installationId": "other"})
        with self.assertRaisesRegex(ValueError, "ownership"):
            lifecycle.removal_plan("uninstall", self.record, self.program, self.data)
        with self.assertRaisesRegex(ValueError, "contain"):
            lifecycle.owned_layout({**self.record, "dataRoot": str(self.program / "data")}, self.program, self.program / "data")

    def test_manifest_cannot_authorize_external_paths(self):
        for unsafe in ("../outside", "C:/outside", "file:stream", "owned.txt/../outside"):
            self.write(self.program / "manifest.json", {"platform": "win32-x64", "files": [{"path": unsafe}]})
            with self.assertRaises(ValueError):
                lifecycle.removal_plan("uninstall", self.record, self.program, self.data)

    def test_runtime_bindings_use_system_paths_and_legacy_bundle_fallback(self):
        legacy = lifecycle.runtime_executables(self.record, self.program)
        self.assertEqual(legacy["node"], self.program / "node/node.exe")
        bindings = {"python": str(self.program / ".venv/Scripts/python.exe"),
                    "node": str(self.fixture / "system/node.exe"), "postgres": str(self.fixture / "PostgreSQL/18")}
        self.assertEqual(lifecycle.runtime_executables({**self.record, "runtimeExecutables": bindings}, self.program),
                         {key: Path(value) for key, value in bindings.items()})
        for invalid in ({}, {**bindings, "node": "node.exe"}):
            with self.assertRaisesRegex(ValueError, "absolute path"):
                lifecycle.runtime_executables({**self.record, "runtimeExecutables": invalid}, self.program)

    def test_uninstall_refuses_an_unowned_python_environment(self):
        (self.program / ".venv").mkdir()
        (self.program / ".venv/user.txt").write_text("keep")
        with self.assertRaisesRegex(ValueError, "ownership record"):
            lifecycle.removal_plan("uninstall", self.record, self.program, self.data)

    def test_active_adapter_using_system_node_blocks_removal(self):
        class NoSuchProcess(Exception): pass
        class AccessDenied(Exception): pass
        node = self.fixture / "system/node.exe"
        command = [str(node), str(self.program / "versions/previous/dist/adapters/copilot/mcp.js")]
        process = SimpleNamespace(pid=123, info={"exe": str(node), "cmdline": command})
        processes = SimpleNamespace(process_iter=lambda fields: [process], NoSuchProcess=NoSuchProcess, AccessDenied=AccessDenied)
        with self.assertRaisesRegex(ValueError, "Close active Copilot sessions"):
            lifecycle.ensure_adapters_closed(self.program, processes, node=node)
        process.info["cmdline"] = [str(node), str(self.fixture / "other/dist/adapters/copilot/mcp.js")]
        lifecycle.ensure_adapters_closed(self.program, processes, node=node)

    def test_database_pid_must_match_executable_creation_time_and_data_directory(self):
        database = self.data / "storage/postgres"
        database.mkdir(parents=True)
        db_runtime = self.program / "postgres"
        self.write(self.data / "database-owner.json", {"dataRoot": str(self.data), "database": str(database), "runtime": str(db_runtime)})
        (database / "postmaster.pid").write_text("123\n" + str(database) + "\n1000\n", encoding="utf-8")
        class NoSuchProcess(Exception): pass
        class AccessDenied(Exception): pass
        process = SimpleNamespace(exe=lambda: str(db_runtime / "bin/postgres.exe"),
            create_time=lambda: 1000.1, cmdline=lambda: ["postgres.exe", "-D", str(database)])
        processes = SimpleNamespace(Process=lambda pid: process, NoSuchProcess=NoSuchProcess, AccessDenied=AccessDenied)
        self.assertIs(lifecycle.owned_database(self.record, self.program, self.data, processes), process)
        process.create_time = lambda: 2000
        with self.assertRaisesRegex(ValueError, "no longer owned"):
            lifecycle.owned_database(self.record, self.program, self.data, processes)
        process.create_time = lambda: 1000
        process.exe = lambda: str(self.fixture / "other/postgres.exe")
        with self.assertRaises(ValueError):
            lifecycle.owned_database(self.record, self.program, self.data, processes)
        system = self.fixture / "PostgreSQL/18"
        self.record["runtimeExecutables"] = {"python": str(self.program / ".venv/Scripts/python.exe"),
                                             "node": str(self.fixture / "system/node.exe"), "postgres": str(system)}
        self.write(self.data / "database-owner.json", {"dataRoot": str(self.data), "database": str(database), "runtime": str(system)})
        process.exe = lambda: str(system / "bin/postgres.exe")
        self.assertIs(lifecycle.owned_database(self.record, self.program, self.data, processes), process)
        process.cmdline = lambda: [str(system / "bin/postgres.exe"), "-D", str(self.fixture / "other-database")]
        with self.assertRaisesRegex(ValueError, "no longer owned"):
            lifecycle.owned_database(self.record, self.program, self.data, processes)

    def prepare_cleanup(self, action):
        plan = lifecycle.removal_plan(action, self.record, self.program, self.data, "fixture-owned")
        plan["previousSetupState"] = self.record["setupState"]
        self.write(self.data / "removal-plan.json", plan)
        self.write(self.data / "installation.json", {**self.record, "setupState": "removal_pending", "removalAction": action})
        return self.data / "removal-plan.json"

    def cleanup(self, plan):
        script = Path(__file__).resolve().parents[1] / "distribution/cleanup.ps1"
        return subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", str(script), "-PlanPath", str(plan)], capture_output=True, text=True, encoding="utf-8", errors="replace")

    @unittest.skipUnless(os.name == "nt", "Windows cleanup helper")
    def test_actual_uninstall_keeps_data_credentials_and_user_files(self):
        (self.program / "user-export.txt").write_text("user data")
        (self.data / "secrets.dpapi").write_bytes(b"fixture protected bytes")
        self.write(self.data / "backups/snapshot.json", {"fixture": True})
        result = self.cleanup(self.prepare_cleanup("uninstall"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.program / "owned.txt").exists())
        self.assertFalse((self.program / "active.json").exists())
        self.assertTrue((self.program / "user-export.txt").exists())
        self.assertTrue((self.data / "secrets.dpapi").exists())
        self.assertTrue((self.data / "backups/snapshot.json").exists())
        self.assertIn('"status":"uninstalled"', result.stdout)

    @unittest.skipUnless(os.name == "nt", "Windows cleanup helper")
    def test_uninstall_removes_product_venv_and_keeps_system_dependencies(self):
        system = self.fixture / "system Python"
        system.mkdir()
        (system / "python.exe").write_text("system executable remains")
        environment = self.program / ".venv"
        (environment / "empty/subdirectory").mkdir(parents=True)
        self.write(environment / "lessonloop-environment.json", {"pythonBase": str(system / "python.exe")})
        (environment / "pyvenv.cfg").write_text("home = " + str(system))
        result = self.cleanup(self.prepare_cleanup("uninstall"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.program.exists())
        self.assertTrue((system / "python.exe").exists())
        self.assertTrue((self.data / "installation.json").exists())

    @unittest.skipUnless(os.name == "nt", "Windows cleanup helper")
    def test_actual_purge_removes_owned_data_and_backups_but_keeps_exports(self):
        self.record.update(pythonBase=str(self.fixture / "system/python.exe"), runtimeExecutables={
            "python": str(self.program / ".venv/Scripts/python.exe"), "node": str(self.fixture / "system/node.exe"),
            "postgres": str(self.fixture / "PostgreSQL/18")})
        self.write(self.data / "storage/postgres/fixture.json", {"fixture": True})
        self.write(self.data / "backups/snapshot.json", {"fixture": True})
        self.write(self.data / "host-state/session.json", {"fixture": True})
        (self.data / "secrets.dpapi").write_bytes(b"fixture protected bytes")
        (self.data / "user-export.txt").write_text("keep")
        result = self.cleanup(self.prepare_cleanup("purge"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for path in ("storage/postgres", "backups", "host-state", "secrets.dpapi"):
            self.assertFalse((self.data / path).exists(), path)
        self.assertTrue((self.program / "owned.txt").exists())
        self.assertTrue((self.data / "user-export.txt").exists())
        purged = json.loads((self.data / "installation.json").read_text(encoding="utf-8-sig"))
        self.assertEqual(purged["setupState"], "purged")
        self.assertEqual(purged["runtimeExecutables"], self.record["runtimeExecutables"])
        self.assertEqual(purged["pythonBase"], self.record["pythonBase"])

    @unittest.skipUnless(os.name == "nt", "Windows cleanup helper")
    def test_locked_installed_file_leaves_recoverable_removal_state(self):
        plan = self.prepare_cleanup("uninstall")
        with (self.program / "owned.txt").open("rb"):
            result = self.cleanup(plan)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(plan.exists())
        self.assertEqual(json.loads((self.data / "installation.json").read_text(encoding="utf-8-sig"))["setupState"], "removal_pending")
        retried = self.cleanup(plan)
        self.assertEqual(retried.returncode, 0, retried.stdout + retried.stderr)
        self.assertFalse(self.program.exists())

    @unittest.skipUnless(os.name == "nt", "Windows cleanup helper")
    def test_cleanup_refuses_tampered_identity_without_deleting_anything(self):
        plan = self.prepare_cleanup("uninstall")
        self.write(self.data / "installation.json", {**self.record, "installationId": "other"})
        result = self.cleanup(plan)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.program / "owned.txt").exists())

    @unittest.skipUnless(os.name == "nt", "Windows cleanup helper")
    def test_actual_uninstall_removes_empty_program_root(self):
        result = self.cleanup(self.prepare_cleanup("uninstall"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.program.exists())
        self.assertTrue((self.data / "installation.json").exists())

    @unittest.skipUnless(os.name == "nt", "Windows junction safety")
    def test_purge_rejects_nested_junction_and_keeps_external_data(self):
        external = self.fixture / "external"
        external.mkdir()
        (external / "keep.txt").write_text("outside controlled data")
        backups = self.data / "backups"
        backups.mkdir()
        link = backups / "outside-link"
        def quote(path): return "'" + str(path).replace("'", "''") + "'"
        created = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
            "New-Item -ItemType Junction -Path " + quote(link) + " -Target " + quote(external) + " | Out-Null"], capture_output=True)
        self.assertEqual(created.returncode, 0, created.stderr)
        try:
            with self.assertRaisesRegex(ValueError, "Linked"):
                lifecycle.removal_plan("purge", self.record, self.program, self.data, "fixture-owned")
            self.assertTrue((external / "keep.txt").exists())
        finally:
            # Remove only this fixture junction, never its destination tree.
            os.rmdir(link)


if __name__ == "__main__":
    unittest.main()
