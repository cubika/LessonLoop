"""Download a pinned local model; verify bytes before activation."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--manifest", required=True)
parser.add_argument("--destination", required=True)
args = parser.parse_args()
root = Path(args.destination).resolve()
manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
for item in manifest["files"]:
    target = (root / item["file"]).resolve()
    if not target.is_relative_to(root):
        raise SystemExit("Model path escapes destination")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and hashlib.file_digest(target.open("rb"), "sha256").hexdigest() == item["sha256"]:
        continue
    partial = target.with_suffix(target.suffix + ".partial")
    with urllib.request.urlopen(item["url"], timeout=60) as response, partial.open("wb") as out:
        while chunk := response.read(1024 * 1024):
            out.write(chunk)
    with partial.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != item["sha256"] or partial.stat().st_size != item["size"]:
        raise SystemExit("Model checksum or size mismatch")
    partial.replace(target)
    print(item["file"] + " verified", flush=True)
