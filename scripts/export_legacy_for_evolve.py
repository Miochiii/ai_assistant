"""Snapshot legacy SQLite for migration without modifying the source database."""
import hashlib,json,sqlite3,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'src'))
from assistant_memory import MemoryGateway,Scope
from assistant_memory.v2 import eligible
out=root/'runtime/evolve-install/20261111'
snapshot=out/'legacy-memory.sqlite3'
if snapshot.exists(): raise SystemExit('Snapshot already exists; do not overwrite')
source=sqlite3.connect((root/'runtime/memory/memory.sqlite3').as_uri()+'?mode=ro',uri=True)
with sqlite3.connect(snapshot) as target: source.backup(target)
source.close()
project='workspace-'+hashlib.sha256(str(root.resolve()).lower().encode()).hexdigest()[:24]
with MemoryGateway(snapshot,Scope('local-user',project)) as memory:
    data=memory.export()
    active_ids={r['memory_id'] for r in eligible(memory)}
    for item in data['items']:item['automatic_eligible']=item['memory_id'] in active_ids
(out/'legacy-export.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
counts={}
for item in data['items']:
    key=item['reason']+'/'+item['kind'];counts[key]=counts.get(key,0)+1
print(json.dumps({'counts':counts,'automatic_eligible':len(active_ids),'source_modified':False}))
