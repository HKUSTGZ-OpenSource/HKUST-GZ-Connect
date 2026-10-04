'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { BrowserOpenOwner } = require('../../../../lib/browser/session/browser-session-manager');
function deferred() { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
function fixture() {
  const calls = [], state = { current: true, window: null, tabs: [], port: null, suspended: false };
  const options = { blankUrl: 'about:blank', normalizeUrl: value => value || 'about:blank',
    resolveRoute: () => ({route:'direct'}), ensureRoutingReady: async () => true,
    showReadyWindow: async () => { calls.push('show'); state.window ||= {isDestroyed:()=>false}; },
    getWindow: () => state.window, isContextCurrent: () => state.current,
    getPort: () => state.port, isRoutingSuspended: () => state.suspended,
    configure: async port => {calls.push(['configure',port]);state.port=port;},
    getTabs: () => state.tabs, switchTab: id => calls.push(['switch',id]),
    sendWorkspaceState: tab => calls.push(['workspace-state',tab.id]),
    createTab: (...args) => calls.push(['tab',...args]), createWorkspaceTab: () => calls.push('workspace'),
    translate: key=>key, prepareOpen:()=>{}, onRetired:()=>calls.push('retired') };
  return {calls,state,options,owner:new BrowserOpenOwner(options)};
}
test('current page opens preserve route/options and local-home paths', async () => {
  const f=fixture();assert.equal(await f.owner.open('https://example.invalid/',6180,'direct',{displayName:'Synthetic'}),'https://example.invalid/');
  assert.deepEqual(f.calls,['show',['tab','https://example.invalid/','direct',{displayName:'Synthetic'}]]);
  f.calls.length=0; await f.owner.open('',6180);
  assert.deepEqual(f.calls,['show',['tab','about:blank','direct']]);
  f.calls.length=0; await f.owner.openWorkspace(6180);
  assert.deepEqual(f.calls,[['configure',6180],'show','workspace']);
});
test('existing workspace is reused with switch-before-state and no duplicate tab', async()=>{
  const f=fixture();f.state.tabs=[{id:7,kind:'workspace'}];f.state.port=6180;
  await f.owner.openWorkspace(6180); assert.deepEqual(f.calls,['show',['switch',7],['workspace-state',7]]);
});
test('retired readiness/configuration/show outcomes cannot create or present',async()=>{
  for(const step of ['readiness','configure','show']) for(const reject of [false,true]){
    const f=fixture(), waiting=deferred();
    if(step==='readiness')f.owner.ensureRoutingReady=()=>waiting.promise;
    if(step==='configure')f.owner.configure=()=>waiting.promise;
    if(step==='show')f.owner.showReadyWindow=()=>waiting.promise;
    const pending=step==='configure'?f.owner.openWorkspace(6180):f.owner.open('https://example.invalid/',6180);
    const result=pending.then(value=>({value}),error=>({error}));await new Promise(setImmediate);f.owner.reset();
    if(reject)waiting.reject(new Error('synthetic retired effect'));else waiting.resolve(true);
    assert.equal((await result).error.code,'BROWSER_OPEN_RETIRED');assert.deepEqual(f.calls,['retired']);
  }
});
test('context retirement is fail closed before effects and after readiness',async()=>{
  const f=fixture();f.state.current=false;
  await assert.rejects(f.owner.open('https://example.invalid/',6180),{code:'BROWSER_OPEN_RETIRED'});assert.deepEqual(f.calls,[]);
  const g=fixture(),waiting=deferred();g.owner.ensureRoutingReady=()=>waiting.promise;
  const pending=g.owner.open('https://example.invalid/',6180);g.state.current=false;waiting.resolve(true);
  await assert.rejects(pending,{code:'BROWSER_OPEN_RETIRED'});assert.deepEqual(g.calls,[]);
});
test('current failures preserve identity; readiness failure uses the existing timeout message',async()=>{
  const f=fixture(),failure=new Error('synthetic load failure');f.owner.showReadyWindow=async()=>{throw failure;};
  await assert.rejects(f.owner.open('https://example.invalid/',6180),error=>error===failure);
  const g=fixture();g.owner.ensureRoutingReady=async()=>false;
  await assert.rejects(g.owner.open('https://example.invalid/',6180),/error.connectTimeout/);
});
test('automatic load failure preserves its original cause only without a newer lifetime',async()=>{
  const f=fixture(),failure=new Error('synthetic shared load failure');
  f.owner.showReadyWindow=async()=>{f.owner.reset(failure);throw failure;};
  await assert.rejects(f.owner.openWorkspace(6180),error=>error===failure);
  assert.equal(f.calls.includes('retired'),false,'automatic failure is not a user-retirement notification');
  const g=fixture();g.owner.showReadyWindow=async()=>{g.owner.reset(failure);g.owner.reset();throw failure;};
  await assert.rejects(g.owner.openWorkspace(6180),{code:'BROWSER_OPEN_RETIRED'});
  const h=fixture();h.owner.showReadyWindow=async()=>{h.owner.reset(failure);h.state.window={isDestroyed:()=>false};throw failure;};
  await assert.rejects(h.owner.openWorkspace(6180),{code:'BROWSER_OPEN_RETIRED'});
});
test('unobserved destroyed window is prepared before a new explicit epoch is admitted',async()=>{
  const f=fixture();f.owner.prepareOpen=()=>f.owner.reset();
  await f.owner.openWorkspace(6180);assert.ok(f.calls.includes('workspace'));
});
test('reentrant workspace selection cannot publish after retirement',async()=>{
  const f=fixture();f.state.tabs=[{id:1,kind:'workspace'}];f.state.port=6180;
  f.owner.switchTab=()=>f.owner.reset();
  await assert.rejects(f.owner.openWorkspace(6180),{code:'BROWSER_OPEN_RETIRED'});
  assert.equal(f.calls.some(x=>Array.isArray(x)&&x[0]==='workspace-state'),false);
});
test('invalid ports/dependencies reject and suspended workspace does not reactivate Session',async()=>{
  const f=fixture();for(const port of [0,65536,'6180'])await assert.rejects(f.owner.openWorkspace(port),/port is invalid/);
  assert.deepEqual(f.calls,[]);assert.throws(()=>new BrowserOpenOwner({...f.options,prepareOpen:null}),/dependencies/);
  f.state.suspended=true;await f.owner.openWorkspace(6180);assert.deepEqual(f.calls,['show','workspace']);
});
test('open owner remains below the M2 per-owner ceiling',()=>{
  const source=fs.readFileSync(require.resolve('../../../../lib/browser/session/browser-session-manager'),'utf8');
  const start=source.indexOf('class BrowserOpenOwner'),end=source.indexOf('\n// A route command',start);
  assert.ok(start>=0&&end>start);assert.ok(source.slice(start,end).split('\n').length<=600);
});
