# Pinned leCore retrieval subset

Upstream: <https://github.com/anoversizedmoosewithsocks/lecore>

Commit: `45dfab5608d7bfc96df987a1b42b3dbe6ce2fb8b` (immutable pin, not a moving branch).

License: upstream MIT; the unmodified upstream license is included as [`LICENSE`](LICENSE), copyright (c) 2026 AnOversizedMooseWithSocks. This notice applies to the vendored subset, not a blanket relicensing of this repository.

## Sources and original SHA-256

| Source at pinned commit | SHA-256 of original downloaded file |
| --- | --- |
| [`holographic/caching_and_storage/holographic_knowledgestore.py`](https://github.com/anoversizedmoosewithsocks/lecore/blob/45dfab5608d7bfc96df987a1b42b3dbe6ce2fb8b/holographic/caching_and_storage/holographic_knowledgestore.py) | `54b5fc3b76d5fd0e8a30cdef04d76af917b3537649361b0291af9defe12ba59e` |
| [`holographic/semantic_router/holographic_bm25.py`](https://github.com/anoversizedmoosewithsocks/lecore/blob/45dfab5608d7bfc96df987a1b42b3dbe6ce2fb8b/holographic/semantic_router/holographic_bm25.py) | `fb1cc8cc7eb4b4e23d19f9ce9901a36969e8a2b5773deea1ff74c541a70febce` |
| [`holographic/misc/holographic_determinism.py`](https://github.com/anoversizedmoosewithsocks/lecore/blob/45dfab5608d7bfc96df987a1b42b3dbe6ce2fb8b/holographic/misc/holographic_determinism.py) | `bf3e3c3f47c5d77a4bdcde0f7d128cd6cffd8028dec425cf0cec86cde9a2a784` |
| [`LICENSE`](https://github.com/anoversizedmoosewithsocks/lecore/blob/45dfab5608d7bfc96df987a1b42b3dbe6ce2fb8b/LICENSE) | `ea7e69e62da450b27a6ed4f64a8384f28fb23a1131fa8158522be26f8070d6d4` |

## Extraction and local changes

`retrieval.py` was extracted with Python's AST parser/unparser from those files, not reimplemented from a description:

- `chunk_text` from the knowledge-store file, without the `KnowledgeStore` class, persistence code, engine imports, or self-tests.
- `topk_det` from the determinism file, without the other math/randomness helpers or self-tests.
- `BM25`, its tokenization/stemming helper functions and constants, and only the required imports (`math`, `collections.Counter`, `re`, `numpy`) from the BM25 file. PRF, rank fusion, and upstream self-tests are excluded.
- Function docstrings and comments were removed to keep this small subset reviewable; AST unparsing also normalizes formatting and quoting. A concise module header was added. Numeric formulas, tokenization, chunking, and tie ordering are unchanged.
- `BM25(..., slim=True)` now raises `ValueError`. The cold-store import and branch are removed, and `_corpus_stats()` directly returns the in-memory data. The default `slim=False` scoring path is preserved. No full-engine component can be loaded through this subset.
- `BM25.rank()` refers to the `topk_det` defined in the same module rather than importing the full upstream package. Other constructor/scoring options remain available, but the local session integration uses normal lexical scoring without expansion.

There are no filesystem/network/process operations in the selected implementation. The only non-standard dependency is NumPy. Importing it does not import or initialize the leCore engine. The upstream project, its installer/bootstrapper, services, weights, and storage container are not included.

## Limits and integration responsibilities

BM25 is **lexical retrieval**, not learned embeddings, a model context extension, or infinite attention. This upstream tokenizer uses ASCII alphanumeric tokens, a small English stoplist, and light stemming; queries consisting only of ignored tokens or unmatched terms score zero. The caller must filter zero scores rather than pretending they are relevant matches.

Call `chunk_text(..., min_chars=1)` to retain short nonempty paragraphs, including short paragraphs preceding a longer one; the upstream default is preserved in this vendored API. Chunked text normalizes paragraph whitespace, so original text must be persisted separately by the integration.

The caller, not this math subset, must enforce session scoping, input validation, persistence, version/index invalidation, quotas, and finite prompt budgets. Retrieved text remains untrusted evidence.

Run the isolated synthetic conformance checks from the repository root:

```sh
python3 -m unittest discover -s vendor/lecore -p 'test_*.py'
```

The extraction was also compared against the pinned source functions on deterministic synthetic cases: default/expanded BM25 scores, repeated-query terms, chunk outputs with `min_chars=1`, and stable top-k tie ordering. Those development comparisons used only the three downloaded files above; shipped tests do not fetch or execute upstream code.
