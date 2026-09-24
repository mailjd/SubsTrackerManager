"""Browser DOM -> real local production router -> disk persistence regression.
Uses about:blank + set_content, Web Storage adapters and an async loopback fetch
bridge because navigation in the runner is restricted. Does not alter browser
policy, contact Cloudflare, or assert pixel-perfect Tailwind rendering.
Requires Python playwright and a Chromium executable (CHROMIUM_PATH supported).
Usage: python tests/regression/browser-regression.py [sourceRoot] [outputDirectory]
"""
import asyncio, json, os, socket, sys, time, subprocess, urllib.request, urllib.error, http.cookiejar
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path(__file__).resolve().parents[2]
OUT=Path(sys.argv[2]).resolve() if len(sys.argv)>2 else ROOT/'browser-regression-output'
OUT.mkdir(parents=True,exist_ok=True)
STATE=OUT/'browser-state';STATE.mkdir(exist_ok=True)
with socket.socket() as sock:sock.bind(('127.0.0.1',0));PORT=sock.getsockname()[1]
BASE=f'http://127.0.0.1:{PORT}';COOKIE='';PROC=None
RESULTS=[]
def raw_call(url,opts=None):
    opts=opts or {};url=BASE+url if url.startswith('/') else url
    if not url.startswith(BASE+'/'):raise ValueError('Regression bridge only permits its loopback origin')
    headers={**opts.get('headers',{}),'Cookie':COOKIE}
    req=urllib.request.Request(url,method=opts.get('method','GET'),headers=headers,data=opts.get('body','').encode() if opts.get('body') else None)
    try:r=urllib.request.urlopen(req,timeout=15)
    except urllib.error.HTTPError as e:r=e
    return {'status':r.status,'headers':dict(r.headers),'body':r.read().decode()}
