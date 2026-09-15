"""Prepare pinned model files during installation; reuse verified local bytes."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
import urllib.parse
import urllib.request
import uuid
import zipfile

from bundle import file_hash, unlinked


def components(manifest):
    result = manifest.get("modelComponents", [])
    if not isinstance(result, list):
        raise ValueError("Invalid model components")
    if manifest.get("modelPolicy") == "download_on_install" and not result:
        raise ValueError("Required model components missing")
    names, paths = set(), set()
    for component in result:
        name = component.get("name")
        if name not in {"e5", "reranker"} or name in names:
            raise ValueError("Invalid or duplicate model component")
        names.add(name)
        archive = component.get("archive", "")
        if not re.fullmatch(r"[A-Za-z0-9._-]+\.zip", archive):
            raise ValueError("Invalid model archive name")
        url = urllib.parse.urlsplit(component.get("url", ""))
        if url.scheme != "https" or not url.netloc or url.username or url.password:
            raise ValueError("Model download requires HTTPS")
        for item in [component, *component.get("files", [])]:
            if not isinstance(item.get("size"), int) or item["size"] <= 0 or not re.fullmatch(r"[a-f0-9]{64}", item.get("sha256", "")):
                raise ValueError("Invalid model size or checksum")
        if not component.get("files"):
            raise ValueError("Empty model component")
        for item in component["files"]:
            path = item.get("path", "")
            parts = path.split("/")
            reserved = {"con", "prn", "aux", "nul", *("com" + str(i) for i in range(1, 10)), *("lpt" + str(i) for i in range(1, 10))}
            if not path.startswith("models/" + name + "/") or "\\" in path or any(
                part in {"", ".", ".."} or ":" in part or part.endswith((".", " ")) or part.split(".")[0].casefold() in reserved for part in parts
            ) or path.casefold() in paths:
                raise ValueError("Unsafe or duplicate model path")
            paths.add(path.casefold())
    if result and names != {"e5", "reranker"}:
        raise ValueError("Both embedding and reranker components are required")
    e5 = {"models/e5/" + name for name in ["onnx/model.onnx", "tokenizer.json", "config.json", "tokenizer_config.json", "special_tokens_map.json"]}
    if result and not e5.issubset(paths):
        raise ValueError("Required embedding files missing")
    return result


def matches(path, item):
    path = unlinked(path)
    return path.is_file() and path.stat().st_size == item["size"] and file_hash(path) == item["sha256"]


def verify_models(runtime, manifest=None):
    runtime = unlinked(runtime)
    manifest = manifest or json.loads(unlinked(runtime / "manifest.json").read_text(encoding="utf-8-sig"))
    for component in components(manifest):
        for item in component["files"]:
            if not matches(runtime / item["path"], item):
                raise ValueError("Model file missing or changed: " + item["path"])


def copy_verified(source, target, item):
    target = unlinked(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = unlinked(target.with_name(target.name + ".partial-" + uuid.uuid4().hex))
    try:
        shutil.copyfile(unlinked(source), temporary)
        if not matches(temporary, item):
            raise ValueError("Model file checksum mismatch: " + item["path"])
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def fetch_archive(component, cache):
    cache = unlinked(cache)
    cache.mkdir(parents=True, exist_ok=True)
    target = unlinked(cache / (component["sha256"] + ".zip"))
    if matches(target, component):
        return target
    downloaded = unlinked(cache / component["archive"])
    if matches(downloaded, component):
        return downloaded
    if shutil.disk_usage(cache).free < component["size"]:
        raise RuntimeError("Insufficient free space for the model download")
    temporary = unlinked(cache / (component["sha256"] + ".partial-" + uuid.uuid4().hex))
    try:
        print("Downloading " + component["name"] + " model (" + str(round(component["size"] / 1_000_000, 1)) + " MB)...", flush=True)
        with urllib.request.urlopen(component["url"], timeout=60) as response, temporary.open("wb") as output:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > component["size"]:
                    raise ValueError("Model archive exceeds its declared size")
                output.write(chunk)
        if not matches(temporary, component):
            raise ValueError("Model archive checksum mismatch")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def extract_component(archive, component, destination):
    expected = {item["path"]: item for item in component["files"]}
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if len(entries) != len(expected) or {entry.filename for entry in entries} != set(expected):
            raise ValueError("Model archive contains undeclared or duplicate files")
        for entry in entries:
            item = expected[entry.filename]
            if entry.is_dir() or entry.file_size != item["size"] or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("Invalid model archive entry")
            target = unlinked(destination / PurePosixPath(entry.filename))
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open(entry) as incoming, target.open("wb") as output:
                shutil.copyfileobj(incoming, output)
            if not matches(target, item):
                raise ValueError("Model file checksum mismatch: " + entry.filename)


def prepare_models(runtime, reuse=None, cache=None):
    runtime = unlinked(runtime)
    manifest = json.loads(unlinked(runtime / "manifest.json").read_text(encoding="utf-8-sig"))
    declared = components(manifest)
    cache = Path(cache) if cache else Path(os.environ.get("LOCALAPPDATA", str(runtime.parent))) / "LessonLoopComponents/model-downloads"
    for component in declared:
        missing = [item for item in component["files"] if not matches(runtime / item["path"], item)]
        if reuse:
            for item in missing:
                source = unlinked(Path(reuse) / item["path"])
                if matches(source, item):
                    copy_verified(source, runtime / item["path"], item)
            missing = [item for item in missing if not matches(runtime / item["path"], item)]
        if not missing:
            print("Reusing verified " + component["name"] + " model.", flush=True)
            continue
        required = sum(item["size"] for item in component["files"]) + sum(item["size"] for item in missing)
        if shutil.disk_usage(runtime).free < required:
            raise RuntimeError("Insufficient free space for model files")
        archive = fetch_archive(component, cache)
        # The temporary directory belongs to this invocation and is always removed.
        with tempfile.TemporaryDirectory(prefix=".model-stage-", dir=runtime) as temporary:
            staging = unlinked(temporary)
            extract_component(archive, component, staging)
            for item in missing:
                copy_verified(staging / item["path"], runtime / item["path"], item)
    verify_models(runtime, manifest)
    if declared:
        from reranker import configuration
        if configuration(runtime)["status"] != "ready":
            raise RuntimeError("Prepared reranker failed its pinned file checks")
    return {"status": "ready", "components": [item["name"] for item in declared]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--reuse")
    parser.add_argument("--cache")
    args = parser.parse_args()
    print(json.dumps(prepare_models(args.runtime, args.reuse, args.cache)))
