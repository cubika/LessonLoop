"""Install application packages into a venv made by the selected system Python."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from integration import private_environment
from bundle import unlinked

MINIMUM = (3, 11, 0)

def package_environment():
    environment = {key: value for key, value in private_environment().items() if not key.upper().startswith("PIP_")}
    environment["PIP_CONFIG_FILE"] = os.devnull
    return environment

def probe_python(executable):
    result = subprocess.run([str(executable), "-E", "-s", "-c",
        "import json,sys,struct;print(json.dumps({'version':list(sys.version_info[:3]),'bits':struct.calcsize('P')*8,'executable':sys._base_executable}))"],
        env=private_environment(), capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise RuntimeError("Selected Python could not run")
    value = json.loads(result.stdout)
    if tuple(value["version"]) < MINIMUM or value["bits"] != 64:
        raise RuntimeError("Python 3.11+ x64 is required; choose or install a supported interpreter")
    return value

def check_packages(executable):
    code = ("import json,sys,ssl,sqlite3,asyncpg,psycopg2,psutil,onnxruntime,tokenizers,hindsight_api,copilot;"
        "from importlib.metadata import version;from pathlib import Path;from alembic.config import Config;from alembic.script import ScriptDirectory;"
        "assert version('hindsight-api-slim')=='0.9.2';assert version('github-copilot-sdk')=='1.0.13';"
        "c=Config();c.set_main_option('script_location',str(Path(hindsight_api.__file__).parent/'alembic'));"
        "assert ScriptDirectory.from_config(c).get_heads();"
        "print(json.dumps({'prefix':sys.prefix,'base':sys.base_prefix}))")
    result = subprocess.run([str(executable), "-E", "-s", "-B", "-c", code], env=private_environment(),
        capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError("Python application dependencies are incomplete or incompatible; inspect the pip output and retry")
    return json.loads(result.stdout)

def prepare_environment(base_python, runtime):
    runtime = unlinked(runtime)
    base = Path(base_python).resolve(strict=True)
    probe = probe_python(base)
    base = Path(probe["executable"]).resolve(strict=True)
    requirements = runtime / "config/python-requirements.txt"
    expected = hashlib.sha256(requirements.read_bytes()).hexdigest()
    venv = unlinked(runtime / ".venv")
    executable = venv / "Scripts/python.exe"
    marker = venv / "lessonloop-environment.json"
    wanted = {"basePython": str(base), "baseVersion": probe["version"], "requirementsSha256": expected}
    repair = False
    owned = False
    if marker.exists():
        owned = json.loads(marker.read_text(encoding="utf-8")) == wanted
        if owned and executable.exists():
            try:
                checked = check_packages(executable)
            except RuntimeError:
                repair = True
            else:
                if Path(checked["prefix"]).resolve() != venv:
                    raise RuntimeError("Python environment path mismatch")
                print("Reusing the existing LessonLoop Python environment.", flush=True)
                return executable
    if venv.exists() and not executable.exists() and any(venv.iterdir()) and not owned:
        raise RuntimeError("The .venv directory is incomplete; inspect it before retrying")
    if not executable.exists():
        result = subprocess.run([str(base), "-E", "-s", "-m", "venv", str(venv)], env=private_environment())
        if result.returncode:
            raise RuntimeError("Could not create an environment using the selected Python; ensure venv and pip are available")
    else:
        configuration = venv / "pyvenv.cfg"
        fields = dict(line.split("=", 1) for line in configuration.read_text().splitlines() if "=" in line)
        home = next((value.strip() for key, value in fields.items() if key.strip() == "home"), None)
        if not home or Path(home).resolve() != base.parent:
            raise RuntimeError("Existing Python environment belongs to a different interpreter")
    pip_check = subprocess.run([str(executable), "-E", "-s", "-m", "pip", "--version"],
        env=package_environment(), capture_output=True)
    if pip_check.returncode:
        result = subprocess.run([str(executable), "-E", "-s", "-m", "ensurepip", "--upgrade"], env=package_environment())
        if result.returncode:
            raise RuntimeError("Could not restore pip in the LessonLoop Python environment")
    print("Installing LessonLoop application packages; the system Python installation is not modified.", flush=True)
    result = subprocess.run([str(executable), "-E", "-s", "-m", "pip", "install", "--disable-pip-version-check", "--no-input",
        "--only-binary=:all:", "--index-url", "https://pypi.org/simple", *(["--force-reinstall"] if repair else []),
        "-r", str(requirements)], env=package_environment())
    if result.returncode:
        raise RuntimeError("Application package installation failed; no system interpreter was installed or upgraded")
    checked = check_packages(executable)
    if Path(checked["prefix"]).resolve() != venv:
        raise RuntimeError("Python environment path mismatch")
    marker.write_text(json.dumps(wanted, indent=2), encoding="utf-8")
    return executable

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True)
    parser.add_argument("--runtime", required=True)
    args = parser.parse_args()
    print(json.dumps({"python": str(prepare_environment(args.python, args.runtime))}))
