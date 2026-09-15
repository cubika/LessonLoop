# Local reranker validation

Validated on Windows with Hindsight 0.9.2, ONNX Runtime 1.30.0 and tokenizers 0.22.2. The test uses Hindsight's `create_cross_encoder_from_env()` and `FlashRankCrossEncoder`, with synthetic English and Chinese query/document pairs. It does not start an engine or touch product data.

The selected model is FlashRank's `ms-marco-MultiBERT-L-12`. Its official archive is 103,473,926 bytes; the ONNX file is 168,184,839 bytes. [The manifest](../../../config/reranker.json) pins the model and FlashRank source commits, archive checksums and extracted file checksums. FlashRank uses the existing ONNX/tokenizers dependencies; no PyTorch or SentenceTransformers installation was needed.

## Tokenizer issue and correction

The official archive contains a `tokenizer.json` with 30,522 entries alongside a multilingual `vocab.txt` and a model configuration declaring 105,879 vocabulary entries. The original tokenizer converted all nine Chinese characters in `如何恢复数据库备份？` to `[UNK]`. It ranked the unrelated cake passage above the database restoration passage.

The preparation script preserves that file as `tokenizer.original.json` and creates a tokenizer from the archive's own `vocab.txt` using `tokenizers.BertWordPieceTokenizer`. Lowercasing and Chinese-character handling follow the supplied tokenizer configuration. The generated tokenizer has 105,879 entries and a pinned SHA256. The model weights and FlashRank Python files are unchanged. This correction is recorded in the manifest and remains subject to the model archive's CC-BY-SA-4.0 license; the script preserves FlashRank's Apache-2.0 license.

| Synthetic case | Original relevant / unrelated | Corrected relevant / unrelated | Corrected order |
|---|---:|---:|---|
| English database restoration | 0.999151 / 0.000538 | 0.998799 / 0.000019 | Pass |
| Chinese database restoration | 0.561030 / 0.614659 | 0.974492 / 0.000314 | Pass |
| English port conflict | 0.995293 / 0.003325 | 0.965048 / 0.000176 | Pass |
| Chinese port conflict | 0.997927 / 0.002648 | 0.928046 / 0.000576 | Pass |

All corrected Chinese query tokens are known. These four cases establish executable bilingual scoring and catch the tokenizer defect. They do not establish retrieval quality on the product evaluation corpus.

## Reproduction and activation

Run with the private Python runtime:

```powershell
.local-validation/bundle-dev/python/python.exe scripts/prepare-reranker.py
.local-validation/bundle-dev/python/python.exe scripts/prepare-reranker.py --offline
.local-validation/bundle-dev/python/python.exe distribution/reranker.py .local-validation/reranker-prepared --require-ready
```

The script downloads only pinned public archives. Inference denies connections outside loopback; Windows asyncio uses loopback for its internal wakeup socket. The JSON report includes all input text, scores, tokenizer tokens, dependency versions and artifact hashes at `.local-validation/reranker-prepared/validation.json`. PyPI's wheel host failed TLS during this run, so the manifest uses the official GitHub 0.2.9 source tag. The model archive and tagged source archive both downloaded successfully and matched their recorded hashes.

`build-bundle.ps1 -Reranker .local-validation/reranker-prepared` verifies and copies the optional model and official Python files. The bundle's `components.reranker` records the prepared provider. Runtime startup verifies the files again before selecting FlashRank with batches of 8 and at most 64 candidates. Missing or modified files select `rrf` with an explicit reason. Startup never downloads a model. Doctor reports prepared files separately from the provider recorded for the running engine. The validation run left the existing engine and database processes unchanged.

## Sources

- [Hindsight API Slim 0.9.2](https://pypi.org/project/hindsight-api-slim/0.9.2/), with `hindsight_api/engine/cross_encoder.py` inspected in the installed package.
- [Official FlashRank 0.2.9 source](https://github.com/PrithivirajDamodaran/FlashRank/tree/00486e55ad9ad86158cea7e56eb51969f6498c54), including the supported-model table and ONNX loader.
- [Pinned model repository metadata](https://huggingface.co/api/models/prithivida/flashrank/revision/858a1ac046a05663a35367eac852d7f76feeefdd?blobs=true), including the archive's LFS SHA256 and CC-BY-SA-4.0 declaration.
