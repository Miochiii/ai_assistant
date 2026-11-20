"""Scoped daily consolidation and retrieval; trusted Host API, not a model tool."""
import hashlib
import json
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from .gateway import MemoryError, _encode

POLICY='daily-explicit-preferences-v1'
OPS={'daily_status','daily_configure','daily_ingest','daily_pending','daily_commit','rag_recall','rag_version','rag_snapshot','rag_resolve','memory_generation'}
SECRET=re.compile(r'密码|验证码|私钥|令牌|api.?key|access.?token|secret|sk-[\w-]{12,}',re.I)
SENSITIVE=re.compile(r'疾病|病史|诊断|身份证|银行卡|政治|宗教|性取向|工资|支付|转账|授权|权限|自动点击')
SCHEMA='''
CREATE TABLE IF NOT EXISTS memory_daily_settings(user_scope TEXT,project_scope TEXT,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(user_scope,project_scope));
CREATE TABLE IF NOT EXISTS memory_daily_queue(event_id TEXT PRIMARY KEY,day TEXT NOT NULL,processed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS memory_daily_jobs(batch_id TEXT PRIMARY KEY,user_scope TEXT,project_scope TEXT,result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_daily_claims(batch_id TEXT PRIMARY KEY,until_at TEXT NOT NULL,attempts INTEGER NOT NULL);
'''
def digest(value): return hashlib.sha256(_encode(value).encode()).hexdigest()
def status(m):
    r=m.db.execute('SELECT * FROM memory_daily_settings WHERE user_scope=? AND project_scope=?',m._scope).fetchone()
    return {'enabled':bool(r['enabled']) if r else True,'revision':r['revision'] if r else 1,'policy':POLICY}
def eligible(m):
    rows=m._rows(); reasons=m._selection(rows,m._stamp())
    # V1 panel notes were saved under an explicit-recall-only contract.
    # Do not silently migrate them or re-inject an opted-out guidance setting.
    excluded={r[0] for r in m.db.execute('''SELECT s.memory_id FROM memory_sources s
        JOIN memory_events e USING(event_id) WHERE e.channel IN ('assistant-panel','panel-guidance-setting')''')}
    manual_guidance=m._head('preference','panel.guidance.style')
    return [r for r in rows if reasons[r['memory_id']]=='selected'
            and r['memory_id'] not in excluded
            and r['memory_key']!='panel.guidance.style'
            and not (manual_guidance and r['memory_key']=='daily.communication.style')]
def fingerprint(m): return digest([status(m)['revision'],[(r['memory_id'],r['content']) for r in eligible(m)]])

def index_scope(m):
    return digest([*m._scope,m.db.execute('PRAGMA database_list').fetchone()[2]])
def localday(m): return datetime.fromisoformat(m._stamp()).astimezone(timezone(timedelta(hours=8))).date().isoformat()

