"""Assemble a clean Windows alpha from private runtime components; no user data."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {"__pycache__", ".git", ".cache", "tests", "test"}
SKIP_FILES = {"pyvenv.cfg", "_virtualenv.pth", "_virtualenv.py", "claude.exe", "pg0.exe"}

def copy_tree(source, target):
    source = Path(source)
    for path in source.rglob("*"):
        relative = path.relative_to(source)
        if any(part in SKIP_DIRS for part in relative.parts) or path.name in SKIP_FILES or path.suffix == ".pyc":
            continue
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise RuntimeError("Linked build source: " + str(relative))
        if path.is_file():
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)

def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def manifest(output, version):
    components = json.loads((output / "config/components.json").read_text(encoding="utf-8-sig"))
    from concurrent.futures import ThreadPoolExecutor
    paths = [p for p in sorted(output.rglob("*")) if p.is_file() and p.name != "manifest.json"]
    def inspect(path):
        return {"path": path.relative_to(output).as_posix(), "size": path.stat().st_size, "sha256": sha(path)}
    with ThreadPoolExecutor(max_workers=8) as executor:
        files = list(executor.map(inspect, paths))
    forbidden = {"secrets.dpapi", "development-secret.json", "core-config.json", "active.json", "installation.json", "postmaster.pid"}
    if any(Path(f["path"]).name in forbidden for f in files):
        raise RuntimeError("Installation or credential file in package")
    value = {"version": version, "platform": "win32-x64", "channel": "alpha", "alphaReady": True, "releaseReady": False,
        "sourceCommit": subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip(),
        "compatibility": {"productSchema": 1, "protocol": 1, "activationCheck": 1,
            **{key: components[key] for key in ["hindsight", "postgresql", "pgvector"]}}, "files": files}
    (output / "manifest.json").write_text(json.dumps(value, indent=2), encoding="utf-8")
    return value

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base", type=Path, default=ROOT / ".local-validation/bundle-dev")
    parser.add_argument("--reranker", type=Path, default=ROOT / ".local-validation/reranker-prepared")
    parser.add_argument("--version", default="0.1.0-alpha.1")
    parser.add_argument("--refresh-code", action="store_true")
    parser.add_argument("--archive", type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    if not args.refresh_code:
        if output.exists():
            raise RuntimeError("Choose a new output directory")
        output.mkdir(parents=True)
        for name in ["node", "python", "postgres", "models"]:
            copy_tree(args.base / name, output / name)
        # Only the Python executable is used; venv console launchers embed build paths.
        if (output / "python/Scripts").exists():
            shutil.rmtree(output / "python/Scripts")
        shutil.copyfile(ROOT / "package.json", output / "package.json")
        shutil.copyfile(ROOT / "package-lock.json", output / "package-lock.json")
        result = subprocess.run(["npm.cmd", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=output, check=False)
        if result.returncode:
            raise RuntimeError("Production Node dependency installation failed")
    elif not (output / "python/python.exe").is_file():
        raise RuntimeError("Prepared output runtime missing")
    for name in ["distribution", "dist", "config", "third-party"]:
        copy_tree(ROOT / name, output / name)
    shutil.copyfile(ROOT / "package.json", output / "package.json")
    for name in ["models/reranker", "third-party/flashrank"]:
        copy_tree(args.reranker / name, output / name)
    sys.path.insert(0, str(ROOT / "distribution"))
    from reranker import configuration
    configured = configuration(output)
    if configured["status"] != "ready":
        raise RuntimeError("Reranker must be prepared and verified for this alpha")
    components = json.loads((output / "config/components.json").read_text())
    components.update(reranker="flashrank", version=args.version, releaseReady=False, channel="alpha")
    shutil.copyfile(ROOT / "docs/14-alpha-release.md", output / "QUICKSTART.md")
    (output / "config/components.json").write_text(json.dumps(components, indent=2), encoding="utf-8")
    print("Hashing release files...", flush=True)
    value = manifest(output, args.version)
    print(json.dumps({"output": str(output), "files": len(value["files"]), "bytes": sum(f["size"] for f in value["files"])}), flush=True)
    if args.archive:
        args.archive.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(args.archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            for path in sorted(output.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(output))
        if args.archive.stat().st_size >= 2 * 1024**3:
            raise RuntimeError("Release asset exceeds GitHub per-file size limit")
        print(json.dumps({"archive": str(args.archive), "bytes": args.archive.stat().st_size, "sha256": sha(args.archive)}), flush=True)

if __name__ == "__main__":
    main()
