# RAG memory adapter provenance

Copied 2026-11-08 from the user's local project `E:\file\agent\python.v\project`.
The upstream MIT license is preserved in `LICENSE`; this directory is a local adaptation,
not an upstream release or an independently authored retriever.

| Local file | Source | Changes |
| --- | --- | --- |
| retriever.py | rag_core/retriever.py | Assistant-only configuration; CPU selection; local model paths only; no ModelScope download; isolated snapshot instead of paper/MySQL/corpus filters; local tokenizer dictionary path |
| conditional_cusum.reference.py | change_detection/conditional_cusum.py | Unmodified reference, not imported at runtime |
| LICENSE | LICENSE | Unmodified |
| config.py, __init__.py | New adapter files | Workspace settings and offline model environment |

See `provenance.json` for source and adapted SHA-256 hashes recorded at integration time.
On 2026-11-09 the adapted retriever added cumulative local model-load timing counters;
the adapted hash was refreshed. Retrieval ranking logic and the upstream files were unchanged.
Runtime imports this copy, not the source project's Python modules, configuration, database,
active corpus, or vector directory. The first implementation uses the existing Python 3.12
interpreter and local model weights read-only; those remain external runtime dependencies.
Paths can be changed in `configs/memory-v2.json` after preparing an independent environment.

The source environment has NumPy 1.26.4 and a SciPy version requiring NumPy 2.x. To avoid
changing it, the assistant loads a private SciPy 1.13.1 wheel from
`third_party/memory_rag_deps` before the source interpreter's site-packages. No other
package was installed into the source environment. Wheel licensing resides in its
installed dist-info directory; that machine-specific directory is excluded from source control.

Re-create the compatibility overlay using Python 3.12 on Windows:

```powershell
& 'E:\file\agent\python.v\.venv\Scripts\python.exe' -m pip install --target 'E:\file\agent\ai assistant\third_party\memory_rag_deps' --no-deps --only-binary=:all: scipy==1.13.1
```

Version/wheel reference: <https://pypi.org/project/scipy/1.13.1/>.
This command is not a complete environment installer. The existing runtime also supplies
NumPy, torch, transformers, sentence-transformers, qdrant-client, rank-bm25 and jieba.
No CUDA is installed by this integration; inference is configured for CPU.