def dispatch(m,root,op,args):
    m.db.executescript(SCHEMA)
    settings=json.loads((Path(root)/'configs/memory-v2.json').read_text(encoding='utf-8-sig'))
    if op=='daily_status': return status(m)
    if op=='memory_generation':
        # A control-plane token, including when recall is disabled. No memory
        # text crosses this interface; bind it to the authoritative DB and scope.
        with m._transaction():
            consent=status(m)
            enabled=bool(settings['enabled'] and consent['enabled'])
            return {'generation':digest([index_scope(m),bool(settings['enabled']),fingerprint(m)]),
                    'enabled':enabled,'consent_revision':consent['revision']}
    if op=='rag_version':
        with m._transaction():
            return {'version':fingerprint(m) if settings['enabled'] and status(m)['enabled'] else None}
    if op in ('rag_snapshot','rag_resolve'):
        query=args.get('query')
        if not isinstance(query,str) or not 0<len(query)<=2000: raise MemoryError('INVALID_QUERY')
        with m._transaction():
            if not settings['enabled'] or not status(m)['enabled']:
                return {'items':[],'version':None,'engine':'disabled'}
            rows=eligible(m); version=fingerprint(m); scope=index_scope(m)
            if op=='rag_snapshot':
                items=[{'memory_id':r['memory_id'],'text':json.loads(r['content']) if isinstance(json.loads(r['content']),str) else r['content']} for r in rows]
                return {'scope':scope,'version':version,'items':items,'engine':'snapshot' if items else 'empty'}
            if args.get('scope')!=scope: raise MemoryError('INVALID_SCOPE')
            if args.get('version')!=version: return {'items':[],'version':version,'engine':'revision_changed'}
            fallback=args.get('fallback') is True
            # Literal recall opens its own transaction; select below instead.
            if fallback:
                from .gateway import _normalize
                ids=[r['memory_id'] for r in rows if _normalize(query) in _normalize(r['content'])][:5]
            else:
                ids=args.get('ids')
                if not isinstance(ids,list) or len(ids)>5 or any(not isinstance(mid,str) for mid in ids): raise MemoryError('INVALID_IDS')
            current={r['memory_id']:r for r in rows}
            return {'items':[{'memory_id':mid,'content':json.loads(current[mid]['content'])} for mid in dict.fromkeys(ids) if mid in current],
                    'version':version,'engine':'literal_fallback' if fallback else 'hybrid_resident'}
    if op=='daily_configure':
        if type(args['enabled']) is not bool: raise MemoryError('INVALID_SETTING')
        with m._transaction(write=True):
            old=status(m)
            m.db.execute('INSERT INTO memory_daily_settings VALUES(?,?,?,?) ON CONFLICT(user_scope,project_scope) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision',(*m._scope,int(args['enabled']),old['revision']+1))
            if not args['enabled']:
                m.db.execute('UPDATE memory_daily_queue SET processed=1 WHERE event_id IN (SELECT event_id FROM memory_events WHERE user_scope=? AND project_scope=?)',m._scope)
        return status(m)
    if op=='daily_ingest':
        text=args['text']
        if not isinstance(text,str) or not text.strip() or len(text)>8000: raise MemoryError('INVALID_TEXT')
        channel=args.get('source_channel','panel_daily')
        if channel not in ('panel_daily','orb_daily'): raise MemoryError('INVALID_SOURCE_CHANNEL')
        with m._transaction(write=True):
            if not settings['enabled'] or not status(m)['enabled']: return {'status':'disabled'}
            if SECRET.search(text) or '不要记忆' in text or '不要记住' in text: return {'status':'excluded'}
            eid='daily-'+digest([*m._scope,args['session_id'],args['event_id']])
            m._record_event(event_id=eid,session_id=args['session_id'],channel=channel,origin='user',content=text)
            m.db.execute('INSERT OR IGNORE INTO memory_daily_queue(event_id,day) VALUES(?,?)',(eid,localday(m)))
        return {'status':'recorded','event_id':eid}
    if op=='daily_pending':
        if not settings['enabled'] or not status(m)['enabled']: return {'events':[]}
        rows=m.db.execute('''SELECT e.event_id,e.content,q.day FROM memory_events e JOIN memory_daily_queue q USING(event_id)
          WHERE e.user_scope=? AND e.project_scope=? AND e.deleted_at IS NULL AND q.processed=0 AND q.day<? ORDER BY q.day,e.recorded_at LIMIT 20''',(*m._scope,localday(m))).fetchall()
        events=[]; size=0
        for row in rows:
            if size+len(row['content'])>40000: break
            events.append(dict(row)); size+=len(row['content'])
        if not events: return {'events':[],'status':'empty'}
        manifest={'events':events,'revision':status(m)['revision'],'scope':list(m._scope),'policy':POLICY}
        bid=digest(manifest)
        with m._transaction(write=True):
            claim=m.db.execute('SELECT * FROM memory_daily_claims WHERE batch_id=?',(bid,)).fetchone()
            now=m._stamp()
            if claim and (claim['until_at']>now or claim['attempts']>=3): return {'events':[],'status':'leased_or_attempt_limit'}
            expiry=(datetime.fromisoformat(now)+timedelta(minutes=10)).isoformat()
            m.db.execute('INSERT INTO memory_daily_claims VALUES(?,?,1) ON CONFLICT(batch_id) DO UPDATE SET until_at=excluded.until_at,attempts=attempts+1',(bid,expiry))
        return {**manifest,'batch_id':bid}
    if op=='daily_commit':
        batch=args['batch']; candidates=args['candidates']
        if not isinstance(candidates,list) or len(candidates)>20: raise MemoryError('INVALID_CANDIDATES')
        manifest={k:batch[k] for k in ('events','revision','scope','policy')}
        if digest(manifest)!=batch['batch_id'] or batch['scope']!=list(m._scope) or batch['policy']!=POLICY: raise MemoryError('INVALID_BATCH')
        with m._transaction(write=True):
            prior=m.db.execute('SELECT result FROM memory_daily_jobs WHERE batch_id=?',(batch['batch_id'],)).fetchone()
            if prior: return json.loads(prior['result'])
            if not settings['enabled'] or not status(m)['enabled'] or status(m)['revision']!=batch['revision']: raise MemoryError('CONSENT_CHANGED')
            sources={}
            for event in batch['events']:
                s=m._event(event['event_id']); q=m.db.execute('SELECT * FROM memory_daily_queue WHERE event_id=?',(s['event_id'],)).fetchone()
                if s['deleted_at'] or s['content']!=event['content'] or s['origin']!='user' or not q or q['processed']: raise MemoryError('SOURCE_CHANGED')
                sources[s['event_id']]=s['content']
            result={'automatic':0,'candidates':0,'skipped':0,'memory_ids':[]}; used=set()
            for c in candidates:
                eid=c.get('source_event_id'); content=c.get('quote'); key=c.get('key')
                if eid not in sources or not isinstance(content,str) or not content or content not in sources[eid] or len(content)>500: raise MemoryError('UNSUPPORTED_EXTRACTION')
                if not isinstance(key,str) or not re.fullmatch(r'[a-z][a-z0-9_.]{1,70}',key): raise MemoryError('INVALID_MEMORY_KEY')
                if SECRET.search(content) or SENSITIVE.search(content): result['skipped']+=1; continue
                rules={'communication.style':r'(一步一步|一次.*一步|讲.*短一点|回答.*简短|先给概览)',
                       'communication.language':r'(请用|以后用|我希望.*用).*(中文|英文)',
                       'software.editor':r'(我.*(?:使用|习惯用|喜欢用|平时用)).*(PyCharm|VS\s*Code|记事本)'}
                accepted=(content.strip()==sources[eid].strip() and key in rules
                    and bool(re.match(r'^(我|请|以后|讲|回答|教程)',content))
                    and bool(re.search(rules[key],content,re.I))
                    and not re.search(r'不是|不喜欢|别|不要|假设|如果|比如|例如|他说|她说|想象|吗|？|\?',sources[eid]))
                canonical='daily.'+key
                if (canonical,content) in used: continue
                used.add((canonical,content)); head=m._head('preference',canonical)
                if head and json.loads(head['content'])==content and not head['revoked_at']: result['skipped']+=1; continue
                if head: accepted=False
                mid=m._create(kind='preference',key=canonical,content=content,source_event_ids=[eid],supersedes_id=head['memory_id'] if head else None,activate=accepted)
                result['automatic' if accepted else 'candidates']+=1; result['memory_ids'].append(mid)
            for eid in sources: m.db.execute('UPDATE memory_daily_queue SET processed=1 WHERE event_id=?',(eid,))
            m.db.execute('INSERT INTO memory_daily_jobs VALUES(?,?,?,?)',(batch['batch_id'],*m._scope,_encode(result)))
        return result
    if op=='rag_recall':
        if not settings['enabled'] or not status(m)['enabled']: return {'items':[],'version':None,'engine':'disabled'}
        query=args['query']
        if not isinstance(query,str) or not 0<len(query)<=2000: raise MemoryError('INVALID_QUERY')
        with m._transaction():
            rows=eligible(m); version=fingerprint(m)
            items=[{'memory_id':r['memory_id'],'text':json.loads(r['content']) if isinstance(json.loads(r['content']),str) else r['content']} for r in rows]
        if not items: return {'items':[],'version':version,'engine':'empty'}
        engine='hybrid'
        try:
            p=subprocess.run([settings['python'],'-B',str(Path(root)/'scripts/memory_rag_worker.py')],input=_encode({'scope':_encode(m._scope),'query':query,'items':items}),capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=90,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            value=json.loads(p.stdout)
            if p.returncode or not value.get('ok'): raise ValueError('retrieval failed')
            ids=value['ids']
        except (OSError,ValueError,subprocess.TimeoutExpired):
            engine='literal_fallback'; ids=[r['memory_id'] for r in m.recall(route='search',query=query,limit=5,max_chars=6000)['items']]
        with m._transaction():
            if fingerprint(m)!=version: return {'items':[],'version':fingerprint(m),'engine':'revision_changed'}
            current={r['memory_id']:r for r in eligible(m)}
            found=[{'memory_id':mid,'content':json.loads(current[mid]['content'])} for mid in ids[:5] if mid in current]
        return {'items':found,'version':version,'engine':engine}
    raise MemoryError('INVALID_OPERATION')
