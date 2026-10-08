"""Browser integration for v3.3.19; real local API + file-backed SQLite/KV.
Uses offline style fallback: asserts behavior/colors/element bounds, not full CDN rendering.
"""
import asyncio,json,os,tempfile,socket,sys,time,subprocess,urllib.request,urllib.error
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(sys.argv[1] if len(sys.argv)>1 else '.').resolve();OUT=Path(sys.argv[2] if len(sys.argv)>2 else tempfile.mkdtemp(prefix='subs-workflow-ui-3319-')).resolve();OUT.mkdir(parents=True,exist_ok=True);STATE=OUT/'state';STATE.mkdir(exist_ok=True)
with socket.socket()as so:so.bind(('127.0.0.1',0));PORT=so.getsockname()[1]
BASE='http://127.0.0.1:'+str(PORT);COOKIE='';RESULTS=[]
def raw(url,opt=None):
 opt=opt or {};req=urllib.request.Request(BASE+url,method=opt.get('method','GET'),headers={**opt.get('headers',{}),'Cookie':COOKIE},data=opt['body'].encode() if opt.get('body') else None)
 try:r=urllib.request.urlopen(req,timeout=30)
 except urllib.error.HTTPError as e:r=e
 return {'status':r.status,'headers':dict(r.headers),'body':r.read().decode()}
def api(path,data=None,method=None):
 r=raw(path,{'method':method or ('POST'if data is not None else'GET'),'headers':{'Content-Type':'application/json'},**({'body':json.dumps(data)}if data is not None else{})});v=json.loads(r['body']);assert r['status']<300,(r['status'],v);return v
