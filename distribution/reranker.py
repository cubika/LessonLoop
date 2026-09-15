"""Verify the optional pinned local reranker; never fetch files during startup."""
import argparse
import hashlib
import json
from pathlib import Path


def file_hash(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def configuration(runtime, manifest=None):
    runtime = Path(runtime).resolve()
    config_path = Path(manifest) if manifest else runtime / "config/reranker.json"
    fallback = {"provider": "rrf", "status": "fallback"}
    try:
        config = json.loads(config_path.read_text(encoding="utf-8-sig"))
        model = runtime / config["cacheDirectory"] / config["modelName"]
        python = runtime / config["pythonDirectory"]
        if not model.resolve().is_relative_to(runtime) or not python.resolve().is_relative_to(runtime):
            return {**fallback, "reason": "invalid_reranker_path"}
        files = {model / name: expected for name, expected in config["model"]["files"].items()}
        files[model / "tokenizer.original.json"] = files[model / "tokenizer.json"]
        files[model / "tokenizer.json"] = config["tokenizerRepair"]["sha256"]
        files.update({python / name: expected for name, expected in config["flashrank"]["files"].items()})
        for path, expected in files.items():
            if not path.resolve().is_relative_to(runtime):
                return {**fallback, "reason": "invalid_reranker_path"}
            if not path.is_file():
                return {**fallback, "reason": "reranker_files_missing"}
            if file_hash(path) != expected:
                return {**fallback, "reason": "reranker_checksum_mismatch"}
        return {"provider": config["provider"], "status": "ready", "model": config["modelName"],
                "cacheDirectory": str(model.parent), "pythonDirectory": str(python),
                "batchSize": config["batchSize"], "maxCandidates": config["maxCandidates"]}
    except (OSError, ValueError, KeyError, TypeError):
        return {**fallback, "reason": "reranker_not_configured"}


def environment(config):
    result = {"HINDSIGHT_API_RERANKER_PROVIDER": config["provider"]}
    if config["status"] == "ready":
        result.update(HINDSIGHT_API_RERANKER_FLASHRANK_MODEL=config["model"],
                      HINDSIGHT_API_RERANKER_FLASHRANK_CACHE_DIR=config["cacheDirectory"],
                      HINDSIGHT_API_RERANKER_FLASHRANK_CPU_MEM_ARENA="false",
                      HINDSIGHT_API_RERANKER_FLASHRANK_BATCH_SIZE=str(config["batchSize"]),
                      HINDSIGHT_API_RERANKER_MAX_CANDIDATES=str(config["maxCandidates"]))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("runtime")
    parser.add_argument("--manifest")
    parser.add_argument("--require-ready", action="store_true")
    args = parser.parse_args()
    result = configuration(args.runtime, args.manifest)
    print(json.dumps(result))
    raise SystemExit(1 if args.require_ready and result["status"] != "ready" else 0)
