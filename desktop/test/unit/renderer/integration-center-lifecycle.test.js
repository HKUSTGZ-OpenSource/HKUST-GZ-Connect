'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createIntegrationCenter, create } = require('../../../renderer/features/integration-center/index.mjs');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
const handle = letter => 'export-'+letter.repeat(32);
const result = (letter='a') => ({ok:true,preview:{schemaVersion:1,confirmationHandle:handle(letter),
  adapterId:'clash_mihomo_yaml',action:'copy',expiresAt:2000,containsLocalProxyCredential:true}});
function fixture({host=false,start=true}={}) {
  const nodes=new Map(),calls=[],timers=new Map();let timerId=0;
  function node() {return {children:[],listeners:new Map(),textContent:'',dataset:{},open:false,disabled:false,
    append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},
    addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);},
    removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);},
    showModal(){this.open=true;},close(){this.open=false;},
  };}
  const document={...node(),documentElement:{lang:'zh'},getElementById:id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node};
  const api={listIntegrations:async()=>({ok:true,integrations:[]}),prepareIntegration:async()=>result(),
    confirmIntegration:async()=>({ok:true}),cancelIntegration:async request=>{calls.push(request);return {ok:true};}};
  const owner=(host?create:createIntegrationCenter)({api,document,i18n:{createT:locale=>key=>locale+':'+key},translate:key=>key,now:()=>1000,
    setTimeoutFn:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeoutFn:id=>timers.delete(id)});
  if(start) owner.start();
  const snapshot=()=>JSON.stringify([...nodes].map(([id,n])=>[id,n.open,n.textContent,n.disabled,n.children]));
  return {owner,api,calls,timers,nodes,document,snapshot,prepare:()=>owner.prepare('clash_mihomo_yaml','copy')};
}

test('retired preparation cannot resurrect a modal and cancels only its own late handle',async()=>{
  const f=fixture(),gate=deferred();f.api.prepareIntegration=()=>gate.promise;
  const work=f.prepare();assert.equal(f.owner.dispose(),true);const before=f.snapshot();
  gate.resolve(result());await work;
  assert.equal(f.snapshot(),before);assert.deepEqual(f.calls,[{confirmationHandle:handle('a')}]);
  assert.equal(f.timers.size,0);assert.equal(f.owner.start(),false);assert.equal(f.owner.dispose(),false);
});

