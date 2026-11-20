import json
import sys
import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timezone
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from assistant_memory import MemoryGateway, Scope, MemoryError
from assistant_memory.v2 import dispatch

class DailyTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        (self.root/'configs').mkdir()
        (self.root/'configs/memory-v2.json').write_text(json.dumps({'enabled':True,'python':'missing'}))
        self.now='2026-11-07T10:00:00+00:00'
        self.m=MemoryGateway(self.root/'test.sqlite',Scope('u','p'),clock=lambda:self.now)
    def tearDown(self): self.m.close();self.temp.cleanup()
    def op(self,name,**args): return dispatch(self.m,self.root,name,args)
    def batch(self,text='以后回答请简短一点'):
        self.op('daily_ingest',text=text,event_id='1',session_id='s')
        self.now='2026-11-08T10:00:00+00:00'
        return self.op('daily_pending')
    def candidate(self,b,text=None):
        return {'source_event_id':b['events'][0]['event_id'],'quote':text or b['events'][0]['content'],'key':'communication.style'}
    def test_generation_survives_disabled_recall_and_tracks_consent(self):
        first=self.op('memory_generation')
        self.assertEqual(self.op('memory_generation'),first)
        self.op('daily_configure',enabled=False)
        disabled=self.op('memory_generation')
        self.assertFalse(disabled['enabled'])
        self.assertEqual(len(disabled['generation']),64)
        self.assertNotEqual(disabled['generation'],first['generation'])
        self.assertIsNone(self.op('rag_version')['version'])
        self.op('daily_configure',enabled=True)
        self.assertNotEqual(self.op('memory_generation')['generation'],first['generation'])
    def test_generation_tracks_revoke_and_scope(self):
        batch=self.batch();result=self.op('daily_commit',batch=batch,candidates=[self.candidate(batch)])
        first=self.op('memory_generation')['generation']
        self.m.revoke(result['memory_ids'][0])
        self.assertNotEqual(first,self.op('memory_generation')['generation'])
        with MemoryGateway(self.root/'test.sqlite',Scope('other','p')) as other:
            self.assertNotEqual(self.op('memory_generation')['generation'],dispatch(other,self.root,'memory_generation',{})['generation'])
    def test_global_disable_still_returns_generation(self):
        first=self.op('memory_generation')
        (self.root/'configs/memory-v2.json').write_text(json.dumps({'enabled':False,'python':'missing'}))
        disabled=self.op('memory_generation')
        self.assertFalse(disabled['enabled'])
        self.assertNotEqual(first['generation'],disabled['generation'])
    def test_auto_commit_replay_and_cross_session(self):
        b=self.batch();c=self.candidate(b)
        r=self.op('daily_commit',batch=b,candidates=[c])
        self.assertEqual(r['automatic'],1)
        self.assertEqual(self.op('daily_commit',batch=b,candidates=[c]),r)
        self.assertEqual(len(self.m.recall(kind='preference',key='daily.communication.style')['items']),1)
        self.assertEqual(self.op('daily_pending')['events'],[])
    def test_unquoted_extraction_rolls_back(self):
        b=self.batch()
        with self.assertRaises(MemoryError): self.op('daily_commit',batch=b,candidates=[self.candidate(b,'凭空推断')])
        self.assertEqual(self.m._rows(),[])
    def test_disable_invalidates_pending(self):
        b=self.batch();self.op('daily_configure',enabled=False)
        with self.assertRaises(MemoryError): self.op('daily_commit',batch=b,candidates=[self.candidate(b)])
    def test_deleted_source_cannot_return(self):
        b=self.batch();self.m.forget(event_id=b['events'][0]['event_id'])
        with self.assertRaises(MemoryError): self.op('daily_commit',batch=b,candidates=[self.candidate(b)])
    def test_nonliteral_and_quoted_preferences_not_auto(self):
        b=self.batch('比如他说：以后回答请简短一点')
        r=self.op('daily_commit',batch=b,candidates=[self.candidate(b,'以后回答请简短一点')])
        self.assertEqual(r['automatic'],0);self.assertEqual(r['candidates'],1)
    def test_secret_excluded(self):
        self.assertEqual(self.op('daily_ingest',text='密码是123',event_id='s',session_id='s')['status'],'excluded')
        self.assertEqual(self.m.db.execute('SELECT count(*) FROM memory_events').fetchone()[0],0)
    def test_orb_channel_and_repeated_admission(self):
        args=dict(text='以后回答请简短一点',event_id='orb-rpc-1',session_id='orb-session',source_channel='orb_daily')
        first=self.op('daily_ingest',**args)
        self.assertEqual(self.op('daily_ingest',**args),first)
        rows=self.m.db.execute('SELECT channel,origin FROM memory_events').fetchall()
        self.assertEqual(len(rows),1)
        self.assertEqual(tuple(rows[0]),('orb_daily','user'))
        self.now='2026-11-08T10:00:00+00:00'
        batch=self.op('daily_pending')
        result=self.op('daily_commit',batch=batch,candidates=[self.candidate(batch)])
        self.assertEqual(result['automatic'],1)
    def test_unknown_daily_source_rejected(self):
        with self.assertRaises(MemoryError):
            self.op('daily_ingest',text='回答请简短',event_id='e',session_id='s',source_channel='tool')
    def test_cross_scope(self):
        b=self.batch()
        with MemoryGateway(self.root/'test.sqlite',Scope('other','p')) as other:
            with self.assertRaises(MemoryError): dispatch(other,self.root,'daily_commit',{'batch':b,'candidates':[self.candidate(b)]})
    def test_claim_blocks_parallel_extraction(self):
        self.batch();self.assertEqual(self.op('daily_pending')['status'],'leased_or_attempt_limit')
    def test_retrieval_failure_uses_current_literal_only(self):
        b=self.batch();r=self.op('daily_commit',batch=b,candidates=[self.candidate(b)])
        with patch('assistant_memory.v2.subprocess.run',side_effect=OSError()):
            self.assertEqual(self.op('rag_recall',query='简短')['engine'],'literal_fallback')
            self.m.revoke(r['memory_ids'][0])
            self.assertEqual(self.op('rag_recall',query='简短')['items'],[])
    def test_conflicting_auto_memory_remains_candidate(self):
        b=self.batch();self.op('daily_commit',batch=b,candidates=[self.candidate(b)])
        self.op('daily_ingest',text='以后先给概览',event_id='2',session_id='s')
        self.now='2026-11-09T10:00:00+00:00';b=self.op('daily_pending')
        r=self.op('daily_commit',batch=b,candidates=[self.candidate(b)])
        self.assertEqual(r['automatic'],0)
        self.assertEqual(self.m.recall(kind='preference',key='daily.communication.style')['items'][0]['content'],'以后回答请简短一点')
    def test_monitor_is_shadow_and_unknown_is_not_success(self):
        from assistant_memory.quality_monitor import MemoryQualityMonitor
        monitor=MemoryQualityMonitor('p1',.1,.5)
        unknown=monitor.update('u',None,'p1');self.assertEqual(unknown['statistic'],0)
        alarm=monitor.update('bad',1,'p1');self.assertTrue(alarm['crossed'])
        self.assertFalse(alarm['calibrated']);self.assertEqual(alarm['action'],'diagnose_only')
        self.assertEqual(monitor.update('bad',1,'p1'),alarm)
        with self.assertRaises(ValueError): monitor.update('new',1,'p2')

    def snapshot(self):
        b=self.batch();r=self.op('daily_commit',batch=b,candidates=[self.candidate(b)])
        return self.op('rag_snapshot',query='简短'),r['memory_ids'][0]

    def resolve(self,snapshot,mid,**extra):
        return self.op('rag_resolve',query='简短',scope=snapshot['scope'],version=snapshot['version'],ids=[mid],**extra)

    def test_resident_resolves_only_current_ids(self):
        s,mid=self.snapshot()
        self.assertEqual(self.resolve(s,mid)['items'][0]['memory_id'],mid)
        self.assertEqual(self.resolve(s,'foreign-id')['items'],[])
        self.assertEqual(self.resolve(s,mid,fallback=True)['engine'],'literal_fallback')
        self.m.revoke(mid)
        self.assertEqual(self.resolve(s,mid)['engine'],'revision_changed')
        self.assertEqual(self.resolve(s,mid,fallback=True)['items'],[])

    def test_resident_disable_and_reenable_invalidates_snapshot(self):
        s,mid=self.snapshot();self.op('daily_configure',enabled=False)
        self.assertEqual(self.resolve(s,mid)['engine'],'disabled')
        self.op('daily_configure',enabled=True)
        self.assertEqual(self.resolve(s,mid)['engine'],'revision_changed')

    def test_resident_scope_and_database_binding(self):
        s,mid=self.snapshot()
        for filename,scope in [('test.sqlite',Scope('other','p')),('other.sqlite',Scope('u','p'))]:
            with MemoryGateway(self.root/filename,scope) as other:
                with self.assertRaises(MemoryError):
                    dispatch(other,self.root,'rag_resolve',dict(query='简短',scope=s['scope'],version=s['version'],ids=[mid]))

    def test_resident_source_deletion_invalidates_snapshot(self):
        s,mid=self.snapshot()
        eid=self.m.db.execute('SELECT event_id FROM memory_sources WHERE memory_id=?',(mid,)).fetchone()[0]
        self.m.forget(event_id=eid)
        self.assertEqual(self.resolve(s,mid)['items'],[])

if __name__=='__main__': unittest.main()
