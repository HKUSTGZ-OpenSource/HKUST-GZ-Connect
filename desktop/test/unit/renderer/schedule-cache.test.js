'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../../../renderer/features/campus-data/index.mjs');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const value = (state='ready') => ({sessionState:'authenticated',modules:{schedule:{state,source:'myportal-calendar',fetchedAt:Date.now(),items:state==='ready'?[{title:'Fixture',startsAt:Date.now(),endsAt:Date.now()+3600000}]:[]}}});
function harness() {
  const shell={dataset:{}};
  const handlers={}; shell.addEventListener=()=>{};
  const body={innerHTML:'',clientWidth:400,closest:()=>shell,querySelector:()=>null,querySelectorAll:()=>[],
    addEventListener:(name, handler)=>{handlers[name]=handler;}};
  const button={}; let calls=0; let pending; let general;
  button.addEventListener=()=>{};
  const feature=create({document:{documentElement:{lang:'en'},addEventListener:()=>{},getElementById:id=>id==='scheduleBody'?body:id==='scheduleRefresh'?button:null},
    api:{getCampusData:async()=>general?general.promise:value(),refreshCampusData:async()=>general?general.promise:value(),refreshCampusSchedule:async()=>value(),getCampusScheduleWeek:()=>{calls++;return pending.promise;}},
    translate:(key)=>key,escapeHtml:String,openDeepLink:()=>{}});
  return {feature,body,button,calls:()=>calls,defer:()=>pending=deferred(),deferLoad:()=>general=deferred(),
    choose:date=>handlers.change({target:{id:'scheduleDate',value:date,validity:{valid:true}}})};
}
test('an uncached week keeps seven-day geometry without inventing events or an empty result', async () => {
  const h=harness(); try {
    h.feature.start(); await h.feature.load(); const d=h.defer();
    h.choose('2030-05-17'); await Promise.resolve();
    assert.match(h.body.innerHTML,/role="grid"/);
    assert.equal((h.body.innerHTML.match(/role="columnheader"/g)||[]).length,8);
    assert.match(h.body.innerHTML,/aria-busy="true"/);
    assert.match(h.body.innerHTML,/value="2030-05-17"/);
    assert.doesNotMatch(h.body.innerHTML,/portalLoadingHint|scheduleWeekEmpty|data-schedule-index/);
    d.resolve(value('empty')); await new Promise(resolve=>setImmediate(resolve));
    assert.doesNotMatch(h.body.innerHTML,/aria-busy="true"/);
    assert.match(h.body.innerHTML,/scheduleWeekEmpty/);
  } finally {h.feature.clearDisplay();}
});
test('refresh preserves last-good timetable and failed refresh does not erase it', async () => {
  const h=harness(); try {
    await h.feature.load(); const html=h.body.innerHTML; const d=h.defer();
    const work=h.feature.refreshSchedule();
    assert.equal(h.body.innerHTML,html); assert.equal(h.button.disabled,true);
    d.reject(new Error('offline')); await work;
    assert.equal(h.feature.snapshot().modules.schedule.state,'ready');
    assert.match(h.body.innerHTML,/scheduleRefreshFailed/);
    assert.equal(h.button.disabled,false);
  } finally {h.feature.clearDisplay?.();}
});
test('fresh cached week skips school request; forced refresh still requests', async () => {
  const h=harness();try {
    await h.feature.load();await h.feature.refreshSchedule(false);assert.equal(h.calls(),0);
    const d=h.defer();const work=h.feature.refreshSchedule(true);await Promise.resolve();assert.equal(h.calls(),1);
    d.resolve(value('empty'));await work;assert.equal(h.feature.snapshot().modules.schedule.state,'empty');
  } finally {h.feature.clearDisplay?.();}
});
test('clear revokes pending publication and cached personal data', async () => {
  const h=harness();try {
    await h.feature.load();const d=h.defer();const work=h.feature.refreshSchedule();await Promise.resolve();
    h.feature.clearDisplay(true);d.resolve(value());await work;
    assert.equal(h.feature.snapshot(),null);assert.doesNotMatch(h.body.innerHTML,/Fixture/);
  } finally {h.feature.clearDisplay?.();}
});
test('explicit login expiry discards the cached schedule instead of disguising it as offline', async () => {
  const h=harness();try {
    await h.feature.load();const d=h.defer();const work=h.feature.refreshSchedule();
    d.resolve(value('session-expired'));await work;
    assert.equal(h.feature.snapshot().modules.schedule.state,'session-expired');
    const next=h.defer();const retry=h.feature.refreshSchedule(false);await Promise.resolve();
    assert.equal(h.calls(),2);next.resolve(value());await retry;
  } finally {h.feature.clearDisplay();}
});

