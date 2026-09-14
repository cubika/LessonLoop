"""Create a manifest from final local bundle bytes."""
import argparse
import hashlib
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
parser=argparse.ArgumentParser();parser.add_argument("root");args=parser.parse_args();root=Path(args.root).resolve()
def record(path):
    if path.is_symlink():raise RuntimeError("Bundle symlink not allowed")
    with path.open("rb") as stream:digest=hashlib.file_digest(stream,"sha256").hexdigest()
    return {"path":path.relative_to(root).as_posix(),"size":path.stat().st_size,"sha256":digest}
paths=[p for p in root.rglob("*") if p.is_file() and p!=root/"manifest.json" and "__pycache__" not in p.parts]
with ThreadPoolExecutor(max_workers=12) as executor:files=list(executor.map(record,paths))
manifest={"version":"0.0.1-dev","platform":"win32-x64","releaseReady":False,"files":sorted(files,key=lambda f:f["path"])}
(root/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8")
print(json.dumps({"files":len(files),"bytes":sum(f["size"] for f in files),"releaseReady":False}))
