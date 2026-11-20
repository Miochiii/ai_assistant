"""Local CPU retrieval, optionally persistent over stdio. No API or downloads."""
import contextlib
import hashlib
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'third_party'))
sys.path.insert(0, str(ROOT / 'third_party/memory_rag_deps'))

def run(request, timing=None):
    timing = timing if timing is not None else {}
    started=time.perf_counter()
    from memory_rag import retriever as module
    HybridRetriever=module.HybridRetriever
    timing['import_ms']=round((time.perf_counter()-started)*1000,2)
    loads=dict(module.MODEL_LOAD_MS)
    timing['cold_embedding']=module._EMBEDDING_MODEL is None
    timing['cold_reranker']=module._RERANKER_MODEL is None
    items = request['items']
    if not items:
        return []
    partition = hashlib.sha256(request['scope'].encode()).hexdigest()
    snapshot = json.dumps(items, sort_keys=True, ensure_ascii=False)
    config = (ROOT / 'configs/memory-v2.json').read_bytes()
    generation = hashlib.sha256(snapshot.encode() + config).hexdigest()
    base = ROOT / 'runtime/memory/indexes' / partition
    base.mkdir(parents=True, exist_ok=True)
    # Windows OS lock is released even when the worker crashes.
    import msvcrt
    with (base / 'writer.lock').open('a+b') as lock:
        lock.seek(0); lock.write(b'0'); lock.flush(); lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        directory = base / generation
        directory.mkdir(exist_ok=True)
        retriever = HybridRetriever(vector_db_path=str(directory / 'vectors'))
        try:
            texts = [i['text'] for i in items]
            metas = [{'memory_id': i['memory_id']} for i in items]
            marker = directory / 'ready.json'
            index_start=time.perf_counter()
            timing['index_built']=not marker.exists()
            if not marker.exists():
                retriever.index(texts, metas)
                marker.write_text(json.dumps({'generation':generation,'count':len(items)}), encoding='utf-8')
            else:
                retriever.chunks, retriever.metadatas = texts, metas
                retriever._build_bm25()
            timing['index_ms']=round((time.perf_counter()-index_start)*1000,2)
            hits = retriever.retrieve(request['query'], rerank_k=5, mmr=False)
            timing.update(retriever.last_timing)
            for name,value in module.MODEL_LOAD_MS.items(): timing[name]=round(value-loads[name],2)
            timing['worker_ms']=round((time.perf_counter()-started)*1000,2)
            return [h['metadata']['memory_id'] for h in hits]
        finally:
            retriever.close()

def respond(request):
    timing={}
    try:
        with contextlib.redirect_stdout(sys.stderr): result=run(request,timing)
        return {'ok':True,'ids':result,'timing':timing}
    except Exception as error:
        return {'ok':False,'error':type(error).__name__}


if __name__ == '__main__':
    sys.stdin.reconfigure(encoding='utf-8'); sys.stdout.reconfigure(encoding='utf-8'); sys.stderr.reconfigure(encoding='utf-8')
    if '--serve' in sys.argv:
        # Host-owned stdin/stdout only. EOF releases the process and loaded models.
        while True:
            line=sys.stdin.readline(2_000_001)
            if not line: break
            if len(line)>2_000_000: sys.exit(2)
            try:
                envelope=json.loads(line)
                result=respond(envelope['request'])
                print(json.dumps({'request_id':envelope['request_id'],**result}),flush=True)
                del envelope, result, line
            except (ValueError,KeyError,TypeError): sys.exit(2)
        sys.exit(0)
    try:
        request=json.loads(sys.stdin.read(2_000_000))
        result=respond(request)
        print(json.dumps(result))
        sys.exit(0 if result['ok'] else 1)
    except Exception as error:
        print(json.dumps({'ok':False,'error':type(error).__name__}))
        sys.exit(1)
