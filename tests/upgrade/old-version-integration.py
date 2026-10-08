"""Read-only project audit; tests mutate only synthetic local copies, never Cloudflare."""
from pathlib import Path
import subprocess, socket, json, time, urllib.request, urllib.error, http.cookiejar, sys, shutil, os, argparse
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "support"))
from sqlite_local import query_rows, execute_transaction, NODE
parser=argparse.ArgumentParser(description='Synthetic cross-version integration; baseline-dir must contain extracted 18 and 19 releases.')
parser.add_argument('--baseline-dir',required=True,type=Path);parser.add_argument('--root',default=Path(__file__).resolve().parents[2],type=Path);parser.add_argument('--out',required=True,type=Path)
args=parser.parse_args();BASE=args.baseline_dir.resolve();ROOT=args.root.resolve();OUT=args.out.resolve()
if OUT.exists(): raise SystemExit('Use a new output directory; existing data is not overwritten')
OUT.mkdir(parents=True)
RESULTS=[]
class Server:
 def __init__(self, version, state):
  self.root = ROOT if version==20 else BASE / str(version); self.state = state; state.mkdir(parents=True, exist_ok=True)
  with socket.socket() as s: s.bind(('127.0.0.1',0)); self.port=s.getsockname()[1]
  self.log=(state/f'run-{version}.log').open('a')
  self.p=subprocess.Popen([NODE,str(self.root/'tests/regression/local-server.mjs'),str(self.root),str(state),str(self.port)],stdout=self.log,stderr=subprocess.STDOUT)
  self.op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
  for _ in range(100):
   if self.p.poll() is not None: raise RuntimeError((state/f'run-{version}.log').read_text())
   try: self.req('/__test__/login'); return
   except OSError: time.sleep(.05)
  raise RuntimeError('startup timeout')
 def req(self,path,data=None,method=None):
  req=urllib.request.Request(f'http://127.0.0.1:{self.port}'+path,data=json.dumps(data).encode() if data is not None else None,method=method or ('POST' if data is not None else 'GET'),headers={'Content-Type':'application/json'})
  try: r=self.op.open(req,timeout=20)
  except urllib.error.HTTPError as e: r=e
  data=json.loads(r.read())
  if r.status>=300: raise RuntimeError((path,r.status,data))
  return data
 def stop(self):
  self.p.terminate();self.p.wait(5);self.log.close()
def record(name,**facts):
 RESULTS.append({'name':name,**facts}); print(json.dumps(RESULTS[-1],ensure_ascii=False),flush=True)
def kvread(state): return json.loads((state/'kv.json').read_text())
def rawsubs(state):
 k=kvread(state);return {x:k['sub:'+x] for x in json.loads(k['sub_index'])}
def dbrows(state,table):
 return query_rows(state/'d1.sqlite', f'SELECT * FROM {table} ORDER BY 1')
state=OUT/'baseline18'
s=Server(18,state)
try:
 before=s.req('/api/subscriptions')
 assert len(before)==3
 s.req('/api/accounts',{'account':'upgrade-audit@example.test','accountSerial':'公司01号','realName':'Synthetic owner','accountType':'邮箱','passwords':{'tapnow':'synthetic-test-not-a-real-password'}})
 for scope in ('subscription','database'):
  s.req('/api/ui-preferences/table-templates/'+scope,{'templates':[{'id':'audit-'+scope,'name':'保留模板-'+scope,'layout':{'order':['name','account'],'hidden':[]}}]},'PUT')
