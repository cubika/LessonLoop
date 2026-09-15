"""Private PostgreSQL lifecycle. Passwords are read from stdin, never argv."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import ctypes

parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["init", "start", "stop", "status"])
parser.add_argument("--runtime", required=True)
parser.add_argument("--data-root", required=True)
parser.add_argument("--port", type=int, default=19432)
args = parser.parse_args()
root = Path(args.data_root).resolve()
runtime = Path(args.runtime).resolve()
db = root / "storage" / "postgres"
flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
root.mkdir(parents=True, exist_ok=True)
def windows_path(path):
    value=str(path)
    if os.name!="nt":return value
    buffer=ctypes.create_unicode_buffer(32768)
    length=ctypes.windll.kernel32.GetShortPathNameW(value,buffer,len(buffer))
    return buffer.value if length else value
owner = root / "database-owner.json"
def run(name, options):
    with (root / "database-manager.log").open("ab") as log:
        result = subprocess.run([windows_path(runtime / "bin" / (name + ".exe")), *options], stdout=log, stderr=log, creationflags=flags, timeout=60)
    if result.returncode:
        raise RuntimeError(f"{name} failed with exit {result.returncode}; inspect the database log")
if args.action == "init":
    if owner.exists() or (db.exists() and any(db.iterdir())):
        raise SystemExit("Database already exists; initialization refused. Empty interrupted directories may be retried.")
    password = json.load(sys.stdin)["password"]
    if len(password) < 32:
        raise SystemExit("A generated database password is required.")
    db.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", delete=False, dir=root, encoding="utf-8") as secret:
        secret.write(password + "\n")
        secret_path = Path(secret.name)
    try:
        db.mkdir(exist_ok=True)
        run("initdb", ["-D", windows_path(db), "-U", "lessonloop", "--pwfile", windows_path(secret_path), "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C"])
    finally:
        secret_path.unlink(missing_ok=True)
    with (db / "postgresql.conf").open("a", encoding="utf-8") as out:
        out.write(f"\nlisten_addresses = '127.0.0.1'\nport = {args.port}\nshared_buffers = '128MB'\nlogging_collector = off\n")
    owner.write_text(json.dumps({"dataRoot": str(root), "database": str(db), "runtime": str(runtime), "port": args.port}), encoding="utf-8")
else:
    record = json.loads(owner.read_text(encoding="utf-8"))
    if record["dataRoot"] != str(root) or record["runtime"] != str(runtime) or record["database"] != str(db):
        raise SystemExit("Database ownership does not match.")
    if args.action == "start":
        (root/"postgres.log").touch(exist_ok=True)
        run("pg_ctl", ["-D", windows_path(db), "-l", windows_path(root / "postgres.log"), "-w", "start"])
    elif args.action == "stop":
        run("pg_ctl", ["-D", windows_path(db), "-m", "fast", "-w", "stop"])
    else:
        run("pg_ctl", ["-D", windows_path(db), "status"])
print(json.dumps({"action": args.action, "status": "confirmed", "port": args.port}))
