"""Prepare and score the pinned official FlashRank model without changing a running engine."""
import argparse
import asyncio
import importlib.metadata
import json
import math
import os
from pathlib import Path
import shutil
import socket
import sys
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "distribution"))
from reranker import configuration, environment, file_hash


def download(artifact, cache, offline):
    path = cache / artifact["filename"]
    if not path.exists():
        if offline:
            raise RuntimeError(f"Missing offline archive: {path.name}")
        temporary = path.with_suffix(".part")
        with urllib.request.urlopen(artifact["url"], timeout=60) as source, temporary.open("wb") as target:
            received = 0
            while chunk := source.read(1024 * 1024):
                received += len(chunk)
                if received > artifact["size"]:
                    raise RuntimeError("Download exceeds pinned size")
                target.write(chunk)
        temporary.replace(path)
    if path.stat().st_size != artifact["size"] or file_hash(path) != artifact["sha256"]:
        raise RuntimeError(f"Archive checksum mismatch: {path.name}")
    return path


def extract(archive, prefix, files, target):
    with zipfile.ZipFile(archive) as source:
        for name, expected in files.items():
            path = target / name
            if not path.resolve().is_relative_to(target.resolve()):
                raise RuntimeError("Archive path outside selected output")
            path.parent.mkdir(parents=True, exist_ok=True)
            with source.open(prefix + name) as incoming, path.open("wb") as outgoing:
                shutil.copyfileobj(incoming, outgoing)
            if file_hash(path) != expected:
                raise RuntimeError(f"Extracted checksum mismatch: {name}")


CASES = [
    {"language": "en", "query": "How do I restore a PostgreSQL database backup?",
     "documents": ["Use pg_restore to restore a PostgreSQL database from a custom-format backup.", "The cake should bake in an oven for thirty minutes."]},
    {"language": "zh", "query": "如何恢复数据库备份？",
     "documents": ["使用数据库备份文件恢复数据，并检查恢复后的数据是否完整。", "制作蛋糕时需要面粉和鸡蛋，然后放入烤箱。"]},
    {"language": "en", "query": "How do I fix a port already in use error?",
     "documents": ["Find the process listening on the port and stop it, or configure the application to use another port.", "Water the tomato plants regularly and give them sunlight."]},
    {"language": "zh", "query": "程序提示端口被占用时怎么处理？",
     "documents": ["检查哪个进程占用了端口，停止该进程或修改程序使用的端口。", "番茄需要充足的阳光和适量的水。"]},
]