finally:s.stop()
# Add two legacy payments to one subscription identically in both original stores.
k=kvread(state);a=json.loads(k['sub:row-a']);a['paymentHistory']=[{'id':'p1','amount':20,'currency':'CNY','date':'2026-08-01T00:00:00Z','periodStart':'2026-08-01','periodEnd':'2026-09-01'},{'id':'p2','amount':30,'currency':'CNY','date':'2026-09-01T00:00:00Z','periodStart':'2026-09-01','periodEnd':'2026-10-01'}];k['sub:row-a']=json.dumps(a);(state/'kv.json').write_text(json.dumps(k))
old=json.loads(query_rows(state/'d1.sqlite','SELECT data_json FROM subscriptions_current WHERE id=?',('row-a',))[0][0]);old['paymentHistory']=a['paymentHistory']
execute_transaction(state/'d1.sqlite',[('UPDATE subscriptions_current SET data_json=? WHERE id=?',(json.dumps(old),'row-a'))])
# Scenario 1: normal upgrade 18 -> 20, followed by a process restart.
normal=OUT/'normal';shutil.copytree(state,normal)
raw_before=rawsubs(normal);cred_before=dbrows(normal,'account_credentials');templates={key:v for key,v in kvread(normal).items() if key.startswith('ui:')};config=kvread(normal)['config']
subprocess.run([NODE,str(ROOT/'tests/upgrade/apply-fixture.mjs'),str(normal)],check=True,stdout=(normal/'upgrade.log').open('a'))
s=Server(20,normal)
try:
 current=s.req('/api/subscriptions');history=s.req('/api/subscription-history?pageSize=500')['items'];account=s.req('/api/accounts/item?account=upgrade-audit%40example.test')['account']
 record('normal_upgrade',current_count=len(current),legacy_history_count=len(history),original_raw_subscriptions_identical=raw_before==rawsubs(normal),encrypted_account_credentials_identical=cred_before==dbrows(normal,'account_credentials'),templates_identical=all(kvread(normal).get(x)==v for x,v in templates.items()),config_identical=kvread(normal)['config']==config,old_account_serial=account['accountSerial'],inferred_owner_type=account.get('ownerType'))
 assert len(history)==4
finally:s.stop()
subprocess.run([NODE,str(ROOT/'tests/upgrade/apply-fixture.mjs'),str(normal)],check=True,stdout=(normal/'upgrade.log').open('a'))
s=Server(20,normal)
try: record('restart_migration_idempotency',history_count=len(s.req('/api/subscription-history?pageSize=500')['items']))
finally:s.stop()
# Scenario 2: v18 KV has 3 rows, while D1 has 1; its once-only seed marker already exists.
gap=OUT/'partial_d1';shutil.copytree(state,gap)
execute_transaction(gap/'d1.sqlite',[("DELETE FROM subscriptions_current WHERE id IN ('row-b','row-history')",()),("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('subscription_ledger_seed_3319','done')",())])
subprocess.run([NODE,str(ROOT/'tests/upgrade/apply-fixture.mjs'),str(gap)],check=True,stdout=(gap/'upgrade.log').open('a'))
s=Server(20,gap)
try:
 current=s.req('/api/subscriptions');history=s.req('/api/subscription-history?pageSize=500')['items']
 marker_rows=query_rows(gap/'d1.sqlite',"SELECT value FROM schema_meta WHERE key='subscription_ledger_seed_3320'");marker=marker_rows[0] if marker_rows else None
 record('partial_d1_history_omission',kv_subscriptions=len(rawsubs(gap)),current_ids=[x['id'] for x in current],migrated_history_count=len(history),expected_legacy_history_count=4,missing_history_subscription_ids=sorted(set(rawsubs(gap))-{x['subscriptionId'] for x in history}),migration_marked_done=marker[0] if marker else None,raw_records_deleted=False)
finally:s.stop()
# Scenario 3: D1 is complete, but its row-a paymentHistory is older than KV.
stale=OUT/'stale_d1';shutil.copytree(state,stale)
old=json.loads(query_rows(stale/'d1.sqlite','SELECT data_json FROM subscriptions_current WHERE id=?',('row-a',))[0][0]);old['paymentHistory']=old['paymentHistory'][:1];old['updatedAt']='2026-08-01T00:00:00Z'
execute_transaction(stale/'d1.sqlite',[('UPDATE subscriptions_current SET data_json=?,updated_at=? WHERE id=?',(json.dumps(old),old['updatedAt'],'row-a'))])
subprocess.run([NODE,str(ROOT/'tests/upgrade/apply-fixture.mjs'),str(stale)],check=True,stdout=(stale/'upgrade.log').open('a'))
s=Server(20,stale)
try:
 history=s.req('/api/subscription-history?pageSize=500')['items'];current=s.req('/api/subscriptions');a=next(x for x in current if x['id']=='row-a')
 record('stale_d1_payment_omission',current_payment_count=len(a['paymentHistory']),ledger_payment_ids=[x['id'] for x in history if x['subscriptionId']=='row-a'],expected_ledger_payment_ids=['legacy:row-a:p1','legacy:row-a:p2'])
