"""Assemble the Windows product ZIP and optional PostgreSQL component ZIP."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model_assets import components as validate_components
ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {"__pycache__", ".git", ".cache", "tests", "test"}
SKIP_FILES = {"pyvenv.cfg", "_virtualenv.pth", "_virtualenv.py", "claude.exe", "pg0.exe"}
MINIMUM_VERSIONS = {"python": "3.11.0", "node": "18.14.1", "postgresql": "15.0.0", "pgvector": "0.5.0"}
REQUIRED_PRODUCT_FILES = {
    "distribution/dependencies.ps1", "distribution/python_environment.py",
    "distribution/runtime.py", "distribution/launcher.ps1", "distribution/check_runtime.py",
    "dist/cli/main.js", "config/components.json", "config/python-requirements.txt",
    "distribution/model_assets.py", "third-party/hindsight-LICENSE",
}

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

def manifest(output, version, model_components=None):
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
    names = {item["path"] for item in files}
    if not REQUIRED_PRODUCT_FILES.issubset(names):
        raise RuntimeError("Required product file missing: " + ", ".join(sorted(REQUIRED_PRODUCT_FILES - names)))
    if any(Path(name).parts[0].casefold() in {"python", "node", "postgres", "models"} or
           "site-packages" in {part.casefold() for part in Path(name).parts} for name in names):
        raise RuntimeError("System-reuse product package contains runtime components or models")
    value = {"version": version, "platform": "win32-x64", "channel": "alpha", "alphaReady": True, "releaseReady": False,
        "runtimePolicy": "system_reuse", "minimumVersions": MINIMUM_VERSIONS.copy(),
        "modelPolicy": "download_on_install", "modelComponents": model_components,
        "sourceCommit": subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip(),
        "compatibility": {"productSchema": 3, "protocol": 1, "activationCheck": 1,
            **{key: components[key] for key in ["hindsight", "postgresql", "pgvector"]}}, "files": files}
    validate_components(value)
    (output / "manifest.json").write_text(json.dumps(value, indent=2), encoding="utf-8")
    return value


def archive_files(destination, files, extra=None):
    destination = Path(destination).resolve()
    if destination.exists():
        raise RuntimeError("Choose a new archive path; published assets must not be overwritten")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "x", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for path, name in files:
            archive.write(path, name)
        for name, content in (extra or {}).items():
            archive.writestr(name, content)
    if destination.stat().st_size >= 2 * 1024**3:
        raise RuntimeError("Release asset exceeds GitHub per-file size limit")
    result = {"archive": str(destination), "bytes": destination.stat().st_size, "sha256": sha(destination)}
    print(json.dumps(result), flush=True)
    return result


def postgres_archive(source, destination, components):
    source = Path(source).resolve()
    required = {"bin/postgres.exe", "bin/pg_ctl.exe", "bin/initdb.exe", "bin/pg_dump.exe", "bin/pg_restore.exe",
                "lib/vector.dll", "lib/pg_trgm.dll", "share/extension/vector.control", "share/extension/pg_trgm.control", "LICENSE"}
    files = []
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if relative.parts[0] not in {"bin", "lib", "share"} and relative.as_posix() not in {"LICENSE", "README.md"}:
            continue
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise RuntimeError("Linked PostgreSQL build source: " + str(relative))
        if path.is_file():
            files.append((path, "postgres/" + relative.as_posix()))
    names = {name.removeprefix("postgres/") for _, name in files}
    if not required.issubset(names):
        raise RuntimeError("Required PostgreSQL component file missing")
    control = (source / "share/extension/vector.control").read_text(encoding="utf-8")
    import re
    vector_version = re.search(r"(?m)^default_version\s*=\s*'([^']+)'", control)
    if not vector_version or vector_version.group(1) != components["pgvector"]:
        raise RuntimeError("PostgreSQL component pgvector version mismatch")
    actual = subprocess.run([str(source / "bin/postgres.exe"), "--version"], capture_output=True, text=True, check=True, timeout=10).stdout
    version = re.search(r"PostgreSQL\)\s+(\d+(?:\.\d+){1,2})", actual)
    expected_version = tuple(int(part) for part in components["postgresql"].split("."))
    actual_version = tuple(int(part) for part in version.group(1).split(".")) if version else ()
    if actual_version + (0,) * (3 - len(actual_version)) != expected_version + (0,) * (3 - len(expected_version)):
        raise RuntimeError("PostgreSQL component version mismatch")
    component = {"component": "postgresql", "platform": "win32-x64", "version": components["postgresql"],
                 "pgvector": components["pgvector"],
                 "files": [{"path": name, "size": path.stat().st_size, "sha256": sha(path)} for path, name in files]}
    return archive_files(destination, files, {"postgres/component-manifest.json": json.dumps(component, indent=2)})

def model_archives(base, reranker, destination, version):
    from bundle import unlinked
    destination.mkdir(parents=True, exist_ok=True)
    result = []
    for name, source in [("e5", base / "models/e5"), ("reranker", reranker / "models/reranker")]:
        source = unlinked(source)
        files = []
        for path in sorted(source.rglob("*")):
            unlinked(path)
            if path.is_file():
                files.append({"path": "models/" + name + "/" + path.relative_to(source).as_posix(), "size": path.stat().st_size, "sha256": sha(path)})
        if not files:
            raise RuntimeError("Prepared model files missing: " + name)
        identity = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
        asset = "LessonLoop-model-" + name + "-" + identity + ".zip"
        archive = destination / asset
        if not archive.exists():
            archive_files(archive, [(source / Path(item["path"]).relative_to("models/" + name), item["path"]) for item in files])
        # Revalidate the cached archive before publishing its checksum.
        with zipfile.ZipFile(archive) as checked:
            if len(checked.infolist()) != len(files) or set(checked.namelist()) != {item["path"] for item in files}:
                raise RuntimeError("Cached model archive contents changed")
            for item in files:
                with checked.open(item["path"]) as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != item["sha256"]:
                        raise RuntimeError("Cached model archive checksum mismatch")
        result.append({"name": name, "archive": asset,
            "url": f"https://github.com/cubika/LessonLoop/releases/download/v{version}/{asset}",
            "size": archive.stat().st_size, "sha256": sha(archive), "files": files})
    return result


def release_assets(output, postgres, destination, version, components, model_directory=None):
    """Create the complete downloadable release, including the renamed installer."""
    destination.mkdir(parents=True)
    product = destination / f"LessonLoop-{version}-windows-x64.zip"
    archive_files(product, [(path, path.relative_to(output).as_posix()) for path in sorted(output.rglob("*")) if path.is_file()])
    postgres_archive(postgres, destination / f"LessonLoop-{version}-postgresql-windows-x64.zip", components)
    declared = json.loads((output / "manifest.json").read_text(encoding="utf-8"))["modelComponents"]
    for model in declared:
        shutil.copyfile(model_directory / model["archive"], destination / model["archive"])
    bootstrap = (output / "distribution/bootstrap.ps1").read_text(encoding="utf-8")
    import re
    bootstrap, replacements = re.subn(r'(?m)^\$version="[^"\r\n]+"', lambda _: '$version="' + version + '"', bootstrap)
    if replacements != 1:
        raise RuntimeError("Bootstrap must declare exactly one release version")
    (destination / "install.ps1").write_text(bootstrap, encoding="utf-8")
    for source, target in [("distribution/dependencies.ps1", "dependencies.ps1"),
                           ("QUICKSTART.md", "QUICKSTART.md"), ("15-runtime-compatibility.md", "15-runtime-compatibility.md")]:
        shutil.copyfile(output / source, destination / target)
    assets = sorted(path for path in destination.iterdir() if path.is_file())
    (destination / "SHA256SUMS.txt").write_text("".join(f"{sha(path)}  {path.name}\n" for path in assets), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base", type=Path, default=ROOT / ".local-validation/bundle-dev")
    parser.add_argument("--reranker", type=Path, default=ROOT / ".local-validation/reranker-prepared")
    parser.add_argument("--version", default="0.1.0-alpha.2")
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--postgres-archive", type=Path, help="Optional separate ZIP of the fixed PostgreSQL runtime")
    parser.add_argument("--release-dir", type=Path, help="New directory for both ZIPs, install.ps1, dependencies.ps1, documentation and checksums")
    args = parser.parse_args()
    output = args.output.resolve()
    if args.release_dir:
        args.release_dir = args.release_dir.resolve()
        if args.release_dir.exists() or args.release_dir.is_relative_to(output) or output.is_relative_to(args.release_dir):
            raise RuntimeError("Release assets require a new directory separate from the product output")
        if args.archive or args.postgres_archive:
            raise RuntimeError("Use --release-dir or individual archive paths")
    for destination in [args.archive, args.postgres_archive]:
        if destination and (destination.exists() or destination.resolve().is_relative_to(output)):
            raise RuntimeError("Archive must use a new path outside the product output")
    if args.archive and args.postgres_archive and args.archive.resolve() == args.postgres_archive.resolve():
        raise RuntimeError("Product and PostgreSQL archives need separate paths")
    if output.exists():
        raise RuntimeError("Choose a new output directory")
    output.mkdir(parents=True)
    shutil.copyfile(ROOT / "package.json", output / "package.json")
    shutil.copyfile(ROOT / "package-lock.json", output / "package-lock.json")
    result = subprocess.run(["npm.cmd", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=output, check=False)
    if result.returncode:
        raise RuntimeError("Production Node dependency installation failed")
    for name in ["distribution", "dist", "config", "third-party"]:
        copy_tree(ROOT / name, output / name)
    for name in ["third-party/flashrank"]:
        copy_tree(args.reranker / name, output / name)
    sys.path.insert(0, str(ROOT / "distribution"))
    from reranker import configuration
    configured = configuration(args.reranker)
    if configured["status"] != "ready":
        raise RuntimeError("Reranker must be prepared and verified for this alpha")
    components = json.loads((output / "config/components.json").read_text())
    components.update(reranker="flashrank", version=args.version, releaseReady=False, channel="alpha",
                      runtimePolicy="system_reuse", minimumVersions=MINIMUM_VERSIONS.copy())
    shutil.copyfile(ROOT / "docs/14-alpha-release.md", output / "QUICKSTART.md")
    compatibility = (ROOT / "docs/15-runtime-compatibility.md").read_text(encoding="utf-8").replace("(../config/", "(config/")
    (output / "15-runtime-compatibility.md").write_text(compatibility, encoding="utf-8")
    (output / "config/components.json").write_text(json.dumps(components, indent=2), encoding="utf-8")
    print("Hashing release files...", flush=True)
    model_directory = output.with_name(output.name + "-model-assets")
    model_components = model_archives(args.base, args.reranker, model_directory, args.version)
    value = manifest(output, args.version, model_components)
    print(json.dumps({"output": str(output), "files": len(value["files"]), "bytes": sum(f["size"] for f in value["files"])}), flush=True)
    if args.archive:
        archive_files(args.archive, [(path, path.relative_to(output).as_posix()) for path in sorted(output.rglob("*")) if path.is_file()])
    if args.postgres_archive:
        postgres_archive(args.base / "postgres", args.postgres_archive, components)
    if args.release_dir:
        release_assets(output, args.base / "postgres", args.release_dir, args.version, components, model_directory)

if __name__ == "__main__":
    main()
