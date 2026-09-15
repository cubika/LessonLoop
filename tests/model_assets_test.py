import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).parents[1] / "distribution"))
import model_assets
import lifecycle


class ModelAssetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lessonloop-models-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.runtime = self.root / "program"
        self.runtime.mkdir()
        self.cache = self.root / "cache"
        self.archives = {}
        self.manifest = {"platform": "win32-x64", "files": [], "modelPolicy": "download_on_install", "modelComponents": []}
        for group, names in [("e5", ["onnx/model.onnx", "tokenizer.json", "config.json", "tokenizer_config.json", "special_tokens_map.json"]),
                             ("reranker", ["model.onnx", "tokenizer.json", "tokenizer.original.json"])]:
            files = []
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                for name in names:
                    data = (group + "/" + name).encode()
                    path = "models/" + group + "/" + name
                    archive.writestr(path, data)
                    files.append({"path": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            data = buffer.getvalue()
            url = "https://example.invalid/" + group + ".zip"
            self.archives[url] = data
            self.manifest["modelComponents"].append({"name": group, "archive": group + ".zip", "url": url,
                "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "files": files})
        self.save(self.runtime)
        self.reranker = patch("reranker.configuration", return_value={"status": "ready"})
        self.reranker.start()
        self.addCleanup(self.reranker.stop)

    def save(self, runtime):
        (runtime / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def download(self, url, **kwargs):
        return io.BytesIO(self.archives[url])

    def test_first_install_downloads_once_then_retry_and_upgrade_reuse_without_network(self):
        with patch.object(model_assets.urllib.request, "urlopen", side_effect=self.download) as network:
            result = model_assets.prepare_models(self.runtime, cache=self.cache)
            self.assertEqual(result["components"], ["e5", "reranker"])
            self.assertEqual(network.call_count, 2)
        with patch.object(model_assets.urllib.request, "urlopen", side_effect=AssertionError("Unexpected download")):
            model_assets.prepare_models(self.runtime, cache=self.cache)
            upgraded = self.root / "upgrade"
            upgraded.mkdir()
            self.save(upgraded)
            model_assets.prepare_models(upgraded, reuse=self.runtime, cache=self.root / "empty-cache")
            model_assets.verify_models(upgraded)
            damaged = self.runtime / "models/e5/tokenizer.json"
            damaged.write_bytes(b"damaged")
            model_assets.prepare_models(self.runtime, cache=self.cache)
            model_assets.verify_models(self.runtime)
        owned = lifecycle.manifest_paths(self.runtime)
        self.assertIn("models/e5/onnx/model.onnx", owned)
        self.assertIn("models/reranker/tokenizer.original.json", owned)
        self.assertFalse(any("cache" in name for name in owned))

    def test_manually_downloaded_named_archives_are_accepted_without_network(self):
        self.cache.mkdir()
        for component in self.manifest["modelComponents"]:
            (self.cache / component["archive"]).write_bytes(self.archives[component["url"]])
        with patch.object(model_assets.urllib.request, "urlopen", side_effect=AssertionError("Unexpected download")):
            model_assets.prepare_models(self.runtime, cache=self.cache)
        model_assets.verify_models(self.runtime)

    def test_failed_or_corrupted_download_does_not_activate_models_and_can_retry(self):
        with patch.object(model_assets.urllib.request, "urlopen", side_effect=OSError("disconnected")):
            with self.assertRaises(OSError):
                model_assets.prepare_models(self.runtime, cache=self.cache)
        self.assertFalse((self.runtime / "models/e5/onnx/model.onnx").exists())
        self.assertFalse(list(self.cache.glob("*.partial-*")))
        with patch.object(model_assets.urllib.request, "urlopen", return_value=io.BytesIO(b"bad archive")):
            with self.assertRaisesRegex(ValueError, "checksum"):
                model_assets.prepare_models(self.runtime, cache=self.cache)
        with patch.object(model_assets.urllib.request, "urlopen", side_effect=self.download):
            model_assets.prepare_models(self.runtime, cache=self.cache)

    def test_model_manifest_rejects_missing_components_paths_and_hashes(self):
        for mutate in [lambda m: m.pop("modelComponents"), lambda m: m.update(modelComponents=[]),
                       lambda m: m["modelComponents"].pop(),
                       lambda m: m["modelComponents"][0]["files"].pop(),
                       lambda m: m["modelComponents"][0].update(url="http://example.invalid/model.zip"),
                       lambda m: m["modelComponents"][0]["files"][0].update(path="models/e5/../../outside"),
                       lambda m: m["modelComponents"][0]["files"][0].update(path="models/e5/file:stream"),
                       lambda m: m["modelComponents"][0]["files"][0].update(path="models/e5/NUL"),
                       lambda m: m["modelComponents"][0]["files"].append(m["modelComponents"][0]["files"][0])]:
            manifest = copy.deepcopy(self.manifest)
            mutate(manifest)
            with self.assertRaises(ValueError):
                model_assets.components(manifest)

    def test_archive_rejects_undeclared_entries_before_writing_any_files(self):
        component = self.manifest["modelComponents"][0]
        archive = self.root / "unsafe.zip"
        archive.write_bytes(self.archives[component["url"]])
        with zipfile.ZipFile(archive, "a") as changed:
            changed.writestr("../../outside", "unowned")
        destination = self.root / "extract"
        destination.mkdir()
        with self.assertRaisesRegex(ValueError, "undeclared"):
            model_assets.extract_component(archive, component, destination)
        self.assertEqual(list(destination.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
