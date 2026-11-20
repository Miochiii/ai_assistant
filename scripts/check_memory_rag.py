"""Local weight smoke test using synthetic notes only; removes its own projection."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from uuid import uuid4
ROOT=Path(__file__).resolve().parents[1]
scope='offline-test-'+uuid4().hex
partition=ROOT/'runtime/memory/indexes'/hashlib.sha256(scope.encode()).hexdigest()
try:
    p=subprocess.run([sys.executable,'-B',str(ROOT/'scripts/memory_rag_worker.py')],input=json.dumps({'scope':scope,'query':'我常用什么开发软件？',
      'items':[{'memory_id':'editor','text':'我平时用 PyCharm 编写 Python 程序'}, {'memory_id':'drink','text':'我喜欢喝无糖乌龙茶'}, {'memory_id':'style','text':'讲步骤时短一点'},
               {'memory_id':'color','text':'喜欢蓝色'}, {'memory_id':'food','text':'午饭吃米饭'}, {'memory_id':'music','text':'喜欢钢琴曲'}, {'memory_id':'sleep','text':'晚上十一点睡觉'}]},ensure_ascii=False),encoding='utf-8',errors='replace',capture_output=True,timeout=180)
    if p.returncode: print(p.stderr[-4000:]);print(p.stdout);sys.exit(1)
    result=json.loads(p.stdout)
    assert result['ok'] and result['ids'][0]=='editor',result
    print(json.dumps({'ok':True,'top_id':result['ids'][0],'api_calls':0}))
finally:
    assert partition.parent==ROOT/'runtime/memory/indexes'
    if partition.exists(): shutil.rmtree(partition)
