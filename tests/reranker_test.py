"""The runtime must never choose a missing or changed local reranker."""
import importlib.util
import json
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("reranker", ROOT / "distribution/reranker.py")
reranker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reranker)

with tempfile.TemporaryDirectory(prefix="lessonloop-reranker-") as directory:
    root = Path(directory)
    assert reranker.configuration(root)["reason"] == "reranker_not_configured"
    assert reranker.environment(reranker.configuration(root)) == {"HINDSIGHT_API_RERANKER_PROVIDER": "rrf"}
    manifest = json.loads((ROOT / "config/reranker.json").read_text(encoding="utf-8"))
    model = root / manifest["cacheDirectory"] / manifest["modelName"]
    python = root / manifest["pythonDirectory"]
    for group, target in [("model", model), ("flashrank", python)]:
        for name in manifest[group]["files"]:
            path = target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic " + name, encoding="utf-8")
            manifest[group]["files"][name] = reranker.file_hash(path)
    original = model / "tokenizer.original.json"
    original.write_bytes((model / "tokenizer.json").read_bytes())
    manifest["tokenizerRepair"]["sha256"] = reranker.file_hash(model / "tokenizer.json")
    config_path = root / "config/reranker.json"
    config_path.parent.mkdir()
    config_path.write_text(json.dumps(manifest), encoding="utf-8")
    selected = reranker.configuration(root)
    assert selected["status"] == "ready" and selected["provider"] == "flashrank"
    env = reranker.environment(selected)
    assert env["HINDSIGHT_API_RERANKER_FLASHRANK_CACHE_DIR"] == str(model.parent)
    assert env["HINDSIGHT_API_RERANKER_FLASHRANK_BATCH_SIZE"] == "8"
    (model / "tokenizer.json").write_text("unverified tokenizer", encoding="utf-8")
    assert reranker.configuration(root)["reason"] == "reranker_checksum_mismatch"
    (model / "tokenizer.json").unlink()
    assert reranker.configuration(root)["reason"] == "reranker_files_missing"
    manifest["pythonDirectory"] = "../outside"
    config_path.write_text(json.dumps(manifest), encoding="utf-8")
    assert reranker.configuration(root)["reason"] == "invalid_reranker_path"

print("Reranker selection checks passed: explicit fallback, checked files, tokenizer repair, paths and environment.")