def eq(a,b):assert a==b,(a,b)
async def main():
 global COOKIE
 proc=subprocess.Popen(['node',str(ROOT/'tests/regression/local-server.mjs'),str(ROOT),str(STATE),str(PORT)],stdout=(OUT/'server.log').open('a'),stderr=subprocess.STDOUT)
 try:
  for _ in range(80):
   try:COOKIE=raw('/__test__/login')['headers']['Set-Cookie'].split(';')[0];break
   except OSError:time.sleep(.1)
  for i in range(3):api('/api/accounts',{'account':f'ui{i}@test','ownerType':'个人'if i==1 else'公司','autoSerial':True,'accountType':['邮箱','微信','手机号'][i],'realName':f'Person {i}'})
  api('/api/menu-options',{'group':'subscriptionNames','name':'UI original'})
  async with async_playwright()as pw:
   browser=await pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox']);page=None;errors=[];prompt='UI template'
   async def open_page(path,local=None,session=None):
    nonlocal page,errors
    if page:await page.context.close()
    ctx=await browser.new_context(viewport={'width':1800,'height':1100});page=await ctx.new_page();page.set_default_timeout(5000);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    async def dialog(d):await d.accept(prompt)if d.type=='prompt'else await d.accept()
    page.on('dialog',dialog)
    await page.expose_function('__bridge',lambda url,opt:asyncio.to_thread(raw,url,opt))
    await page.evaluate('''({local,session})=>{function store(x){const data={...x};return {getItem:k=>Object.hasOwn(data,k)?data[k]:null,setItem:(k,v)=>data[k]=String(v),removeItem:k=>delete data[k],key:i=>Object.keys(data)[i],get length(){return Object.keys(data).length}}}Object.defineProperty(window,'localStorage',{value:store(local),configurable:true});Object.defineProperty(window,'sessionStorage',{value:store(session),configurable:true});window.fetch=async(url,opt={})=>{const r=await __bridge(String(url),opt);return new Response(r.body,{status:r.status,headers:r.headers})};}''',{'local':local or {},'session':session or {}})
    html=raw(path)['body'];css=raw('/__test__/utility.css')['body'];html=html.replace('<link rel="stylesheet" href="/__test__/utility.css">','<style>'+css+'</style>');await page.set_content(html,wait_until='domcontentloaded');await page.wait_for_timeout(500);await page.evaluate("document.documentElement.classList.add('dark')")
   async def scenario(name,fn):
    nonlocal errors
    errors=[]
    try:await fn();eq(errors,[]);RESULTS.append({'name':name,'passed':True});print('PASS',name,flush=True)
    except Exception as e:
     RESULTS.append({'name':name,'passed':False,'error':repr(e),'pageErrors':errors});print('FAIL',name,repr(e),errors,flush=True)
     if page:await page.screenshot(path=str(OUT/f'failure-{len(RESULTS)}.png'),full_page=True)
   async def default_tab():
    await open_page('/admin/database');await page.wait_for_selector('#baseTable tbody tr');eq(await page.locator('#baseTabPanel').is_visible(),True);eq(await page.locator('#accountTabPanel').is_hidden(),True);eq(await page.locator('#baseDatabaseTab').get_attribute('aria-selected'),'true')
   await scenario('Database opens foundation tab by default',default_tab)
   async def base_add():
    await page.locator('#baseAdd').click();await page.locator('#baseAddGroup').select_option('subscriptionNames');await page.locator('#baseAddValue').fill('UI added');await page.locator('#baseAddForm button[type=submit]').click();await page.wait_for_selector('#baseTable td[data-col=value]:has-text("UI added")');eq('UI added'in api('/api/menu-options')['menus']['subscriptionNames'],True);await page.locator('#baseAddClose').click()
   await scenario('foundation Add writes same source used by subscription menus',base_add)
   async def base_edit():
    await page.locator('#baseTable td[data-col=value]').filter(has_text='UI original').dblclick();await page.locator('#baseTable .db-cell-editor').fill('UI renamed');eq(await page.locator('#baseSave').is_enabled(),True);await page.locator('#baseSave').click();await page.wait_for_function("document.getElementById('baseSave').disabled && !sessionStorage.getItem('baseDatabaseDraftV1')");eq('UI renamed'in api('/api/menu-options')['menus']['subscriptionNames'],True)
   await scenario('foundation double-click edit enables Save immediately and persists',base_edit)
   async def base_cancel():
    await page.locator('#baseTable td[data-col=value]').filter(has_text='UI renamed').dblclick();await page.locator('#baseTable .db-cell-editor').fill('DO NOT KEEP');await page.locator('#baseCancel').click();eq(await page.locator('#baseTable td[data-col=value]').filter(has_text='UI renamed').count(),1);eq(await page.evaluate("sessionStorage.getItem('baseDatabaseDraftV1')"),None)
   await scenario('foundation Cancel removes active and staged edits',base_cancel)
   async def base_sort():
    await page.locator('#baseTable th[data-col=value] .db-header-label').dblclick();eq(await page.evaluate("JSON.parse(localStorage.getItem('baseDatabaseLayoutV1')).sort.direction"),'asc');await page.locator('#baseTable th[data-col=value] .db-header-label').dblclick();eq(await page.evaluate("JSON.parse(localStorage.getItem('baseDatabaseLayoutV1')).sort.direction"),'desc')
   await scenario('foundation double-click header toggles sorting',base_sort)
   async def base_filter():
    await page.locator('#baseTable [data-menu=value]').click();await page.locator('#baseHeaderMenu [data-all="0"]').click();await page.locator('#baseHeaderMenu label').filter(has_text='UI renamed').locator('input').check();await page.locator('#baseHeaderMenu [data-apply]').click();eq(await page.locator('#baseTable tbody tr').count(),1);await page.locator('#baseReset').click()
   await scenario('foundation header supports multi-select value filtering',base_filter)
   async def base_template():
    await page.locator('#baseSaveTemplate').click();await page.wait_for_function("document.getElementById('baseTemplate').value!==''");eq(api('/api/ui-preferences/table-templates/base')['templates'][0]['name'],'UI template');await page.locator('#baseTemplate').select_option('__default__');eq(len(api('/api/ui-preferences/table-templates/base')['templates']),1)
   await scenario('foundation default template consumes no custom template slot',base_template)
   async def account_open():
    await page.locator('#accountDatabaseTab').click();await page.wait_for_selector('#accountsBody tr[data-account-key]');eq(await page.locator('#baseTabPanel').is_hidden(),True);eq(await page.locator('#accountsTable th[data-col=updatedAt]').inner_text(),'最後修改時間');eq(await page.locator('#accountsTable th[data-col=ownerType]').inner_text(),'公/私')
   await scenario('account tab retains accounts grid with new headers',account_open)
   def acell(c,key='ui0@test'):return page.locator('#accountsBody tr[data-account-key="'+urllib.parse.quote(key,safe='')+'"] td[data-col="'+c+'"]')
   async def no_white():
    await acell('realName').click();color=await acell('realName').evaluate('(e)=>getComputedStyle(e).backgroundColor');eq(color,'rgb(43, 57, 82)');eq(await acell('realName').locator('.db-cell-editor').count(),0)
   await scenario('account selection is dark BEFORE editing',no_white)
   async def small_arrow():
    widths=await page.locator('#accountsTable .db-sort-btn').evaluate_all('(els)=>els.map(e=>e.getBoundingClientRect().width)');eq(all(0<w<=24 for w in widths),True)
   await scenario('header arrows stay small, column resize does not enlarge buttons',small_arrow)
   async def account_edit():
    await acell('realName').dblclick();await acell('realName').locator('input').fill('Saved Person');eq(await page.locator('#saveDatabaseTableEditsBtn').is_enabled(),True);await page.locator('#saveDatabaseTableEditsBtn').click();await page.wait_for_function("!sessionStorage.getItem('databaseTablePendingEditsV1')");eq(api('/api/accounts/item?account=ui0%40test')['account']['realName'],'Saved Person')
   await scenario('account active input Save returns verified persisted value',account_edit)
   async def account_owner_edit():
    await acell('ownerType').dblclick();await acell('ownerType').locator('select').select_option('个人');await page.locator('#saveDatabaseTableEditsBtn').click();await page.wait_for_function("!sessionStorage.getItem('databaseTablePendingEditsV1')");eq(api('/api/accounts/item?account=ui0%40test')['account']['ownerType'],'个人')
   await scenario('ownership cell uses two-choice dropdown and persists',account_owner_edit)
   async def account_cancel():
    await acell('realName').dblclick();await acell('realName').locator('input').fill('DO NOT SAVE');await page.locator('#cancelDatabaseTableEditsBtn').click();await page.wait_for_function("!sessionStorage.getItem('databaseTablePendingEditsV1')");eq(api('/api/accounts/item?account=ui0%40test')['account']['realName'],'Saved Person')
   await scenario('account Cancel clears all drafts and restores original row',account_cancel)
   async def account_paste():
    await acell('realName').click();await page.evaluate("()=>{const dt=new DataTransfer();dt.setData('text/plain','Pasted Person');document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}");eq(await page.locator('#saveDatabaseTableEditsBtn').is_enabled(),True);await page.locator('#saveDatabaseTableEditsBtn').click();await page.wait_for_function("!sessionStorage.getItem('databaseTablePendingEditsV1')");eq(api('/api/accounts/item?account=ui0%40test')['account']['realName'],'Pasted Person')
   await scenario('account clipboard paste marks and saves edits',account_paste)
   async def account_sort():
    await page.locator('#accountsTable th[data-col=account] .db-header-label').dblclick();await page.wait_for_timeout(200);eq(await page.evaluate("JSON.parse(localStorage.getItem('databaseTableLayoutV1')).sort"),{'column':'account','direction':'asc'})
   await scenario('account header double-click performs server sorting',account_sort)
   async def account_filter():
    await page.locator('#accountsTable .db-sort-btn[data-col=ownerType]').click();await page.wait_for_selector('#dbTableSortMenu label');await page.locator('#dbTableSortMenu [data-all="0"]').click();await page.locator('#dbTableSortMenu label').filter(has_text='公司').locator('input').check();await page.locator('#dbTableSortMenu [data-apply]').click();await page.wait_for_timeout(300);eq(await page.locator('#accountsBody tr[data-account-key]').count(),1);eq(await page.locator('#accountsBody td[data-col=ownerType]').inner_text(),'公司');await page.locator('#resetDatabaseTableLayoutBtn').click();await page.wait_for_timeout(200)
   await scenario('account header filters entire database before pagination',account_filter)
   async def hide():
    await page.locator('#displayDatabaseColumnsBtn').click();await page.locator('#dbTableSortMenu label').filter(has_text='实名人').locator('input').uncheck();eq(await page.locator('#accountsTable th[data-col=realName]').is_hidden(),True);await page.locator('#displayDatabaseColumnsBtn').click();await page.locator('#dbTableSortMenu button').filter(has_text='全部显示').click();eq(await page.locator('#accountsTable th[data-col=realName]').is_visible(),True)
   await scenario('account columns hide/show and persist layout',hide)
   async def drag():
    await page.evaluate("()=>{const src=document.querySelector('#accountsTable th[data-col=ownerType]'),dst=document.querySelector('#accountsTable th[data-col=accountSerial]'),dt=new DataTransfer();src.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));dst.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt,clientX:dst.getBoundingClientRect().left+1}));src.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));}");order=await page.evaluate("JSON.parse(localStorage.getItem('databaseTableLayoutV1')).order");eq(order[1],'ownerType');eq(order[0],'select');eq(order[-1],'actions')
   await scenario('account column reorder keeps selection/actions pinned',drag)
   async def tpl():
    nonlocal prompt
    prompt='Account layout';await page.locator('#saveDatabaseTableTemplateBtn').click();await page.wait_for_timeout(300);eq(api('/api/ui-preferences/table-templates/database')['templates'][0]['name'],'Account layout');await page.locator('#databaseTableTemplateSelect').select_option('__default__');eq(len(api('/api/ui-preferences/table-templates/database')['templates']),1)
   await scenario('account saved template cloud persistence + free default template',tpl)
   async def create_account():
    await page.locator('#addAccountBtn').click();await page.wait_for_function("document.getElementById('accountSerial').value!==''");eq(await page.locator('#accountSerial').input_value(),'公司03号');eq(await page.locator('#accountType').evaluate('(e)=>e.tagName'),'SELECT');eq(set(await page.locator('#ownerType option').all_text_contents()),{'公司','个人'});await page.locator('#ownerType').select_option('个人');await page.wait_for_function("document.getElementById('accountSerial').value==='个人02号'");await page.locator('#account').fill('created-from-ui@test');await page.locator('#accountType').select_option('邮箱');await page.locator('#saveAccountBtn').click();await page.wait_for_function("document.getElementById('accountModal').classList.contains('hidden')");eq(api('/api/accounts/item?account=created-from-ui%40test')['account']['accountSerial'],'个人02号')
   await scenario('new account owner choice generates correct serial and saves',create_account)
   async def reload():
    await open_page('/admin/database');await page.wait_for_function("document.getElementById('baseTemplate').options.length>2 && document.getElementById('databaseTableTemplateSelect').options.length>2");eq(await page.locator('#baseTabPanel').is_visible(),True);eq('Account layout'in await page.locator('#databaseTableTemplateSelect').inner_text(),True);await page.screenshot(path=str(OUT/'database-foundation.png'),full_page=True);await page.locator('#accountDatabaseTab').click();await page.wait_for_timeout(300);await page.screenshot(path=str(OUT/'database-accounts.png'),full_page=True)
   await scenario('fresh browser local storage recovers both template scopes from server',reload)
   async def admin_mode():
    await open_page('/admin',{'subscriptionViewModeV2':'table'});await page.wait_for_selector('#subscriptionsExcelBody tr');await page.locator('#addSubscriptionBtn').click();await page.locator('#subscriptionMode').select_option('reset');eq(await page.locator('#autoRenew').is_checked(),False);await page.locator('#subscriptionMode').select_option('cycle');eq(await page.locator('#autoRenew').is_checked(),True);await page.locator('#autoRenew').uncheck();eq(await page.locator('#autoRenew').is_checked(),False);await page.locator('#closeModal').click()
   await scenario('subscription form switches renewal default while allowing manual override',admin_mode)
   async def admin_new_history():
    await page.locator('#addSubscriptionBtn').click();await page.locator('#name').fill('History via browser');await page.locator('#customType').fill('充值');await page.locator('#amount').fill('18.5');await page.locator('#subscriptionForm button[type=submit]').click();await page.wait_for_function("document.getElementById('subscriptionModal').classList.contains('hidden')");h=api('/api/subscription-history?q=History%20via%20browser');eq(h['total'],1);eq(any(s['name']=='History via browser'for s in api('/api/subscriptions')),False)
   await scenario('actual subscription Add form routes non-membership only to history',admin_new_history)
   async def table_mode_defaults():
    await open_page('/admin',{'subscriptionViewModeV2':'table'});await page.wait_for_selector('#subscriptionsExcelBody tr')
    cell=page.locator('#subscriptionsExcelBody tr[data-subscription-id="row-a"] td[data-col="subscriptionMode"]');await cell.dblclick();editor=cell.locator('select');values=await editor.locator('option').evaluate_all('(es)=>es.map(e=>({v:e.value,t:e.textContent}))');cycle=next(x['v']for x in values if x['v']=='cycle' or '循环'in x['t']);await editor.select_option(cycle);await page.locator('#saveTableEditsBtn').click();await page.wait_for_function("!document.getElementById('saveTableEditsBtn').innerText.includes('保存中')");row=next(x for x in api('/api/subscriptions')if x['id']=='row-a');eq(row['subscriptionMode'],'cycle');eq(row['autoRenew'],True)
    await cell.dblclick();editor=cell.locator('select');values=await editor.locator('option').evaluate_all('(es)=>es.map(e=>({v:e.value,t:e.textContent}))');reset=next(x['v']for x in values if x['v']=='reset' or '重置'in x['t']);await editor.select_option(reset);await page.locator('#saveTableEditsBtn').click();await page.wait_for_function("!document.getElementById('saveTableEditsBtn').innerText.includes('保存中')");row=next(x for x in api('/api/subscriptions')if x['id']=='row-a');eq(row['subscriptionMode'],'reset');eq(row['autoRenew'],False)
   await scenario('subscription table mode change stages and persists auto-renew default',table_mode_defaults)
   async def dashboard_order():
    await open_page('/admin/dashboard');await page.wait_for_function("!document.getElementById('expenseByName').innerText.includes('加载中')");eq(await page.evaluate("()=>{const a=document.getElementById('statsGrid'),b=document.getElementById('expenseByType'),c=document.getElementById('expenseByName'),d=document.getElementById('recentPayments');return !!(a.compareDocumentPosition(b)&4)&&!!(a.compareDocumentPosition(c)&4)&&!!(b.compareDocumentPosition(d)&4)&&!!(c.compareDocumentPosition(d)&4)}"),True);eq('按订阅名称支出统计'in await page.locator('body').inner_text(),True);await page.screenshot(path=str(OUT/'dashboard.png'),full_page=True)
   await scenario('dashboard type/name spending appears after overview and before recent payments',dashboard_order)
   async def history_page():
    await open_page('/admin/history');await page.wait_for_selector('#historyTable tbody tr');eq('History via browser'in await page.locator('#historyTable').inner_text(),True);await page.locator('#historyTable button[data-detail]').first.click();eq(await page.locator('#historyDetail').is_visible(),True);eq('snapshot'in await page.locator('#historyDetailText').inner_text(),True);await page.locator('#historyDetailClose').click()
   await scenario('separate history page loads ledger and shows immutable snapshot',history_page)
   async def home_redirect():
    text=(ROOT/'src/views/loginPage.html').read_text();eq("window.location.href = '/admin';"in text,True);eq("'/admin/dashboard'"in text,False)
   await scenario('login success routes admin/superadmin to subscription records',home_redirect)
   await browser.close()
 finally:
  proc.terminate();proc.wait(5);(OUT/'results.json').write_text(json.dumps(RESULTS,ensure_ascii=False,indent=2));print('TOTAL',len(RESULTS),'PASS',sum(x['passed']for x in RESULTS),'FAIL',sum(not x['passed']for x in RESULTS),flush=True)
asyncio.run(main())

sys.exit(1 if any(not x["passed"] for x in RESULTS) else 0)