finally:s.stop()
# Scenario 4: newest successfully mirrored values exist in D1 but the KV copy is old.
backup=OUT/'backup_divergence';shutil.copytree(state,backup)
old=json.loads(query_rows(backup/'d1.sqlite','SELECT data_json FROM subscriptions_current WHERE id=?',('row-b',))[0][0]);old['notes']='LATEST_D1_CONFIRMED_VALUE';old['updatedAt']='2026-09-28T08:00:00Z'
execute_transaction(backup/'d1.sqlite',[('UPDATE subscriptions_current SET data_json=?,updated_at=? WHERE id=?',(json.dumps(old),old['updatedAt'],'row-b'))])
subprocess.run([NODE,str(ROOT/'tests/upgrade/apply-fixture.mjs'),str(backup)],check=True,stdout=(backup/'upgrade.log').open('a'))
s=Server(20,backup)
try:
 current=s.req('/api/subscriptions');export=s.req('/api/backup');a=next(x for x in current if x['id']=='row-b');b=next(x for x in export['subscriptions'] if x['id']=='row-b')
 record('backup_current_mismatch',table_current_notes=a['notes'],exported_notes=b['notes'],backup_includes_latest_value=a['notes']==b['notes'],default_backup_contains_saved_passwords=any(x.get('passwords') or x.get('legacyPassword') for x in export.get('accounts',[])))
finally:s.stop()
assert all(RESULTS[0][k] for k in ['original_raw_subscriptions_identical','encrypted_account_credentials_identical','templates_identical','config_identical'])
assert RESULTS[1]['history_count']==4
assert RESULTS[2]['migrated_history_count']==4 and RESULTS[2]['missing_history_subscription_ids']==[]
assert set(RESULTS[3]['ledger_payment_ids'])==set(RESULTS[3]['expected_ledger_payment_ids'])
assert RESULTS[4]['backup_includes_latest_value']

# Real v3.3.19 API creates its old history, then the protected upgrade retains every old row.
from19=OUT/'actual19';shutil.copytree(state,from19)
s=Server(19,from19)
try:
 old_history=s.req('/api/subscription-history?pageSize=500')['items']
 assert len(old_history)==4
finally:s.stop()
ledger_table=next(row[0] for row in query_rows(from19/'d1.sqlite',"SELECT name FROM sqlite_master WHERE type='table'") if row[0]=='subscription_ledger')
old_columns=[row[1] for row in query_rows(from19/'d1.sqlite','PRAGMA table_info('+ledger_table+')')]
old_rows=query_rows(from19/'d1.sqlite','SELECT * FROM '+ledger_table+' ORDER BY 1')
old_kv=kvread(from19)
subprocess.run([NODE,str(ROOT/'tests/upgrade/apply-fixture.mjs'),str(from19)],check=True,stdout=(from19/'upgrade.log').open('a'))
s=Server(20,from19)
try:
 upgraded_history=s.req('/api/subscription-history?pageSize=500')['items']
 after_rows=query_rows(from19/'d1.sqlite','SELECT '+','.join(old_columns)+' FROM '+ledger_table+' ORDER BY 1')
 assert after_rows==old_rows
 assert all(kvread(from19)[key]==value for key,value in old_kv.items())
 assert {r['id'] for r in upgraded_history}=={r['id'] for r in old_history}
 record('actual_3319_to_3320',passed=True,old_history_rows=len(old_rows),retained_history_rows=len(after_rows),all_original_keys_identical=True,all_original_ledger_columns_identical=True)
 exported=s.req('/api/backup');assert exported['version']==7
 exported['subscriptions'][0]['notes']='TAMPERED_COPY_ONLY'
 before_values=kvread(from19);before_rows=dbrows(from19,'subscriptions_current')
 try: s.req('/api/restore',exported,'POST');raise AssertionError('Tampered backup was accepted')
 except RuntimeError as e: assert '400' in str(e) and '校验' in str(e),str(e)
 assert kvread(from19)==before_values and dbrows(from19,'subscriptions_current')==before_rows
 record('v7_json_checksum_tamper_rejected',passed=True,all_originals_unchanged=True)
finally:s.stop()

record('all_upgrade_assertions_passed',passed=True)
(OUT/'results.json').write_text(json.dumps(RESULTS,ensure_ascii=False,indent=2))
