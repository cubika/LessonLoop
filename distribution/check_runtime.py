"""Read-only compatibility checks before a local code-version activation."""
import json
from importlib.metadata import version
from pathlib import Path
import sys
import psycopg2

runtime=Path(__file__).resolve().parents[1]
config=json.load(sys.stdin)
components=json.loads((runtime/"config/components.json").read_text(encoding="utf-8-sig"))
if version("hindsight-api-slim")!=components["hindsight"]:raise SystemExit("Hindsight version mismatch")
import hindsight_api
import onnxruntime
model=runtime/"models/e5/onnx/model.onnx"
if not model.is_file():raise SystemExit("Embedding model missing")
db=psycopg2.connect(config["databaseUrl"],options="-c default_transaction_read_only=on")
with db:
    with db.cursor() as cur:
        cur.execute("SELECT version FROM lessonloop.schema_version")
        if cur.fetchall()!=[(1,)]:raise SystemExit("Product schema mismatch")
        cur.execute("SELECT name FROM (VALUES ('vector'),('pg_trgm')) AS expected(name) WHERE NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname=expected.name)")
        if cur.fetchall():raise SystemExit("Required database extension missing")
        cur.execute("SELECT to_regclass('hindsight.banks'),to_regclass('hindsight.async_operations'),to_regclass('lessonloop.objects')")
        if any(v is None for v in cur.fetchone()):raise SystemExit("Native or product schema missing")
        cur.execute("SELECT current_setting('server_version_num')::int/10000")
        if cur.fetchone()[0]!=int(components["postgresql"].split('.')[0]):raise SystemExit("PostgreSQL major mismatch")
db.close()
print(json.dumps({"status":"passed","mode":"read_only","hindsight":version("hindsight-api-slim"),"onnxRuntime":onnxruntime.__version__}))
