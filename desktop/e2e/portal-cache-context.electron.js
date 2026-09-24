'use strict';
const { app, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MyPortalDataRuntime } = require('../lib/browser/session/browser-session-manager');
const { registerBrowserDataIpc } = require('../lib/ipc/browser-data-ipc');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hkustgz-portal-context-'));
app.setPath('userData',root);
let deadline;
async function run() {
  await app.whenReady();
  const portal='https://portal.example.invalid/';
  for (const id of ['persist:portal-a','persist:portal-b']) {
    const isolated=session.fromPartition(id);
    isolated.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,reply)=>reply({cancel:true}));
    await isolated.cookies.set({url:portal,name:'fixture_session',value:`synthetic-${id.at(-1)}`});
  }
  let partition='persist:portal-a', finish, began, reads=0;
  const pause=new Promise(resolve=>{finish=resolve;}), started=new Promise(resolve=>{began=resolve;});
  const runtime=new MyPortalDataRuntime({electronSession:session,getPartition:()=>partition,
    getPortalUrl:()=>portal,getSessionUrlHint:()=>`${portal}?tt=synthetic-routing-hint`,
    getSources:()=>({schedule:{read:async context=>{
      const index=++reads; began();
      const cookies=await context.session.cookies.get({url:portal,name:'fixture_session'});
      if(index===1)await pause;
      const now=Date.now(), owner=cookies[0]?.value.endsWith('-b')?'B':'A';
      return {state:cookies.length?'ready':'empty',source:'synthetic',fetchedAt:now,stale:false,
        items:cookies.length?[{id:owner,title:`Owner ${owner}`,startsAt:now,endsAt:now+3600000}]:[]};
    }}}),
  });
  const old=runtime.snapshot().then(value=>({value}),error=>({error}));
  await started; partition='persist:portal-b';
  const fresh=await runtime.snapshot(); finish();
  assert.equal((await old).error?.code,'PORTAL_CONTEXT_CHANGED');
  assert.equal(fresh.modules.schedule.items[0].title,'Owner B');
  assert.doesNotMatch(JSON.stringify(fresh),/synthetic-routing-hint|synthetic-a|persist:portal-a/u);
  const handlers=new Map();
  registerBrowserDataIpc({register:(name,handler)=>handlers.set(name,handler),translate:key=>key,campusData:runtime,
    clearSiteData:async()=>{await session.fromPartition(partition).clearStorageData({storages:['cookies']});return true;},
  });
  assert.deepEqual(await handlers.get('clear-browser-data')({}),{ok:true});
  assert.equal(runtime.cached,null);
  const cleared=await runtime.snapshot();
  assert.equal(cleared.modules.schedule.state,'empty'); assert.equal(reads,3);
  console.log('portal cache context: PASS (isolated Electron Sessions, late response, clear-data IPC; no external requests)');
}
Promise.race([run(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('portal context fixture timed out')),15000);})])
  .then(()=>0).catch(error=>{console.error(error);return 1;}).then(code=>{
    // Chromium keeps its Session files open until this process exits on Windows.
    // Let the external runner retire this isolated synthetic profile afterwards;
    // deleting it here can throw EPERM and turn a passing test into a hung child.
    clearTimeout(deadline); app.exit(code);
  });
