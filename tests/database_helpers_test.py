"""Exercise database retry guards without invoking PostgreSQL binaries."""
import ast
from io import StringIO
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "distribution/database.py"
TREE = ast.parse(SOURCE.read_text(encoding="utf-8"))
INIT = next(node for node in TREE.body if isinstance(node, ast.If) and ast.unparse(node.test) == "args.action == 'init'")
RUN = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "run")


class DatabaseHelpersTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lessonloop-database-helper-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.db = self.root / "storage/postgres"
        self.owner = self.root / "database-owner.json"
        self.calls = []

    def initialize(self):
        namespace = {"args": SimpleNamespace(action="init", port=19432), "root": self.root,
            "runtime": self.root / "runtime 安装", "db": self.db, "owner": self.owner,
            "json": json, "sys": SimpleNamespace(stdin=StringIO(json.dumps({"password": "x" * 32}))),
            "tempfile": tempfile, "Path": Path, "windows_path": str, "run": lambda *args: self.calls.append(args)}
        exec(compile(ast.Module(body=INIT.body, type_ignores=[]), str(SOURCE), "exec"), namespace)

    def test_empty_interrupted_directory_can_be_initialized(self):
        self.db.mkdir(parents=True)
        self.initialize()
        self.assertEqual(self.calls[0][0], "initdb")
        self.assertTrue(self.owner.exists())
        self.assertEqual(list(self.root.glob("tmp*")), [])

    def test_nonempty_database_is_preserved_without_execution(self):
        self.db.mkdir(parents=True)
        for name in ("PG_VERSION", "partial-init-file"):
            marker = self.db / name
            marker.write_text("keep")
            with self.assertRaisesRegex(SystemExit, "initialization refused"):
                self.initialize()
            self.assertEqual(marker.read_text(), "keep")
            marker.unlink()
        self.assertFalse(self.calls)
        self.assertFalse(self.owner.exists())

    def test_owner_record_refuses_even_an_empty_database(self):
        self.db.mkdir(parents=True)
        self.owner.write_text("owned")
        with self.assertRaisesRegex(SystemExit, "initialization refused"):
            self.initialize()
        self.assertFalse(self.calls)
        self.assertEqual(self.owner.read_text(), "owned")

    def test_database_binary_uses_short_path_before_execution(self):
        calls, shortened = [], []
        def short(path):
            shortened.append(path)
            return "C:/SHORT/BIN/initdb.exe"
        def execute(command, **kwargs):
            calls.append(command)
            return SimpleNamespace(returncode=0)
        namespace = {"root": self.root, "runtime": self.root / "中文 runtime", "flags": 0,
            "subprocess": SimpleNamespace(run=execute), "windows_path": short}
        exec(compile(ast.Module(body=[RUN], type_ignores=[]), str(SOURCE), "exec"), namespace)
        namespace["run"]("initdb", ["-D", "fixture"])
        self.assertEqual(shortened, [self.root / "中文 runtime/bin/initdb.exe"])
        self.assertEqual(calls, [["C:/SHORT/BIN/initdb.exe", "-D", "fixture"]])

    def test_backup_binary_and_directory_use_short_paths(self):
        runtime = ast.parse((SOURCE.parent / "runtime.py").read_text(encoding="utf-8"))
        command = next(node.value for node in ast.walk(runtime) if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "command" for target in node.targets)
            and isinstance(node.value, ast.List) and "pg_dump.exe" in ast.unparse(node.value))
        self.assertEqual(ast.unparse(command.elts[0]), "windows_path(pg_runtime / 'bin/pg_dump.exe')")


if __name__ == "__main__":
    unittest.main()
