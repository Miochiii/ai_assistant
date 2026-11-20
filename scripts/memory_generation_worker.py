"""Metadata-only resident version worker; identity is fixed by trusted startup args."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from assistant_memory import MemoryGateway, Scope
from assistant_memory.v2 import dispatch

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('root','db','user','project','workspace'):
        parser.add_argument('--'+name,required=True)
    args=parser.parse_args()
    scope=Scope(args.user,args.project)
    root=Path(args.root)
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    while True:
        line=sys.stdin.readline(8193)
        if not line: return
        if len(line)>8192 or not line.endswith('\n'): return
        request_id=None
        try:
            message=json.loads(line)
            request_id=message['request_id']
            if (set(message)!={'request_id','request'} or message['request']!={}
                or not isinstance(request_id,str) or not 0<len(request_id)<=100):
                raise ValueError('INVALID_REQUEST')
            config=json.loads((root/'configs/memory-v2.json').read_text(encoding='utf-8-sig'))
            if Path(config['allowed_workspace']).resolve(strict=True)!=Path(args.workspace).resolve(strict=True):
                raise ValueError('WORKSPACE_NOT_ALLOWED')
            # Reopen on every query: no cached results, config, connections or
            # effective-memory snapshots survive a request or database replacement.
            with MemoryGateway(args.db,scope) as memory:
                value=dispatch(memory,root,'memory_generation',{})
            reply={'request_id':request_id,'ok':True,'value':value}
        except Exception:
            # Do not leak DB paths, SQL, exception text or memory content.
            reply={'request_id':request_id,'ok':False,'error':'GENERATION_UNAVAILABLE'}
        print(json.dumps(reply,separators=(',',':')),flush=True)

if __name__=='__main__': main()
