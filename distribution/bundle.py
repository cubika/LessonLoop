"""Verified local release bundles and compatible code-version switches."""
import hashlib
import json
import os
from pathlib import Path
import shutil
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor


def unlinked(path):
    path = Path(os.path.abspath(path))
    for ancestor in [path, *path.parents]:
        if ancestor.exists() and (ancestor.is_symlink() or getattr(ancestor, "is_junction", lambda: False)()):
            raise ValueError("Linked bundle or installation path")
    return path


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify(root, allow_development=False):
    root = unlinked(root)
    if not root.is_dir():raise ValueError("Bundle root missing")
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if manifest.get("platform") != "win32-x64":
        raise ValueError("Unsupported bundle platform")
    if not manifest.get("releaseReady") and not allow_development:
        raise ValueError("Bundle has not passed release acceptance")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("Empty bundle manifest")
    names = set()
    pending_checks=[]
    checked_directories = {root}
    for item in files:
        name = item["path"].replace("\\", "/")
        parts = name.split("/")
        reserved={"con","prn","aux","nul",*("com"+str(i) for i in range(1,10)),*("lpt"+str(i) for i in range(1,10))}
        if any(not part or part in [".", ".."] or ":" in part or part.endswith((".", " ")) or part.split(".")[0].casefold() in reserved for part in parts) or name.startswith("/"):
            raise ValueError("Unsafe manifest path")
        normalized = name.casefold()
        if normalized in names or normalized == "manifest.json":
            raise ValueError("Duplicate manifest path")
        names.add(normalized)
        target = root.joinpath(*parts)
        for ancestor in [target, *target.parents]:
            if ancestor in checked_directories:break
            if ancestor.is_symlink() or getattr(ancestor, "is_junction", lambda: False)():raise ValueError("Linked bundle path")
            if ancestor!=target:checked_directories.add(ancestor)
        if not target.is_relative_to(root) or not target.is_file():
            raise ValueError("Missing owned bundle file")
        pending_checks.append((target,item["size"],item["sha256"],name))
    def check(item):
        target,size,expected,name=item
        if target.stat().st_size!=size or file_hash(target)!=expected:raise ValueError("Component hash mismatch: "+name)
    with ThreadPoolExecutor(max_workers=8) as executor:list(executor.map(check,pending_checks))
    required = {"python/python.exe", "node/node.exe", "distribution/runtime.py", "dist/cli/main.js", "config/components.json"}
    required.update(["distribution/launcher.ps1","distribution/check_runtime.py"])
    if not required.issubset(names):
        raise ValueError("Required runtime component missing")
    return manifest, file_hash(manifest_path)


def compatible(previous, incoming):
    fields = ["productSchema", "protocol", "hindsight", "postgresql", "pgvector", "activationCheck"]
    left, right = previous.get("compatibility", {}), incoming.get("compatibility", {})
    if any(left.get(key) is None or left.get(key) != right.get(key) for key in fields):
        raise ValueError("Incompatible bundle; explicit data migration is required")


def stage(bundle, program_root, allow_development=False, verified=None):
    bundle = unlinked(bundle)
    manifest, digest = verified if verified is not None else verify(bundle, allow_development)
    program_root = unlinked(program_root)
    versions = program_root / "versions"
    destination = unlinked(versions / digest)
    if destination.exists():
        existing, actual = verify(destination, allow_development)
        if actual != digest:
            raise ValueError("Staged version manifest changed")
        return destination, manifest, digest
    staging = unlinked(program_root / "staging" / (digest+"-"+str(uuid4())))
    staging.mkdir(parents=True, exist_ok=False)
    for item in manifest["files"]:
        source = Path(bundle) / item["path"]
        target = staging / item["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    shutil.copyfile(Path(bundle) / "manifest.json", staging / "manifest.json")
    verify(staging, allow_development)
    versions.mkdir(parents=True, exist_ok=True)
    staging.replace(destination)
    return destination, manifest, digest