async def score(config, output):
    from hindsight_api.engine.cross_encoder import create_cross_encoder_from_env
    ranker = create_cross_encoder_from_env()
    start = time.perf_counter()
    await ranker.initialize()
    initialized = time.perf_counter()
    pairs = [(case["query"], document) for case in CASES for document in case["documents"]]
    scores = [float(value) for value in await ranker.predict(pairs)]
    rows = []
    for index, case in enumerate(CASES):
        tokens = ranker._ranker.tokenizer.encode(case["query"]).tokens
        relevant, unrelated = scores[index * 2:index * 2 + 2]
        rows.append({**case, "scores": [relevant, unrelated], "queryTokens": tokens,
                     "passed": math.isfinite(relevant) and math.isfinite(unrelated) and relevant > unrelated})
    return {"passed": all(row["passed"] for row in rows), "initializeSeconds": round(initialized-start, 4),
            "predictSeconds": round(time.perf_counter()-initialized, 4), "cases": rows}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / ".local-validation/reranker-prepared")
    parser.add_argument("--downloads", type=Path, default=ROOT / ".local-validation/reranker-downloads")
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    config = json.loads((ROOT / "config/reranker.json").read_text(encoding="utf-8"))
    output, cache = args.output.resolve(), args.downloads.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    report = {"status": "failed", "externalNetworkDuringInference": False, "syntheticInputsOnly": True,
              "provider": config["provider"], "model": config["modelName"], "artifacts": {}}
    try:
        for name in ["model", "flashrank"]:
            artifact = config[name]
            archive = download(artifact, cache, args.offline)
            destination = output / (config["cacheDirectory"] + "/" + config["modelName"] if name == "model" else config["pythonDirectory"])
            prefix = config["modelName"] + "/" if name == "model" else artifact["archivePrefix"]
            extract(archive, prefix, artifact["files"], destination)
            report["artifacts"][name] = {"revision": artifact["revision"], "sha256": file_hash(archive), "size": archive.stat().st_size}
        versions = {name: importlib.metadata.version(name) for name in ["hindsight-api-slim", "onnxruntime", "tokenizers", "numpy", "requests", "tqdm"]}
        report["dependencies"] = versions
        if versions["hindsight-api-slim"] != config["hindsightVersion"] or versions["tokenizers"] != config["tokenizerRepair"]["tokenizersVersion"]:
            raise RuntimeError("Pinned Hindsight/tokenizer dependency version mismatch")
        (output / "config").mkdir(exist_ok=True)
        shutil.copyfile(ROOT / "config/reranker.json", output / "config/reranker.json")
        (output / config["pythonDirectory"] / "MODEL-NOTICE.txt").write_text(
            "FlashRank model distribution by Prithivi Damodaran (prithivida).\n"
            + f"Model: {config['modelName']}\nSource: {config['model']['url']}\n"
            + "Model archive license: CC-BY-SA-4.0 (https://creativecommons.org/licenses/by-sa/4.0/).\n"
            + "Modification: tokenizer.json regenerated from the supplied multilingual vocab.txt; original preserved as tokenizer.original.json.\n"
            + "The modified tokenizer is distributed under CC-BY-SA-4.0. Model weights are unchanged.\n"
            + f"FlashRank Python source: {config['flashrank']['url']}\n"
            + "FlashRank Python files are unchanged; their Apache-2.0 license is in LICENSE.\n", encoding="utf-8")
        sys.path.insert(0, str(output / config["pythonDirectory"]))
        os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", LITELLM_LOCAL_MODEL_COST_MAP="true", HINDSIGHT_API_EMBEDDINGS_PROVIDER="onnx")
        for key in list(os.environ):
            if key.startswith("HINDSIGHT_API_RERANKER_"):
                del os.environ[key]
        os.environ.update(environment({"provider": config["provider"], "status": "ready", "model": config["modelName"],
            "cacheDirectory": str(output / config["cacheDirectory"]), "batchSize": config["batchSize"], "maxCandidates": config["maxCandidates"]}))
        connect = socket.socket.connect
        connect_ex = socket.socket.connect_ex
        def deny_network(sock, address):
            # Windows asyncio creates its internal wakeup socket on loopback.
            if isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1"):
                return connect(sock, address)
            raise RuntimeError("External network access forbidden during reranker inference")
        def deny_network_ex(sock, address):
            if isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1"):
                return connect_ex(sock, address)
            raise RuntimeError("External network access forbidden during reranker inference")
        socket.socket.connect = deny_network
        socket.socket.connect_ex = deny_network_ex
        report["originalArchive"] = asyncio.run(score(config, output))
        from tokenizers import BertWordPieceTokenizer
        model = output / config["cacheDirectory"] / config["modelName"]
        original = json.loads((model / "tokenizer.json").read_text(encoding="utf-8"))
        (model / "tokenizer.json").replace(model / "tokenizer.original.json")
        repair = config["tokenizerRepair"]
        tokenizer = BertWordPieceTokenizer(str(model / "vocab.txt"), lowercase=repair["lowercase"],
                                          strip_accents=repair["stripAccents"], handle_chinese_chars=repair["handleChineseChars"])
        tokenizer.save(str(model / "tokenizer.json"))
        if file_hash(model / "tokenizer.json") != repair["sha256"]:
            raise RuntimeError("Generated tokenizer checksum mismatch")
        report["tokenizerRepair"] = {"originalVocabularySize": len(original["model"]["vocab"]),
                                     "repairedVocabularySize": tokenizer.get_vocab_size(), "sha256": repair["sha256"]}
        report["preparedModel"] = asyncio.run(score(config, output))
        report["runtimeConfiguration"] = configuration(output)
        if not report["preparedModel"]["passed"] or report["runtimeConfiguration"]["status"] != "ready":
            raise RuntimeError("Prepared reranker validation failed")
        for row in report["preparedModel"]["cases"]:
            if row["language"] == "zh" and "[UNK]" in row["queryTokens"]:
                raise RuntimeError("Chinese query contains unknown tokens")
        report["status"] = "passed"
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    (output / "validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": report["status"], "report": str(output / "validation.json"), "error": report.get("error")}))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
