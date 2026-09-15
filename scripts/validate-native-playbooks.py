"""Run the native commit contract in a disposable database; never reuse product data."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4
import psycopg2

root = Path(__file__).resolve().parents[1]
config_path = Path(sys.argv[1] if len(sys.argv) > 1 else root / '.local-validation/data/core-config.json')
config = json.loads(config_path.read_text(encoding='utf-8'))
name = 'll_native_methods_' + uuid4().hex[:12]
assert re.fullmatch(r'll_native_methods_[a-f0-9]{12}', name)
parts = urlsplit(config['databaseUrl'])
url = urlunsplit((parts.scheme, parts.netloc, '/' + name, '', ''))
db = psycopg2.connect(config['databaseUrl'])
db.autocommit = True
try:
    with db.cursor() as cur:
        cur.execute('CREATE DATABASE "' + name + '"')
    result = subprocess.run([sys.executable, '-I', '-B', str(root / 'tests/hindsight_playbook_commit_test.py')],
        env={**os.environ, 'LESSONLOOP_TEST_DATABASE_URL': url}, cwd=root,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=180)
    sys.exit(result.returncode)
finally:
    with db.cursor() as cur:
        cur.execute('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)')
    db.close()
