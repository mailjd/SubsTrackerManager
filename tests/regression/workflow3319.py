"""v3.3.19 workflows: production handlers, file KV + real local SQLite. No live Cloudflare."""
import json,sys,time,tempfile,socket,subprocess,urllib.request,urllib.error,http.cookiejar,uuid,concurrent.futures
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "support"))
from sqlite_local import query_rows, NODE
ROOT=Path(sys.argv[1] if len(sys.argv)>1 else '.').resolve();OUT=Path(sys.argv[2] if len(sys.argv)>2 else tempfile.mkdtemp(prefix='subs-workflow-3319-')).resolve();OUT.mkdir(exist_ok=True,parents=True)
RESULTS=[]
def eq(a,b):assert a==b,(a,b)
def check(name,fn):
 try:fn();RESULTS.append({'name':name,'passed':True});print('PASS',name,flush=True)
 except Exception as e:RESULTS.append({'name':name,'passed':False,'error':repr(e)});print('FAIL',name,repr(e),flush=True)
class Server:
 def __init__(self,label,kv=False):
  with socket.socket() as s:s.bind(('127.0.0.1',0));self.port=s.getsockname()[1]
  self.state=OUT/label;self.state.mkdir(exist_ok=True);self.kv=kv;self.start()
 def start(self):
  self.proc=subprocess.Popen([NODE,str(ROOT/'tests/regression/local-server.mjs'),str(ROOT),str(self.state),str(self.port)]+(['kv-only'] if self.kv else []),stdout=(self.state/'log.txt').open('a'),stderr=subprocess.STDOUT)
  self.op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
  for _ in range(80):
   try:self.call('/__test__/login');return
   except OSError:time.sleep(.1)
  raise RuntimeError('server not ready')
 def call(self,path,data=None,method=None):
  req=urllib.request.Request('http://127.0.0.1:'+str(self.port)+path,data=json.dumps(data).encode() if data is not None else None,method=method or ('POST'if data is not None else 'GET'),headers={'Content-Type':'application/json'})
  try:r=self.op.open(req,timeout=30)
  except urllib.error.HTTPError as e:r=e
  return r.status,json.loads(r.read())
 def ok(self,path,data=None,method=None):
  status,v=self.call(path,data,method);assert status<300,(status,v);assert not isinstance(v,dict) or v.get('success',True),(status,v);return v
 def stop(self):self.proc.terminate();self.proc.wait(5)
 def history(self):return self.ok('/api/subscription-history?pageSize=500')['items']
 def disk(self,id):
  if self.kv:return json.loads(json.loads((self.state/'kv.json').read_text())['sub:'+id])
  return json.loads(query_rows(self.state/'d1.sqlite', 'SELECT data_json FROM subscriptions_current WHERE id=?', (id,))[0][0])
