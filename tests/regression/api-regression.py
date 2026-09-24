"""No npm dependencies. Production router/services, localhost file-KV + SQLite adapters.
Requires Python 3 and Node 22.13+. Not a live Cloudflare test.
Usage: python tests/regression/api-regression.py [sourceRoot] [outputDirectory]
"""
import json, os, sys, time, socket, subprocess, urllib.request, urllib.error, http.cookiejar, sqlite3
from pathlib import Path
ROOT=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path(__file__).resolve().parents[2]
OUT=Path(sys.argv[2]).resolve() if len(sys.argv)>2 else ROOT/'regression-output'
OUT.mkdir(parents=True,exist_ok=True)
results=[]
def record(name,fn):
    try: fn(); results.append({'name':name,'passed':True}); print('PASS',name,flush=True)
    except Exception as e: results.append({'name':name,'passed':False,'error':str(e)}); print('FAIL',name,repr(e),flush=True)
def eq(actual,expected):
    assert actual==expected, f'actual={actual!r}, expected={expected!r}'
class Server:
    def __init__(self,label,kvonly=False):
        with socket.socket() as sock: sock.bind(('127.0.0.1',0));self.port=sock.getsockname()[1]
        self.state=OUT/label;self.state.mkdir(exist_ok=True);self.kvonly=kvonly;self.base=f'http://127.0.0.1:{self.port}';self.proc=None
        self.start()
    def start(self):
        log=(self.state/'server.log').open('a')
        self.proc=subprocess.Popen(['node',str(ROOT/'tests/regression/local-server.mjs'),str(ROOT),str(self.state),str(self.port)]+(['kv-only'] if self.kvonly else []),stdout=log,stderr=subprocess.STDOUT)
        self.op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        for _ in range(60):
            try:self.call('/__test__/login');return
            except (OSError,ConnectionError):time.sleep(.1)
        raise RuntimeError('local server not ready')
    def stop(self):
        if self.proc:self.proc.terminate();self.proc.wait(timeout=5)
    def call(self,path,data=None,method=None):
        req=urllib.request.Request(self.base+path,method=method or ('POST' if data is not None else 'GET'),data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'})
        try:r=self.op.open(req,timeout=15)
        except urllib.error.HTTPError as e:r=e
        return r.status,json.loads(r.read())
    def patch(self,changes,id='row-a',client='3.3.18'):
        return self.call(f'/api/subscriptions/{id}/table-edit',{'changes':changes,'clientVersion':client},'PATCH')
    def raw(self,id='row-a'):return json.loads(json.loads((self.state/'kv.json').read_text())['sub:'+id])
    def d1(self,id='row-a'):
        with sqlite3.connect(self.state/'d1.sqlite') as db:return json.loads(db.execute('select data_json from subscriptions_current where id=?',(id,)).fetchone()[0])
    def controls(self,**kw):self.call('/__test__/controls',kw)
    def good(self,changes,id='row-a'):
        status,body=self.patch(changes,id);eq(status,200);eq(body['saved'],True);eq(body['storageVerified'],True);eq(body['tableEditProtocol'],2);return body

def scenarios(s):
    prefix='KV-only' if s.kvonly else 'KV+SQLite'
    def check(name,fn):record(prefix+': '+name,fn)
    check('normal fields persisted',lambda: (s.good({'name':'Saved actual name','amount':88.2,'notes':'persisted note'}),eq(s.raw()['name'],'Saved actual name'),eq(s.raw()['amount'],88.2)))
    check('clear subscription type stays empty',lambda: (s.good({'customType':''}),eq(s.raw()['customType'],'')))
    check('explicit past expiry is not renewed',lambda: (s.good({'expiryDate':'2025-10-25'}),eq(s.raw()['expiryDate'],'2025-10-24T16:00:00.000Z'),eq(s.raw()['memberLevel'],'Free')))
    check('editing history note does not advance dates',lambda: (s.good({'notes':'History note'},'row-history'),eq(s.raw('row-history')['expiryDate'],'2025-02-01T16:00:00.000Z')))
    check('clear optional start date',lambda: (s.good({'startDate':''}),eq(s.raw()['startDate'],None)))
    check('invalid zero period rejected without writes',lambda: (eq(s.patch({'periodValue':0})[0],400),eq(s.raw()['periodValue'],1)))
    check('invalid calendar date rejected',lambda: eq(s.patch({'expiryDate':'2026-02-30'})[0],400))
    check('expired paid tier rejected instead of false success',lambda: (eq(s.patch({'memberLevel':'Pro','notes':'MUST NOT SAVE'})[0],400),eq(s.raw()['notes'],'persisted note')))
    check('server/client version mismatch rejected',lambda: eq(s.patch({'name':'MUST NOT SAVE'},client='3.3.17')[0],409))
    check('unknown/read-only field rejected',lambda: eq(s.patch({'updatedAt':'x'})[0],400))
    rules=[{'type':'before_expiry','value':3,'unit':'days','isEnabled':True},{'type':'on_expiry','value':0,'unit':'days','isEnabled':True}]
    def combined():
        writes=s.state/'writes.jsonl';before=writes.read_text().count('"key":"sub:row-a"') if writes.exists() else 0
        body=s.good({'name':'With reminders','reminderRules':rules});eq(s.raw()['name'],'With reminders');eq(s.raw()['reminderRules'][0]['value'],3)
        eq(writes.read_text().count('"key":"sub:row-a"')-before,1)
        eq(body['verification']['reminders'],True)
    check('rules and cells share one subscription write',combined)
    check('rules-only save is verified',lambda: (s.good({'reminderRules':[rules[1]]}),eq(len(s.raw()['reminderRules']),1)))
    def empty():
        s.good({'reminderRules':[]});eq(s.raw()['reminderRules'],[])
        status,body=s.call('/api/subscriptions');eq(status,200);eq(next(x for x in body if x['id']=='row-a')['reminderRules'],[])
    check('empty reminder rules survive GET',empty)
    check('malformed reminder payload rejected',lambda: eq(s.patch({'reminderRules':{}})[0],400))
    def drop_rules():
        s.controls(dropReminderWrites=True)
        status,body=s.patch({'reminderRules':rules});eq(status,503);eq(body['storageVerified'],False)
        s.controls(dropReminderWrites=False);s.good({'reminderRules':rules})
    check('dropped reminder write cannot report success',drop_rules)
    def drop_sub():
        s.controls(dropWrites=True,dropD1Writes=True)
        status,body=s.patch({'notes':'DROPPED'});eq(status,503);eq(body['saved'],False);eq(s.raw()['notes'],'persisted note')
        s.controls(dropWrites=False,dropD1Writes=False)
    check('dropped storage writes cannot report success',drop_sub)
    def restart():
        s.good({'notes':'SURVIVES RESTART'});s.stop();s.start()
        status,body=s.call('/api/subscriptions');eq(status,200);eq(next(x for x in body if x['id']=='row-a')['notes'],'SURVIVES RESTART');eq(s.raw()['notes'],'SURVIVES RESTART')
        if not s.kvonly:eq(s.d1()['notes'],'SURVIVES RESTART')
    check('new process GET and disk read retain changes',restart)
    def template():
        uri='/api/ui-preferences/table-templates/subscription'
        # Existing template API contract intentionally unchanged.
        status,body=s.call(uri,{'templates':[{'id':'test-tpl','name':'保留的模板','layout':{'order':['name','notes'],'widths':{'notes':300}}}]},'PUT');eq(status,200)
        status,body=s.call(uri);eq(status,200);eq(body['templates'][0]['name'],'保留的模板')
    check('cloud template API/storage keys unchanged',template)
    if not s.kvonly:
        def stale():
            s.controls(staleReads=True);body=s.good({'notes':'D1 newer snapshot'});eq(body['verification']['kv'],False);eq(body['verification']['d1'],True)
            _,rows=s.call('/api/subscriptions');eq(next(x for x in rows if x['id']=='row-a')['notes'],'D1 newer snapshot');s.controls(staleReads=False)
        check('stale KV plus newer D1 returns persisted input',stale)

for kvonly,label in [(False,'api-d1'),(True,'api-kv')]:
    server=Server(label,kvonly)
    try:scenarios(server)
    finally:server.stop()
(OUT/'api-results.json').write_text(json.dumps({'environment':'production modules; local file-KV + SQLite adapter, not Cloudflare','tests':results,'passed':sum(x['passed'] for x in results),'failed':sum(not x['passed'] for x in results)},ensure_ascii=False,indent=2))
sys.exit(1 if any(not x['passed'] for x in results) else 0)