test('disposal before startup is terminal for both controller and host owner',()=>{
  for(const host of [false,true]) {const f=fixture({host,start:false});
    assert.equal(f.owner.dispose(),true);assert.equal(f.owner.start(),false);assert.equal(f.owner.dispose(),false);}
});
test('expiry revokes an accepted confirmation and a late result cannot publish success',async()=>{
  const f=fixture(),gate=deferred();await f.prepare();f.api.confirmIntegration=()=>gate.promise;
  const work=f.owner.confirm();[...f.timers.values()][0]();const before=f.snapshot();
  gate.resolve({ok:true});await work;assert.equal(f.snapshot(),before);
  assert.deepEqual(f.calls,[{confirmationHandle:handle('a')}]);assert.equal(f.nodes.get('integrationDialog').open,false);
});
test('modal-open failure discards its handle and leaves the next action usable',async()=>{
  const f=fixture();f.nodes.get('integrationDialog').showModal=()=>{throw new Error('synthetic modal failure');};
  await f.prepare();assert.deepEqual(f.calls,[{confirmationHandle:handle('a')}]);assert.equal(f.timers.size,0);
  f.nodes.get('integrationDialog').showModal=function(){this.open=true;};await f.prepare();
  assert.equal(f.nodes.get('integrationDialog').open,true);
});
test('host owns locale and state subscriptions and retires profile-bound previews',async()=>{
  const f=fixture({host:true});
  const emit=(name,detail)=>{for(const fn of f.document.listeners.get(name)||[])fn({detail});};
  f.owner.start();assert.equal(f.document.listeners.get('app-state-refreshed').size,1);
  emit('app-state-refreshed',{loggedIn:true,schoolProfile:{profileId:'one'}});await f.prepare();
  f.document.documentElement.lang='en';emit('app-locale-changed');
  assert.equal(f.nodes.get('integrationPreviewName').textContent,'en:integration.adapter.clash_mihomo_yaml');
  emit('app-state-refreshed',{loggedIn:true,schoolProfile:{profileId:'two'}});await Promise.resolve();
  assert.equal(f.nodes.get('integrationDialog').open,false);assert.deepEqual(f.calls,[{confirmationHandle:handle('a')}]);
  f.owner.dispose();const before=f.snapshot();emit('app-state-refreshed',{loggedIn:true});emit('app-locale-changed');
  assert.equal(f.snapshot(),before);assert.ok([...f.document.listeners.values()].every(set=>set.size===0));
});
test('late cancellation response cannot close a replacement modal',async()=>{
  const f=fixture(),gate=deferred();await f.prepare();
  f.api.cancelIntegration=request=>{f.calls.push(request);return gate.promise;};
  const cancelled=f.owner.cancel();f.api.prepareIntegration=async()=>result('b');await f.prepare();
  const before=f.snapshot();gate.resolve({ok:true});await cancelled;
  assert.equal(f.snapshot(),before);assert.equal(f.nodes.get('integrationDialog').open,true);
  assert.deepEqual(f.calls,[{confirmationHandle:handle('a')}]);
});
test('older preparation response cannot replace a new preview after local cancellation',async()=>{
  const f=fixture(),gate=deferred();f.api.prepareIntegration=()=>gate.promise;const old=f.prepare();
  await f.owner.cancel();f.api.prepareIntegration=async()=>result('b');await f.prepare();
  const before=f.snapshot();gate.resolve(result());await old;assert.equal(f.snapshot(),before);
  assert.deepEqual(f.calls,[{confirmationHandle:handle('a')}]);
});
test('retired confirmation cannot publish success or initiate another refresh',async()=>{
  const f=fixture(),gate=deferred();await f.prepare();let reads=0;
  f.api.confirmIntegration=()=>gate.promise;f.api.listIntegrations=async()=>{reads++;return {ok:true,integrations:[]};};
  const work=f.owner.confirm();f.owner.dispose();const before=f.snapshot();gate.resolve({ok:true});await work;
  assert.equal(f.snapshot(),before);assert.equal(reads,0);assert.deepEqual(f.calls,[{confirmationHandle:handle('a')}]);
});
test('out-of-order refresh and a rejected refresh remain bounded to the live request',async()=>{
  const f=fixture(),first=deferred(),second=deferred();let count=0;
  f.api.listIntegrations=()=>++count===1?first.promise:second.promise;
  const old=f.owner.refresh(),next=f.owner.refresh();second.resolve({ok:true,integrations:[]});await next;
  const before=f.snapshot();first.resolve({ok:false,code:'INTEGRATION_PROFILE_STALE'});await old;
  assert.equal(f.snapshot(),before);f.api.listIntegrations=async()=>{throw new Error('synthetic');};
  assert.equal(await f.owner.refresh(),false);
});
test('dispose removes listeners, timers and metadata; captured expiry cannot cancel a new owner',async()=>{
  const f=fixture();await f.prepare();const expiry=[...f.timers.values()][0];
  f.owner.dispose();const before=f.snapshot();expiry();await Promise.resolve();
  assert.equal(f.snapshot(),before);assert.equal(f.timers.size,0);
  assert.equal([...f.nodes.values()].flatMap(n=>[...n.listeners.values()]).every(set=>set.size===0),true);
  assert.deepEqual(f.calls,[{confirmationHandle:handle('a')}]);
  assert.equal(f.nodes.get('integrationPreviewName').textContent,'');
});
test('expired or malformed preview is discarded only with a validated owned handle',async()=>{
  const f=fixture();f.api.prepareIntegration=async()=>({ok:true,preview:{...result().preview,expiresAt:900}});
  await f.prepare();assert.deepEqual(f.calls,[{confirmationHandle:handle('a')}]);
  f.api.prepareIntegration=async()=>({ok:true,preview:{confirmationHandle:'invalid'}});await f.prepare();
  assert.equal(f.calls.length,1);assert.equal(f.nodes.get('integrationDialog').open,false);
});
test('repeated start binds once and disposed public actions produce no work',async()=>{
  const f=fixture();const count=()=>[...f.nodes.values()].flatMap(n=>[...n.listeners.values()]).reduce((n,s)=>n+s.size,0);
  const before=count();assert.equal(f.owner.start(),true);assert.equal(count(),before);f.owner.dispose();
  f.api.prepareIntegration=()=>{throw new Error('retired prepare');};f.api.listIntegrations=()=>{throw new Error('retired read');};
  const retired=f.snapshot();await f.prepare();await f.owner.confirm();await f.owner.cancel();await f.owner.refresh();
  f.owner.setTranslator(()=>{throw new Error('retired translation');});assert.equal(f.snapshot(),retired);
});