def make(**kw):return dict(name='Workflow Member',account='workflow@example.test',accountSerial='',customType='开会员',memberLevel='Pro',amount=90,currency='CNY',startDate='2030-09-25',expiryDate='2030-10-25',subscriptionMode='reset',periodValue=1,periodUnit='month',**kw)
for kv in (False,True):
 s=Server('kv'if kv else'd1',kv);prefix='KV-only'if kv else'D1+KV';label=lambda n:prefix+': '+n
 try:
  initial=s.history();initial_ids={x['id'] for x in initial}
  check(label('legacy snapshots seeded once; non-memberships excluded from current'),lambda:(eq(len(initial),3),eq({x['id'] for x in s.ok('/api/subscriptions')},{'row-a','row-b'}),eq({x['id'] for x in s.history()},initial_ids)))
  first=make();first['__operationId']='new-member';a=s.ok('/api/subscriptions',first);sid=a['subscription']['id']
  check(label('membership creates active row and independent historical receipt'),lambda:(eq(a['historyOnly'],False),eq(s.disk(sid)['amount'],90),eq(len(s.history()),4)))
  check(label('reset defaults auto-renew off'),lambda:eq(a['subscription']['autoRenew'],False))
  def presets():eq([(r['value'],r['isEnabled']) for r in a['subscription']['reminderRules']],[(7,False),(3,False),(1,True),(0,True)])
  check(label('four reminder presets retained with 7/3 unchecked'),presets)
  second={**first,'__operationId':'second-member','amount':120,'startDate':'2030-10-25','expiryDate':'2030-11-25'};b=s.ok('/api/subscriptions',second)
  check(label('same name + account updates same ID; prior history immutable'),lambda:(eq(b['updated'],True),eq(b['subscription']['id'],sid),eq(s.disk(sid)['amount'],120),eq(next(x for x in s.history()if x['id']=='new-member')['snapshot']['amount'],90)))
  check(label('replaying older operation never reverts newer active row'),lambda:(eq(s.ok('/api/subscriptions',first)['replayed'],True),eq(s.disk(sid)['amount'],120),eq(len(s.history()),5)))
  check(label('changed payload with old operation ID rejected'),lambda:eq(s.call('/api/subscriptions',{**first,'amount':111})[0],400))
  third={**first,'name':'Different Membership','__operationId':'different-name'};c=s.ok('/api/subscriptions',third)
  check(label('one account allows multiple different memberships'),lambda:(eq(c['updated'],False),eq(len([x for x in s.ok('/api/subscriptions')if x.get('account')==first['account']]),2)))
  other={**first,'__operationId':'recharge','customType':'充值','amount':25};d=s.ok('/api/subscriptions',other)
  check(label('non-membership creates history only, leaves current unchanged'),lambda:(eq(d['historyOnly'],True),eq(s.disk(sid)['amount'],120),eq(len([x for x in s.ok('/api/subscriptions')if x.get('account')==first['account']]),2)))
  rows=[{**first,'__operationId':'import-member','amount':150,'__sourceRow':2},{**other,'__operationId':'import-recharge','__sourceRow':3}]
  imp=s.ok('/api/subscriptions/import',{'rows':rows})
  check(label('mixed import routes membership/current and recharge/history'),lambda:(eq(s.disk(sid)['amount'],150),eq(len([x for x in s.history()if x['id'].startswith('import-')]),2)))
  count=len(s.history());s.ok('/api/subscriptions/import',{'rows':rows})
  check(label('retrying same imported rows adds no duplicate history'),lambda:eq(len(s.history()),count))
  # Normalizing incoming reminder IDs must not break idempotency.
  rr={**first,'__operationId':'rule-retry','reminderRules':[{'id':'one','type':'on_expiry','value':0,'unit':'days','isEnabled':True}]};s.ok('/api/subscriptions',rr);rr['reminderRules'][0]['id']='two'
  check(label('reminder-generated UUID does not change operation fingerprint'),lambda:eq(s.ok('/api/subscriptions',rr)['replayed'],True))
  cnt=len(s.history());s.ok('/api/subscriptions/'+sid+'/table-edit',{'clientVersion':json.loads((ROOT/'package.json').read_text())['version'],'changes':{'notes':'edited current only','amount':99}},'PATCH')
  check(label('table save persists without rewriting/adding historical spending'),lambda:(eq(s.disk(sid)['notes'],'edited current only'),eq(len(s.history()),cnt),eq(next(x for x in s.history()if x['id']=='second-member')['snapshot']['amount'],120)))
  check(label('history endpoint is read-only'),lambda:eq(s.call('/api/subscription-history',{},'DELETE')[0],405))
  check(label('history date filters use configured calendar timezone'),lambda:eq(len(s.ok('/api/subscription-history?from=2030-09-25&to=2030-09-25&pageSize=500')['items']),len([x for x in s.history()if x['occurredAt']=='2030-09-24T16:00:00.000Z'])))
  # cloud template keys preserved, and foundation gets an independent scope
  for scope in ('subscription','database','base'):
   templ=[{'id':'t-'+scope,'name':'保留模板-'+scope,'layout':{'order':['account','ownerType'],'hidden':['realName'],'filters':{'ownerType':['公司']}}}]
   s.ok('/api/ui-preferences/table-templates/'+scope,{'templates':templ},'PUT')
  s.stop();s.start()
  check(label('current, cumulative history and all template scopes survive process restart'),lambda:(eq(s.disk(sid)['notes'],'edited current only'),eq(len(s.history()),cnt),*[eq(s.ok('/api/ui-preferences/table-templates/'+scope)['templates'][0]['name'],'保留模板-'+scope) for scope in ('subscription','database','base')]))
  # Existing menu operations and foundation edits are the same storage, with timestamp.
  s.ok('/api/menu-options',{'group':'subscriptionNames','name':'Foundation original'})
  s.ok('/api/base-data',{'group':'subscriptionNames','oldValue':'Foundation original','value':'Foundation renamed'},'PATCH')
  check(label('foundation rename updates original menu API, does not create a second database'),lambda:(eq('Foundation renamed'in s.ok('/api/menu-options')['menus']['subscriptionNames'],True),eq('Foundation original'in s.ok('/api/menu-options')['menus']['subscriptionNames'],False)))
  if not kv:
   co=s.ok('/api/accounts',{'account':'co1@test','ownerType':'公司','autoSerial':True,'accountType':'自定义类型','passwords':{'tapnow':'test-sensitive-secret'}})['account']
   pe=s.ok('/api/accounts',{'account':'pe1@test','ownerType':'个人','autoSerial':True,'accountType':'微信'})['account']
   co2=s.ok('/api/accounts',{'account':'co2@test','ownerType':'公司','autoSerial':True,'accountType':'邮箱'})['account']
   check(label('independent company/personal serial counters'),lambda:(eq(co['accountSerial'],'公司01号'),eq(pe['accountSerial'],'个人01号'),eq(co2['accountSerial'],'公司02号')))
   check(label('duplicate account cannot be silently overwritten by Create'),lambda:eq(s.call('/api/accounts',{'account':'co1@test','ownerType':'个人','autoSerial':True})[0],409))
   check(label('invalid ownership rejected'),lambda:eq(s.call('/api/accounts',{'account':'bad@test','ownerType':'Other','autoSerial':True})[0],400))
   check(label('account type comes from foundation plus entire account data'),lambda:eq('自定义类型'in s.ok('/api/accounts/types')['items'],True))
   q=urllib.parse.quote(json.dumps({'ownerType':['个人']}));filtered=s.ok('/api/accounts?pageSize=10&filters='+q)
   check(label('server filters apply before pagination with correct count'),lambda:(eq(filtered['total'],1),eq(filtered['items'][0]['account'],'pe1@test')))
   check(label('safe options and Admin response do not expose passwords'),lambda:(eq('test-sensitive-secret'in json.dumps(s.ok('/api/accounts/options')),False),eq('test-sensitive-secret'in json.dumps(s.ok('/api/accounts/item?account=co1%40test')),False)))
   s.ok('/api/accounts/item?account=co1%40test',{**co,'realName':'Updated owner','ownerType':'个人'},'PUT')
   check(label('account inline-edit fields persisted and returned including ownership'),lambda:(eq(s.ok('/api/accounts/item?account=co1%40test')['account']['realName'],'Updated owner'),eq(s.ok('/api/accounts/item?account=co1%40test')['account']['ownerType'],'个人')))
   imported=s.ok('/api/accounts/import',{'rows':[{'accountSerial':'公司99号','account':'owner-import@test','ownerType':'公司','accountType':'导入类型'}]})
   check(label('account import persists new owner column and account type'),lambda:(eq(imported['created'],1),eq(s.ok('/api/accounts/item?account=owner-import%40test')['account']['ownerType'],'公司'),eq('导入类型'in s.ok('/api/accounts/types')['items'],True)))
   check(label('account import rejects invalid ownership without creating account'),lambda:eq(s.call('/api/accounts/import',{'rows':[{'accountSerial':'公司98号','account':'bad-owner-import@test','ownerType':'INVALID'}]})[0],400))
   def concurrent_accounts():
    def one(i):return s.ok('/api/accounts',{'account':f'concurrent{i}@test','ownerType':'公司','autoSerial':True})['account']['accountSerial']
    with concurrent.futures.ThreadPoolExecutor(max_workers=3)as pool:serials=list(pool.map(one,range(3)))
    eq(len(set(serials)),3)
   check(label('concurrent account creation reserves distinct server-side serials'),concurrent_accounts)
   # Batch delete must not stop after six; use thirteen records.
   for i in range(13):s.ok('/api/accounts',{'account':f'bulk{i}@test','ownerType':'公司','autoSerial':True})
   deleted=s.ok('/api/accounts/bulk-delete',{'accounts':[f'bulk{i}@test'for i in range(13)]})
   check(label('batch deletes all thirteen eligible accounts'),lambda:eq(deleted['deleted'],13))
  cycle={**first,'name':'Cycle due','__operationId':'cycle-due','subscriptionMode':'cycle','startDate':'2026-06-25','expiryDate':'2026-07-25'}
  cyc=s.ok('/api/subscriptions',cycle);cid=cyc['subscription']['id'];check(label('cycle defaults auto-renew on'),lambda:eq(cyc['subscription']['autoRenew'],True))
  cron=s.ok('/__test__/cron');renewals=[x for x in s.history()if x['subscriptionId']==cid and x['source']=='auto_renew']
  check(label('auto renewal catches up multiple cycles and appends each cycle'),lambda:(eq(len(renewals)>=2,True),eq(s.disk(cid)['expiryDate']>'2026-09-25',True),eq(len({x['id'] for x in renewals}),len(renewals))))
  s.ok('/__test__/cron');check(label('second cron does not duplicate renewed periods'),lambda:eq(len([x for x in s.history()if x['subscriptionId']==cid and x['source']=='auto_renew']),len(renewals)))
  no={**cycle,'name':'Cycle no payment','__operationId':'cycle-no-payment','autoRenew':False};noid=s.ok('/api/subscriptions',no)['subscription']['id'];s.ok('/__test__/cron')
  check(label('explicit auto-renew off advances cycle without inventing paid history'),lambda:(eq(len([x for x in s.history()if x['subscriptionId']==noid and x['source']=='auto_renew']),0),eq(s.disk(noid)['expiryDate']>'2026-09-25',True)))
  backup=s.ok('/api/backup');check(label('backup contains separate ledger, ownership and saved templates'),lambda:(eq(backup['version'],7),eq(len(backup['subscriptionLedger']),len(s.history())),eq(backup['tableTemplates']['base'][0]['name'],'保留模板-base')))
  count=len(s.history());s.ok('/api/restore',{'backup':backup,'mode':'merge'});s.ok('/api/restore',{'backup':backup,'mode':'merge'})
  check(label('restoring same backup twice does not duplicate history'),lambda:eq(len(s.history()),count))
  # Restore validates the entire ledger before touching current data.
  conflict=json.loads(json.dumps(backup));conflict['subscriptions'][0]['notes']='MUST NOT BE WRITTEN';conflict['subscriptionLedger'][0]['snapshot']['amount']=7654321
  conflict.pop('integrity',None);conflict['version']=6
  before=[json.dumps(x,sort_keys=True)for x in s.ok('/api/subscriptions')]
  check(label('conflicting backup rejected before changing any active data'),lambda:(eq(s.call('/api/restore',{'backup':conflict,'mode':'merge'})[0],400),eq([json.dumps(x,sort_keys=True)for x in s.ok('/api/subscriptions')],before),eq(len(s.history()),count)))
  malformed={**backup,'subscriptionLedger':'invalid'}
  check(label('malformed history backup rejected before writes'),lambda:eq(s.call('/api/restore',{'backup':malformed,'mode':'merge'})[0],400))
  legacy={**backup,'version':5,'subscriptions':[{**make(),'id':'legacy-restored-late','paymentHistory':[],'createdAt':'2026-01-01T00:00:00.000Z'}]};legacy.pop('subscriptionLedger',None);legacy.pop('integrity',None)
  s.ok('/api/restore',{'backup':legacy,'mode':'merge'})
  check(label('older backup restored after migration still creates its legacy history'),lambda:eq(len([x for x in s.history()if x['subscriptionId']=='legacy-restored-late']),1))
  s.ok('/api/restore',{'backup':legacy,'mode':'merge'});count=len(s.history())
  check(label('exact subscription history filter excludes other accounts/names'),lambda:eq({x['subscriptionId']for x in s.ok('/api/subscription-history?subscriptionId='+urllib.parse.quote(sid)+'&pageSize=500')['items']},{sid}))
  # Spending is based on immutable entries, not mutable current membership snapshots.
  from datetime import datetime,timezone
  date=datetime.now(timezone.utc).strftime('%Y-%m-%d');ex={**first,'name':'Dashboard Audit','customType':'充值','amount':37.5,'startDate':date,'expiryDate':date,'__operationId':'dashboard-event'}
  s.ok('/api/subscriptions',ex);stats=s.ok('/api/dashboard/stats')['data'];count=len(s.history())
  check(label('dashboard groups cumulative recorded spending by subscription name'),lambda:(eq(next(x for x in stats['expenseByName']if x['name']=='Dashboard Audit')['amount'],37.5),eq(any(x['type']=='充值'for x in stats['expenseByType']),True),eq('expenseByCategory'in stats,False)))
  s.ok('/api/subscriptions/'+sid,None,'DELETE');check(label('deleting current record leaves financial history intact'),lambda:(eq(len(s.history()),count),eq(any(x['id']==sid for x in s.ok('/api/subscriptions')),False)))
 except Exception as e:
  RESULTS.append({'name':label('unexpected workflow interruption'),'passed':False,'error':repr(e)});print('FAIL interrupted',repr(e),flush=True)
 finally:s.stop()
(OUT/'results.json').write_text(json.dumps(RESULTS,ensure_ascii=False,indent=2));print('TOTAL',len(RESULTS),'PASS',sum(x['passed'] for x in RESULTS),'FAIL',sum(not x['passed']for x in RESULTS),flush=True)

sys.exit(1 if any(not x["passed"] for x in RESULTS) else 0)
