'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {create}=require('../../../renderer/features/campus-data/index.mjs');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
class Target {
  constructor(){this.listeners=new Map();this.innerHTML='';this.dataset={};this.clientWidth=400;}
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
  removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
  emit(type,event={}){for(const fn of [...(this.listeners.get(type)||[])])fn(event);}
  count(){return [...this.listeners.values()].reduce((n,set)=>n+set.size,0);}
  closest(){return this.shell;}
  querySelector(){return null;}
  querySelectorAll(){return [];}
}
const value=()=>({sessionState:'authenticated',checkedAt:Date.now(),catalog:{state:'ready'},modules:{
  schedule:{state:'ready',source:'myportal-calendar',fetchedAt:Date.now(),items:[{
    id:'fixture',title:'Synthetic personal event',startsAt:Date.now(),endsAt:Date.now()+3600000,
  }]},
}});
function harness(){
  const nodes=new Map(),doc=new Target(),win=new Target(),observers=[],published=[],calls=[],hooks={};
  for(const id of ['scheduleBody','loansBody','newsBody','scheduleRefresh','scheduleDetail'])nodes.set(id,new Target());
  for(const id of ['scheduleBody','loansBody','newsBody'])nodes.get(id).shell=new Target();
  Object.assign(nodes.get('scheduleDetail'),{open:true,close(){this.open=false;}});
  win.ResizeObserver=class {constructor(callback){this.callback=callback;this.disconnections=0;observers.push(this);}observe(){}disconnect(){this.disconnections++;}};
  doc.documentElement={lang:'en'};doc.defaultView=win;doc.getElementById=id=>nodes.get(id)||null;
  const load=deferred(),week=deferred();
  const feature=create({document:doc,api:{
    getCampusData:()=>{calls.push('load');return load.promise;},refreshCampusData:()=>{calls.push('full');return load.promise;},
    refreshCampusSchedule:()=>{calls.push('refresh');return week.promise;},getCampusScheduleWeek:()=>{calls.push('week');return week.promise;},
  },translate:key=>key,escapeHtml:String,openDeepLink:()=>calls.push('open'),onCatalog:item=>{published.push(item);hooks.onCatalog?.();}});
  const targets=[doc,win,...nodes.values(),...['scheduleBody','loansBody','newsBody'].map(id=>nodes.get(id).shell)];
  return {feature,load,week,nodes,doc,win,observers,published,calls,hooks,listenerCount:()=>targets.reduce((n,t)=>n+t.count(),0)};
}

test('campus-data start is idempotent and disposal removes only owned listeners',()=>{
  const h=harness();const external=()=>{};h.doc.addEventListener('app-locale-changed',external);
  assert.equal(h.feature.start(),true);const count=h.listenerCount();
  assert.equal(h.feature.start(),false);assert.equal(h.listenerCount(),count);assert.equal(h.observers.length,1);
  assert.equal(h.feature.dispose(),true);assert.equal(h.feature.dispose(),false);assert.equal(h.feature.start(),false);
  assert.equal(h.listenerCount(),1);assert.equal(h.observers[0].disconnections,1);
  assert.equal(h.nodes.get('scheduleDetail').open,false);
});

test('pagehide retires pending loads and queued observer or DOM callbacks',async()=>{
  const h=harness();h.feature.start();const queued=[...h.nodes.get('scheduleRefresh').listeners.get('click')][0];
  const pending=h.feature.load();h.win.emit('pagehide');
  h.load.resolve(value());await pending;
  assert.equal(h.feature.snapshot(),null);assert.deepEqual(h.published,[]);
  const html=h.nodes.get('scheduleBody').innerHTML;
  queued();h.observers[0].callback([{contentRect:{width:900}}]);h.doc.emit('app-locale-changed');
  await h.feature.ensureLoaded();await h.feature.refreshSchedule();await h.feature.load(true);h.feature.render();h.feature.clearDisplay();
  assert.deepEqual(h.calls,['load']);assert.equal(h.nodes.get('scheduleBody').innerHTML,html);assert.equal(h.listenerCount(),0);
});

test('disposal clears cached data and prevents a late week result restoring it',async()=>{
  const h=harness();h.feature.start();h.load.resolve(value());await h.feature.load();
  const pending=h.feature.refreshSchedule();await Promise.resolve();
  h.feature.dispose();h.week.resolve(value());await pending;
  assert.equal(h.feature.snapshot(),null);assert.equal(h.nodes.get('scheduleBody').innerHTML,'');
  assert.equal(h.nodes.get('scheduleDetail').innerHTML,'');
  assert.equal(h.published.length,1);assert.equal(h.listenerCount(),0);
});

