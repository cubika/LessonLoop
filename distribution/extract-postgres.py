"""Extract the official pg0 PostgreSQL runtime in a disposable build directory."""
import argparse
import os
from pathlib import Path
import subprocess
import shutil

parser = argparse.ArgumentParser()
parser.add_argument("--destination", required=True)
args = parser.parse_args()
root = Path(args.destination).resolve()
root.mkdir(parents=True, exist_ok=True)
if (root / ".pg0").exists():
    raise SystemExit("Destination already contains a pg0 extraction; choose an empty build directory.")
import pg0
binary = Path(pg0.__file__).parent / "bin" / "pg0.exe"
env = {**os.environ, "USERPROFILE": str(root), "HOME": str(root)}
flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
with (root / "extract.log").open("w", encoding="utf-8") as log:
    result = subprocess.run([str(binary), "start", "--name", "lessonloop-build", "--data-dir", str(root / "scratch-db")], env=env, stdout=log, stderr=log, creationflags=flags, timeout=120)
    if result.returncode:
        raise SystemExit("PostgreSQL extraction failed; see the local extraction log.")
    result = subprocess.run([str(binary), "stop", "--name", "lessonloop-build"], env=env, stdout=log, stderr=log, creationflags=flags, timeout=60)
    if result.returncode:
        raise SystemExit("Build database did not stop; do not package this directory.")
# pg0 uses the Windows Known Folder API; USERPROFILE does not relocate its binary cache.
# This is a build-time extraction tool, never the end-user database manager.
import ctypes
buffer = ctypes.create_unicode_buffer(260)
if ctypes.windll.shell32.SHGetFolderPathW(None, 40, None, 0, buffer) != 0:
    raise SystemExit("Cannot locate the official pg0 component cache.")
cache = Path(buffer.value) / ".pg0" / "installation" / "18.1.0"
if not (cache / "bin" / "postgres.exe").is_file():
    raise SystemExit("Official PostgreSQL component not found after extraction.")
shutil.copytree(cache, root / "postgres", dirs_exist_ok=True)
print("Copied official PostgreSQL binaries into the build directory; build database stopped.")
