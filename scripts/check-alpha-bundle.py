"""Audit alpha files, hashes and runtime isolation without printing credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

parser=argparse.ArgumentParser();parser.add_argument("bundle",type=Path);args=parser.parse_args()
root=args.bundle.resolve();manifest=json.loads((root/"manifest.json").read_text())
if not list((root/"python/Lib/site-packages/hindsight_api/alembic/versions").glob("*.py")):raise RuntimeError("Official Hindsight migrations missing")
actual={p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
expected={f["path"] for f in manifest["files"]}|{"manifest.json"}
if actual!=expected:raise RuntimeError("Files differ from manifest: "+str(len(actual^expected)))
for item in manifest["files"]:
 path=root/item["path"]
 with path.open("rb") as stream:hash_value=hashlib.file_digest(stream,"sha256").hexdigest()
 if path.stat().st_size!=item["size"] or hash_value!=item["sha256"]:raise RuntimeError("Hash mismatch: "+item["path"])
 if path.name in {"secrets.dpapi","development-secret.json","active.json","installation.json","postmaster.pid","pyvenv.cfg"}:raise RuntimeError("Forbidden file: "+item["path"])
 if path.suffix in {".json",".toml",".yaml",".yml",".ini",".cfg",".py",".js",".ps1",".md",".txt"} and path.stat().st_size<4*1024*1024:
  text=path.read_text(encoding="utf-8",errors="ignore")
  if re.search(r"gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}",text):raise RuntimeError("Credential-shaped content in: "+item["path"])
command=[str(root/"python/python.exe"),"-I","-B","-c","import sys,json,ssl,sqlite3,asyncpg,psycopg2,onnxruntime,tokenizers,hindsight_api,copilot; from pathlib import Path; from alembic.config import Config; from alembic.script import ScriptDirectory; c=Config(); c.set_main_option('script_location',str(Path(hindsight_api.__file__).parent/'alembic')); heads=ScriptDirectory.from_config(c).get_heads(); assert heads; print(json.dumps({'prefix':sys.prefix,'base':sys.base_prefix,'paths':sys.path,'migrationHeads':heads}))"]
r=subprocess.run(command,capture_output=True,text=True,timeout=60)
if r.returncode:raise RuntimeError("Private Python import check failed: "+r.stderr[:500])
paths=json.loads(r.stdout)
if Path(paths["prefix"]).resolve()!=root/"python" or Path(paths["base"]).resolve()!=root/"python":raise RuntimeError("Python uses an external runtime")
if any(not Path(p).resolve().is_relative_to(root) for p in paths["paths"] if p):raise RuntimeError("Python path escapes package")
node=subprocess.run([str(root/"node/node.exe"),"--version"],capture_output=True,text=True,timeout=10,check=True).stdout.strip()
print(json.dumps({"status":"passed","files":len(manifest["files"]),"bytes":sum(f["size"] for f in manifest["files"]),"python":"isolated_imports_passed","node":node,"credentialPatternScan":"passed","channel":manifest["channel"]}))
