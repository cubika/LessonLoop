"""Audit release bytes; optionally verify the interpreter selected at install time."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "distribution"))


MINIMUM_VERSIONS = {"python": "3.11.0", "node": "18.14.1", "postgresql": "15.0.0", "pgvector": "0.5.0"}
REQUIRED_PRODUCT_FILES = {
    "distribution/dependencies.ps1", "distribution/python_environment.py",
    "distribution/runtime.py", "distribution/launcher.ps1", "distribution/check_runtime.py",
    "dist/cli/main.js", "config/components.json", "config/python-requirements.txt",
    "distribution/model_assets.py", "third-party/hindsight-LICENSE",
}


def audit_files(root):
    root = Path(root).resolve()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8-sig"))
    names = [item["path"] for item in manifest["files"]]
    if len({name.casefold() for name in names}) != len(names):
        raise RuntimeError("Duplicate manifest path")
    for name in names:
        if name.startswith("/") or any(part in {"", ".", ".."} or ":" in part for part in name.replace("\\", "/").split("/")):
            raise RuntimeError("Unsafe manifest path")
    actual = {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}
    expected = set(names) | {"manifest.json"}
    if actual != expected:
        raise RuntimeError("Files differ from manifest: " + str(len(actual ^ expected)))
    for item in manifest["files"]:
        path = root / item["path"]
        if any(part.is_symlink() or getattr(part, "is_junction", lambda: False)() for part in [path, *path.parents] if part != root) or not path.resolve().is_relative_to(root):
            raise RuntimeError("File escapes package: " + item["path"])
        with path.open("rb") as stream:
            hash_value = hashlib.file_digest(stream, "sha256").hexdigest()
        if path.stat().st_size != item["size"] or hash_value != item["sha256"]:
            raise RuntimeError("Hash mismatch: " + item["path"])
        if path.name in {"secrets.dpapi", "development-secret.json", "core-config.json", "active.json", "installation.json", "postmaster.pid", "pyvenv.cfg"}:
            raise RuntimeError("Forbidden file: " + item["path"])
        if path.suffix in {".json", ".toml", ".yaml", ".yml", ".ini", ".cfg", ".py", ".js", ".ps1", ".md", ".txt"} and path.stat().st_size < 4 * 1024 * 1024:
            text = path.read_text(encoding="utf-8", errors="ignore")
            if re.search(r"gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}", text):
                raise RuntimeError("Credential-shaped content in: " + item["path"])
    if manifest.get("runtimePolicy") == "system_reuse":
        if manifest.get("minimumVersions") != MINIMUM_VERSIONS:
            raise RuntimeError("System runtime minimum versions missing or changed")
        if not REQUIRED_PRODUCT_FILES.issubset(expected):
            raise RuntimeError("Required system-reuse product file missing")
        if manifest.get("modelPolicy") != "download_on_install":
            raise RuntimeError("Model download policy missing")
        from model_assets import components as model_components
        model_components(manifest)
        if any(Path(name).parts[0].casefold() in {"python", "node", "postgres", "models"} or
               "site-packages" in {part.casefold() for part in Path(name).parts} for name in names):
            raise RuntimeError("System-reuse package contains runtime components")
        components = json.loads((root / "config/components.json").read_text(encoding="utf-8-sig"))
        if components.get("runtimePolicy") != "system_reuse" or components.get("minimumVersions") != manifest["minimumVersions"]:
            raise RuntimeError("Component runtime policy differs from manifest")
    elif not list((root / "python/Lib/site-packages/hindsight_api/alembic/versions").glob("*.py")):
        raise RuntimeError("Official Hindsight migrations missing")
    return manifest


def check_python(executable, root, system_reuse):
    code = """
import sys,json,struct,ssl,sqlite3,asyncpg,psycopg2,onnxruntime,tokenizers,hindsight_api,copilot
from importlib.metadata import version
from pathlib import Path
from alembic.config import Config
from alembic.script import ScriptDirectory
c=Config(); c.set_main_option('script_location',str(Path(hindsight_api.__file__).parent/'alembic'))
heads=ScriptDirectory.from_config(c).get_heads(); assert heads
print(json.dumps({'prefix':sys.prefix,'base':sys.base_prefix,'paths':sys.path,
    'version':list(sys.version_info[:3]),'bits':struct.calcsize('P')*8,
    'hindsightVersion':version('hindsight-api-slim'),'hindsightPath':hindsight_api.__file__,
    'migrationHeads':heads}))
"""
    result = subprocess.run([str(executable), "-I", "-B", "-c", code], capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError("Selected Python import check failed: " + result.stderr[:500])
    state = json.loads(result.stdout)
    components = json.loads((root / "config/components.json").read_text(encoding="utf-8-sig"))
    if tuple(state["version"]) < (3, 11, 0) or state["bits"] != 64:
        raise RuntimeError("Selected Python must be 64-bit version 3.11 or newer")
    if state["hindsightVersion"] != components["hindsight"]:
        raise RuntimeError("Selected Python has a different Hindsight version")
    prefix, base = Path(state["prefix"]).resolve(), Path(state["base"]).resolve()
    if system_reuse:
        if prefix == base or not Path(state["hindsightPath"]).resolve().is_relative_to(prefix):
            raise RuntimeError("Hindsight must be installed in the selected private venv")
        return "venv_imports_and_official_migrations_passed"
    if prefix != root / "python" or base != root / "python":
        raise RuntimeError("Python uses an external runtime")
    if any(not Path(path).resolve().is_relative_to(root) for path in state["paths"] if path):
        raise RuntimeError("Python path escapes package")
    return "isolated_imports_passed"


def check_node(executable):
    result = subprocess.run([str(executable), "-p", "JSON.stringify({version:process.versions.node,arch:process.arch})"],
                            capture_output=True, text=True, timeout=10, check=True)
    state = json.loads(result.stdout)
    if state["arch"] != "x64" or tuple(int(part) for part in state["version"].split(".")) < (18, 14, 1):
        raise RuntimeError("Selected Node must be x64 version 18.14.1 or newer")
    return state["version"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--python", type=Path, help="Installed private venv interpreter to verify without installing dependencies")
    parser.add_argument("--node", type=Path, help="Selected system Node executable to verify")
    args = parser.parse_args()
    root = args.bundle.resolve()
    manifest = audit_files(root)
    system_reuse = manifest.get("runtimePolicy") == "system_reuse"
    python = args.python or (None if system_reuse else root / "python/python.exe")
    node = args.node or (None if system_reuse else root / "node/node.exe")
    print(json.dumps({"status": "passed", "files": len(manifest["files"]),
        "bytes": sum(item["size"] for item in manifest["files"]),
        "runtimePolicy": manifest.get("runtimePolicy", "bundled_private"),
        "python": check_python(python, root, system_reuse) if python else "not_checked_installation_required",
        "node": check_node(node) if node else "not_checked_installation_required",
        "credentialPatternScan": "passed", "channel": manifest["channel"]}))


if __name__ == "__main__":
    main()
