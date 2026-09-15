"""PowerShell 5.1 must preserve UTF-8 records, arguments, and host JSON stdin."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(os.name == "nt", "Windows PowerShell launcher")
class LauncherEncodingTests(unittest.TestCase):
    def test_rollback_uses_previous_installation_python_binding(self):
        with tempfile.TemporaryDirectory(prefix="lessonloop-launcher-recovery-") as temporary:
            root = Path(temporary)
            program, data = root / "program", root / "data"
            previous, current = program / "versions/previous", program / "versions/current"
            (previous / "distribution").mkdir(parents=True)
            current.mkdir()
            data.mkdir()
            record = {"installationId": "recovery-fixture", "runtimeRoot": str(previous), "dataRoot": str(data),
                      "runtimeExecutables": {"python": sys.executable}}
            (program / "active.json").write_text(json.dumps(record), encoding="utf-8")
            (data / "installation.json").write_text(json.dumps({**record, "runtimeRoot": str(current),
                "runtimeExecutables": {"python": str(current / "missing/python.exe")}}), encoding="utf-8")
            (data / "update-state.json").write_text(json.dumps({"installationId": record["installationId"],
                "from": str(previous), "phase": "checking", "previousRecord": record}), encoding="utf-8")
            launcher = program / "lessonloop.ps1"
            launcher.write_text((Path(__file__).resolve().parents[1] / "distribution/launcher.ps1").read_text(encoding="utf-8"), encoding="utf-8")
            (previous / "distribution/runtime.py").write_text("import json,sys; print(json.dumps(sys.argv[1:]))", encoding="utf-8")
            result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-File", str(launcher), "rollback"], capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
            self.assertEqual(json.loads(result.stdout.decode("utf-8")),
                ["rollback", "--runtime-root", str(previous), "--data-root", str(data)])

    def test_no_bom_chinese_records_and_stdin_reach_runtime(self):
        with tempfile.TemporaryDirectory(prefix="lessonloop-launcher-encoding-") as temporary:
            root = Path(temporary)
            program, data = root / "中文 程序", root / "中文 数据"
            (program / "distribution").mkdir(parents=True)
            data.mkdir()
            record = {"installationId": "encoding-fixture", "runtimeRoot": str(program), "dataRoot": str(data),
                      "runtimeExecutables": {"python": sys.executable}}
            for path in (program / "active.json", data / "installation.json"):
                path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
            source = (Path(__file__).resolve().parents[1] / "distribution/launcher.ps1").read_text(encoding="utf-8")
            launcher = program / "lessonloop.ps1"
            launcher.write_text(source, encoding="utf-8")
            (program / "distribution/runtime.py").write_text(
                "import json,sys\nprint(json.dumps({'argv':sys.argv[1:],'stdin':sys.stdin.buffer.read().decode('utf-8')},ensure_ascii=False))\n",
                encoding="utf-8")
            payload = json.dumps({"prompt": "修复中文路径 🧪", "nested": {"text": "第一行\n第二行"}}, ensure_ascii=False)
            command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(launcher)]
            for action, arguments in (("agent-hook", ["userPromptTransformed"]), ("mcp", [])):
                environment = {**os.environ, "PYTHONHOME": str(root / "unrelated-python"),
                               "PYTHONPATH": str(root / "unrelated-packages")}
                result = subprocess.run([*command, action, *arguments], input=payload.encode("utf-8"), capture_output=True, timeout=15, env=environment)
                self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
                actual = json.loads(result.stdout.decode("utf-8"))
                self.assertEqual(actual["stdin"], payload)
                self.assertEqual(actual["argv"], [action, "--runtime-root", str(program), "--data-root", str(data), *arguments])


if __name__ == "__main__":
    unittest.main()