test('partial startup failure releases bindings and cannot be restarted',()=>{
  const h=harness();h.doc.addEventListener=()=>{throw new Error('synthetic binding failure');};
  assert.throws(()=>h.feature.start(),/synthetic binding failure/);
  assert.equal(h.listenerCount(),0);assert.equal(h.feature.start(),false);
  assert.equal(h.feature.snapshot(),null);
});

test('cleanup reports failure but continues retiring other resources',()=>{
  const h=harness();h.feature.start();
  h.observers[0].disconnect=()=>{throw new Error('synthetic observer cleanup');};
  assert.throws(()=>h.feature.dispose(),error=>error instanceof AggregateError && error.errors[0].message==='synthetic observer cleanup');
  assert.equal(h.listenerCount(),0);assert.equal(h.feature.snapshot(),null);
  assert.equal(h.nodes.get('scheduleBody').innerHTML,'');
  assert.equal(h.feature.dispose(),false);
});

test('dispose cancels automatic refresh and makes an already queued timer inert',async()=>{
  const savedSet=globalThis.setTimeout,savedClear=globalThis.clearTimeout,timers=new Set();
  let callback;
  globalThis.setTimeout=fn=>{callback=fn;const timer={unref(){}};timers.add(timer);return timer;};
  globalThis.clearTimeout=timer=>timers.delete(timer);
  const h=harness();try {
    h.feature.start();h.load.resolve(value());await h.feature.load();assert.equal(timers.size,1);
    h.feature.dispose();assert.equal(timers.size,0);callback();await Promise.resolve();
    assert.deepEqual(h.calls,['load']);assert.equal(h.feature.snapshot(),null);
  } finally {h.feature.dispose();globalThis.setTimeout=savedSet;globalThis.clearTimeout=savedClear;}
});

test('dialog close failure does not retain personal detail markup or skip other cleanup',()=>{
  const h=harness();h.feature.start();
  const dialog=h.nodes.get('scheduleDetail');
  dialog.innerHTML='Synthetic private event detail';
  dialog.close=()=>{throw new Error('synthetic dialog close failure');};
  assert.throws(()=>h.feature.dispose(),error=>error instanceof AggregateError &&
    error.errors.some(cause=>cause.message==='synthetic dialog close failure'));
  assert.equal(dialog.innerHTML,'');
  assert.equal(h.listenerCount(),0);
  assert.equal(h.observers[0].disconnections,1);
  assert.equal(h.feature.snapshot(),null);
  assert.equal(h.feature.dispose(),false);
});

test('catalog publication can retire the owner without retaining or returning its data afterwards',async()=>{
  const h=harness(),reply=value(),modules=reply.modules;let retired=false,readsAfterRetirement=0;
  Object.defineProperty(reply,'modules',{get(){if(retired)readsAfterRetirement++;return modules;}});
  h.hooks.onCatalog=()=>{h.feature.dispose();retired=true;};
  h.feature.start();h.load.resolve(reply);const result=await h.feature.load();
  assert.equal(result,null);assert.equal(readsAfterRetirement,0);
  assert.equal(h.feature.snapshot(),null);assert.equal(h.listenerCount(),0);
});

test('account display clearing retires every surface and pending result even when dialog close fails',async()=>{
  const h=harness();h.feature.start();h.load.resolve(value());await h.feature.load();
  const pending=h.feature.refreshSchedule();await Promise.resolve();
  const dialog=h.nodes.get('scheduleDetail');
  for(const id of ['scheduleBody','loansBody','newsBody','scheduleDetail']) {
    h.nodes.get(id).innerHTML='Synthetic prior account content';
  }
  dialog.close=()=>{throw new Error('synthetic clear dialog failure');};
  try {
    assert.throws(()=>h.feature.clearDisplay(true),error=>error instanceof AggregateError &&
      error.errors.some(cause=>cause.message==='synthetic clear dialog failure'));
    assert.equal(h.feature.snapshot(),null);
    assert.equal(dialog.innerHTML,'');
    for(const id of ['scheduleBody','loansBody','newsBody']) {
      assert.doesNotMatch(h.nodes.get(id).innerHTML,/Synthetic prior account content/);
    }
    assert.equal(h.published.at(-1),null);
    assert.equal(h.nodes.get('scheduleRefresh').disabled,true);
    h.week.resolve(value());await pending;
    assert.equal(h.feature.snapshot(),null);
    assert.equal(await h.feature.ensureLoaded(),null);
  } finally {dialog.close=()=>{dialog.open=false;};h.feature.dispose();}
});