def start():
    global PROC,COOKIE
    PROC=subprocess.Popen(['node',str(ROOT/'tests/regression/local-server.mjs'),str(ROOT),str(STATE),str(PORT)],stdout=(OUT/'server.log').open('a'),stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            r=raw_call('/__test__/login');COOKIE=r['headers']['Set-Cookie'].split(';')[0];return
        except (OSError,ConnectionError):time.sleep(.1)
    raise RuntimeError('server did not start')
def stop():
    global PROC
    if PROC:PROC.terminate();PROC.wait(timeout=5);PROC=None
async def call(path,data=None,method='POST'):
    r=await asyncio.to_thread(raw_call,path,({'method':method,'headers':{'Content-Type':'application/json'},'body':json.dumps(data)} if data is not None else {}))
    return r['status'],json.loads(r['body'])
def stored(id='row-a'):return json.loads(json.loads((STATE/'kv.json').read_text())['sub:'+id])
def eq(a,b):assert a==b,f'actual {a!r} != expected {b!r}'
async def main():
    start()
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
        page=None;contexts=[];errors=[];tamper={'version':False,'ack':False}
        async def new_page(session=None,local=None):
            nonlocal page,errors
            if page:await page.close()
            errors=[]
            ctx=await browser.new_context(viewport={'width':1500,'height':1050});contexts.append(ctx);page=await ctx.new_page();page.set_default_timeout(6000)
            page.on('pageerror',lambda e:errors.append(str(e)))
            async def bridge(url,options):
                r=await asyncio.to_thread(raw_call,url,options)
                if url.startswith('/api/version') and tamper['version']:
                    body=json.loads(r['body']);body.update(version='3.3.17',tableEditProtocol=1);r['body']=json.dumps(body)
                if url.endswith('/table-edit') and tamper['ack']:
                    body=json.loads(r['body'])
                    if body.get('subscription'):body['subscription']['notes']='WRONG ACK VALUE';r['body']=json.dumps(body)
                return r
            await page.expose_function('__localFetch',bridge)
            await page.evaluate('''({session,local})=>{
              function storage(init){const data=Object.assign({},init);return {getItem:k=>Object.hasOwn(data,k)?data[k]:null,setItem:(k,v)=>data[k]=String(v),removeItem:k=>delete data[k],clear:()=>Object.keys(data).forEach(k=>delete data[k]),key:i=>Object.keys(data)[i]||null,get length(){return Object.keys(data).length}}}
              Object.defineProperty(window,'localStorage',{value:storage({subscriptionViewModeV2:'table',...local}),configurable:true});
              Object.defineProperty(window,'sessionStorage',{value:storage(session||{}),configurable:true});
              window.fetch=async(url,options={})=>{const r=await window.__localFetch(String(url),options);return new Response(r.body,{status:r.status,headers:r.headers})};
            }''',{'session':session or {},'local':local or {}})
            html=(await asyncio.to_thread(raw_call,'/admin'))['body'];css=(await asyncio.to_thread(raw_call,'/__test__/utility.css'))['body']
            html=html.replace('<link rel="stylesheet" href="/__test__/utility.css">','<style>'+css+'</style>')
            await page.set_content(html,wait_until='domcontentloaded');await page.wait_for_selector('tr[data-subscription-id="row-a"]');await page.wait_for_timeout(400)
            return page
        def cell(col,id='row-a'):return page.locator(f'#subscriptionsExcelBody tr[data-subscription-id="{id}"] td[data-col="{col}"]')
        async def edit(col,value,id='row-a',commit=False):
            await cell(col,id).dblclick();e=cell(col,id).locator('[data-table-cell-editor]');tag=await e.evaluate('(el)=>el.tagName')
            if tag=='SELECT':await e.select_option(value)
            else:await e.fill(value)
            if commit:await e.press('Tab');await page.wait_for_timeout(60)
        async def pending():return await page.evaluate("JSON.parse(sessionStorage.getItem('subscriptionTablePendingEditsV1')||'{}')")
        async def save():
            await page.locator('#saveTableEditsBtn').click()
            await page.wait_for_function("!document.getElementById('saveTableEditsBtn').innerText.includes('保存中')")
            await page.wait_for_timeout(80)
        async def reset():
            tamper.update(version=False,ack=False)
            await call('/__test__/controls',{'failPatch':False,'failIds':[],'delayPatch':0,'dropWrites':False,'dropD1Writes':False,'dropReminderWrites':False,'staleReads':False})
            for id in ['row-a','row-b']:
                status,r=await call('/api/subscriptions/'+id+'/table-edit',{'clientVersion':'3.3.18','changes':{'name':'Row '+id[-1],'notes':'Original note','customType':'开会员','category':'Test','expiryDate':'2030-10-25','startDate':'2030-09-25','periodValue':1,'periodUnit':'month','currency':'CNY','memberLevel':'Pro'}},'PATCH');eq(status,200)
            await new_page()
        async def scenario(name,fn):
            try:
                await reset();await fn();eq(errors,[]);RESULTS.append({'name':name,'passed':True});print('PASS',name,flush=True)
            except Exception as e:
                RESULTS.append({'name':name,'passed':False,'error':str(e),'pageErrors':errors});print('FAIL',name,repr(e),flush=True)
                if page:
                    (OUT/('failure-'+str(len(RESULTS))+'.txt')).write_text(await page.locator('#tableSaveDiagnostic').inner_text())
                    await page.screenshot(path=str(OUT/('failure-'+str(len(RESULTS))+'.png')))
        async def direct_focus():
            await edit('name','Name typed with focus');eq(await page.locator('#saveTableEditsBtn').is_enabled(),True);await save();eq(stored()['name'],'Name typed with focus');eq(await pending(),{});eq(await page.locator('#saveTableEditsBtn').is_disabled(),True)
        await scenario('active input -> actual Save click -> disk',direct_focus)
        async def clear_type():
            await edit('customType','');await save();eq(stored()['customType'],'');eq((await cell('customType').inner_text()).strip(),'');eq(await pending(),{})
        await scenario('cleared subscription type stays cleared',clear_type)
        async def past_date():
            await edit('expiryDate','2025-10-25');await save();eq(stored()['expiryDate'],'2025-10-24T16:00:00.000Z');eq(await pending(),{});eq((await cell('expiryDate').inner_text()).strip(),'2025-10-25')
        await scenario('entered expired date is persisted exactly',past_date)
        async def multi():
            await edit('name','Multi field',commit=True);await edit('currency','USD',commit=True);await edit('amount','45.60');await save();eq(stored()['name'],'Multi field');eq(stored()['currency'],'USD');eq(stored()['amount'],45.6);eq(await pending(),{})
        await scenario('text + select + number saved together',multi)
        async def auto_date():
            await edit('startDate','2031-01-15');await save();eq(stored()['startDate'],'2031-01-14T16:00:00.000Z');eq(stored()['expiryDate'],'2031-02-14T16:00:00.000Z');eq(await pending(),{})
        await scenario('start date recalculates expiry and saves both',auto_date)
        async def clear_cancel():
            before=stored();_,trace=await call('/__test__/trace');count=len([x for x in trace if x['method']=='PATCH'])
            await edit('notes','CANCEL THIS');await page.locator('#cancelTableEditsBtn').click();await page.wait_for_timeout(100)
            eq(stored(),before);eq(await pending(),{});eq(await page.locator('[data-table-cell-editor]').count(),0);eq((await cell('notes').inner_text()).strip(),'Original note')
            _,trace=await call('/__test__/trace');eq(len([x for x in trace if x['method']=='PATCH']),count)
        await scenario('Cancel restores active and staged edits with no write',clear_cancel)
        async def fail_recover():
            await call('/__test__/controls',{'failPatch':True});await edit('notes','RETRY ME');await save();eq((await pending())['row-a']['notes'],'RETRY ME');eq(stored()['notes'],'Original note')
            await call('/__test__/controls',{'failPatch':False});await save();eq(stored()['notes'],'RETRY ME');eq(await pending(),{})
        await scenario('HTTP failure keeps drafts, retry persists',fail_recover)
        async def partial():
            await edit('name','Saved row a',commit=True);await edit('notes','Retry row b','row-b',commit=True)
            await call('/__test__/controls',{'failIds':['row-b']});await save();p=await pending();eq('row-a' in p,False);eq(p['row-b']['notes'],'Retry row b');eq(stored()['name'],'Saved row a');eq(stored('row-b')['notes'],'Original note')
            await call('/__test__/controls',{'failIds':[]});await save();eq(await pending(),{});eq(stored('row-b')['notes'],'Retry row b')
        await scenario('partial batch only clears successful row drafts',partial)
        async def paste():
            await cell('customType').click()
            await page.evaluate('''()=>{const data=new DataTransfer();data.setData('text/plain','粘贴类型\t粘贴分类');document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}''')
            await save();eq(stored()['customType'],'粘贴类型');eq(stored()['category'],'粘贴分类');eq(await pending(),{})
        await scenario('multi-cell paste enters draft and is persisted',paste)
        async def inflight():
            await call('/__test__/controls',{'delayPatch':1000});await edit('notes','ONE REQUEST');_,trace=await call('/__test__/trace');before=len([x for x in trace if x['method']=='PATCH'])
            await page.locator('#saveTableEditsBtn').click();await page.wait_for_timeout(200)
            eq(await page.locator('#saveTableEditsBtn').is_disabled(),True);eq(await page.locator('#cancelTableEditsBtn').is_disabled(),True)
            await page.evaluate("document.getElementById('saveTableEditsBtn').click()")
            await cell('name','row-b').dblclick();eq(await page.locator('[data-table-cell-editor]').count(),0)
            await page.wait_for_function("!document.getElementById('saveTableEditsBtn').innerText.includes('保存中')");_,trace=await call('/__test__/trace');eq(len([x for x in trace if x['method']=='PATCH'])-before,1);eq(stored()['notes'],'ONE REQUEST')
        await scenario('in-flight guard prevents duplicate save and new edits',inflight)
        async def invalid_ack():
            tamper['ack']=True;await edit('notes','ACTUAL INPUT');await save();eq((await pending())['row-a']['notes'],'ACTUAL INPUT');eq('input_value_mismatch' in (await page.locator('#tableSaveDiagnostic').inner_text()),True)
            tamper['ack']=False;await save();eq(await pending(),{})
        await scenario('forged success with wrong returned value rejected',invalid_ack)
        async def old_version():
            tamper['version']=True;await edit('notes','WAIT FOR DEPLOY');_,trace=await call('/__test__/trace');n=len([x for x in trace if x['method']=='PATCH']);await save()
            _,trace=await call('/__test__/trace');eq(len([x for x in trace if x['method']=='PATCH']),n);eq((await pending())['row-a']['notes'],'WAIT FOR DEPLOY');eq(stored()['notes'],'Original note')
        await scenario('older backend detected before PATCH; draft kept',old_version)
        async def rules():
            await edit('name','With full rules',commit=True);await edit('reminder','提前3/1天 · 到期当天');await save();eq(stored()['name'],'With full rules');eq([r['value'] for r in stored()['reminderRules']],[3,1,0]);eq(await pending(),{})
            await edit('reminder','');await save();eq(stored()['reminderRules'],[]);await new_page();eq('未设置提醒' in (await cell('reminder').inner_text()),True)
        await scenario('reminder editing and clear survive fresh page',rules)
        async def editor_refresh():
            await edit('notes','FOCUSED DRAFT')
            session=await page.evaluate("Object.fromEntries(Array.from({length:sessionStorage.length},(_,i)=>{const k=sessionStorage.key(i);return [k,sessionStorage.getItem(k)]}))")
            await new_page(session=session);eq((await pending())['row-a']['notes'],'FOCUSED DRAFT');await save();eq(stored()['notes'],'FOCUSED DRAFT')
        await scenario('focused editor draft survives page reconstruction',editor_refresh)
        async def escape():
            await edit('name','ESCAPED');await cell('name').locator('[data-table-cell-editor]').press('Escape');await page.wait_for_timeout(100);eq(await page.locator('[data-table-cell-editor]').count(),0);eq((await cell('name').inner_text()).strip(),'Row a');eq(await pending(),{})
        await scenario('Escape removes editor and restores previous value',escape)
        async def restart_browser():
            await edit('notes','PERSIST ACROSS BOTH RESTARTS');await save();stop();start();await new_page(session={},local={});eq((await cell('notes').inner_text()).strip(),'PERSIST ACROSS BOTH RESTARTS');eq(await pending(),{});eq(stored()['notes'],'PERSIST ACROSS BOTH RESTARTS')
            await page.screenshot(path=str(OUT/'verified-fresh-page.png'),full_page=False)
        await scenario('new server process + fresh browser storage still reads edit',restart_browser)
        await browser.close()
    stop()
    (OUT/'browser-results.json').write_text(json.dumps({'environment':'Chromium DOM + async loopback fetch + file KV / SQLite; Web Storage adapters; not Cloudflare or pixel-perfect CDN styles','tests':RESULTS,'passed':sum(x['passed'] for x in RESULTS),'failed':sum(not x['passed'] for x in RESULTS)},ensure_ascii=False,indent=2))
try:asyncio.run(main())
finally:stop()
sys.exit(1 if any(not x['passed'] for x in RESULTS) else 0)