test('late revocation for an earlier week clears the active cache and fences later success', async () => {
  const h=harness(); try {
    h.feature.start(); await h.feature.load();
    const earlier=h.defer(); h.choose('2030-05-17'); await Promise.resolve();
    const later=h.defer(); h.choose('2030-05-24'); await Promise.resolve();
    earlier.resolve(value('session-expired')); await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.feature.snapshot().modules.schedule.state,'session-expired');
    assert.equal(h.button.disabled,false);
    later.resolve(value()); await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.feature.snapshot().modules.schedule.state,'session-expired');
  } finally {h.feature.clearDisplay();}
});

test('revocation from a cleared display context cannot invalidate the new context', async () => {
  const h=harness(); try {
    h.feature.start(); await h.feature.load();
    const old=h.defer(); h.choose('2030-05-17'); await Promise.resolve();
    h.feature.clearDisplay(); const current=h.defer();
    const load=h.feature.load(); await load; await Promise.resolve();
    old.resolve(value('session-expired')); await new Promise(resolve=>setImmediate(resolve));
    assert.notEqual(h.feature.snapshot().modules.schedule.state,'session-expired');
    current.resolve(value('empty')); await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.feature.snapshot().modules.schedule.state,'empty');
  } finally {h.feature.clearDisplay();}
});

test('a generic load already in flight cannot restore a revoked timetable', async () => {
  const h=harness(); try {
    await h.feature.load();
    const denial=h.defer(); const week=h.feature.refreshSchedule(); await Promise.resolve();
    const general=h.deferLoad(); const full=h.feature.load(false);
    denial.resolve(value('session-expired')); await week;
    general.resolve(value()); await full;
    assert.equal(h.feature.snapshot().modules.schedule.state,'session-expired');
    assert.equal(h.button.disabled,false);
  } finally {h.feature.clearDisplay();}
});

test('revocation cancels scheduled automatic refresh until a new authorized load', async () => {
  const savedSet=globalThis.setTimeout, savedClear=globalThis.clearTimeout;
  const timers=new Set();
  globalThis.setTimeout=()=>{const timer={unref(){}};timers.add(timer);return timer;};
  globalThis.clearTimeout=timer=>{timers.delete(timer);};
  const h=harness(); try {
    await h.feature.load(); assert.equal(timers.size,1);
    const d=h.defer(); const work=h.feature.refreshSchedule();
    d.resolve(value('session-expired')); await work;
    assert.equal(timers.size,0);
    await h.feature.load(); assert.equal(timers.size,1);
  } finally {h.feature.clearDisplay();globalThis.setTimeout=savedSet;globalThis.clearTimeout=savedClear;}
});

test('explicit full revalidation fences older week success and denial', async () => {
  for(const state of ['ready','session-expired']) {
    const h=harness(); try {
      await h.feature.load();
      const prior=h.defer(); const week=h.feature.refreshSchedule(); await Promise.resolve();
      const general=h.deferLoad(); const full=h.feature.load(true);
      general.resolve(value('empty')); await full;
      prior.resolve(value(state)); await week;
      assert.equal(h.feature.snapshot().modules.schedule.state,'empty');
      assert.equal(h.button.disabled,false);
    } finally {h.feature.clearDisplay();}
  }
});

test('a full-load denial still replaces visible personal data after advancing its authorization epoch',async()=>{
  const h=harness();try {
    await h.feature.load();const general=h.deferLoad();const work=h.feature.load(true);
    general.resolve(value('session-expired'));await work;
    assert.equal(h.feature.snapshot().modules.schedule.state,'session-expired');
    assert.match(h.body.innerHTML,/workspace.portalExpired/);
    assert.doesNotMatch(h.body.innerHTML,/data-schedule-index/);
  } finally {h.feature.clearDisplay();}
});
