'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { MyPortalDataRuntime } = require('../../../lib/browser/session/browser-session-manager');

function deferred() { let resolve; const promise=new Promise(done=>{resolve=done;}); return {promise,resolve}; }
function observe(promise) { return promise.then(value=>({value}),error=>({error})); }
function fixture() {
  const f={partition:'persist:fixture-one',portal:'https://myportal.hkust-gz.edu.cn/',
    now:Date.parse('2027-01-13T00:00:00Z'), waits:[], calls:[], hint:true};
  f.runtime=new MyPortalDataRuntime({
    electronSession:{fromPartition:partition=>({partition,fetch:async()=>{
      const url=f.portal; if(f.probe)await f.probe;
      return {status:200,url};
    }})},
    getPartition:()=>f.partition,getPortalUrl:()=>f.portal,
    getSessionUrlHint:()=>f.hint?f.portal:null,now:()=>f.now,
    getSources:()=>({schedule:{read:async context=>{
      const number=f.calls.length+1, wait=f.waits.shift();
      const title=`${context.session.partition}:${number}`;
      f.calls.push({partition:context.session.partition,week:context.scheduleWeekStart});
      if(wait)await wait;
      return {state:'ready',source:'synthetic',fetchedAt:f.now,stale:false,
        items:[{id:String(number),title,startsAt:f.now,endsAt:f.now+3600000}]};
    }}}),
  });
  return f;
}
const title = snapshot => snapshot.modules.schedule.items[0].title;

test('invalidation retires pending full snapshots instead of sharing or republishing them', async () => {
  const f=fixture(), pending=deferred(); f.waits.push(pending.promise);
  const old=observe(f.runtime.snapshot()); f.runtime.invalidate();
  const fresh=f.runtime.snapshot(); pending.resolve();
  const stale=await old, value=await fresh;
  assert.equal(stale.error?.code,'PORTAL_CONTEXT_CHANGED');
  assert.equal(title(value),'persist:fixture-one:2');
  assert.equal(title(await f.runtime.snapshot()),title(value));
});

test('cached snapshots do not cross a partition or portal change without explicit invalidation', async () => {
  for(const change of [f=>{f.partition='persist:fixture-two';},f=>{f.portal='https://other.example.edu/';}]) {
    const f=fixture(); await f.runtime.snapshot(); change(f);
    const value=await f.runtime.snapshot();
    assert.equal(f.calls.length,2);
    assert.equal(value.portalUrl,f.portal); assert.equal(title(value),`${f.partition}:2`);
  }
});

test('a context retired during the session probe cannot start data source reads', async () => {
  const f=fixture(), pending=deferred(); f.hint=false; f.probe=pending.promise;
  const old=observe(f.runtime.snapshot()); f.partition='persist:fixture-two'; pending.resolve();
  assert.equal((await old).error?.code,'PORTAL_CONTEXT_CHANGED'); assert.deepEqual(f.calls,[]);
});

test('older forced responses cannot overwrite a newer successful snapshot cache', async () => {
  const f=fixture(), pending=deferred(); f.waits.push(pending.promise);
  const old=observe(f.runtime.snapshot({force:true})); const latest=await f.runtime.snapshot({force:true});
  pending.resolve(); assert.equal((await old).error?.code,'PORTAL_CONTEXT_CHANGED');
  assert.equal(title(await f.runtime.snapshot()),title(latest));
});

test('a schedule refresh queued in a retired context cannot publish into its replacement', async () => {
  const f=fixture(), pending=deferred(); f.waits.push(pending.promise);
  const old=observe(f.runtime.snapshot()), refresh=observe(f.runtime.refreshSchedule());
  f.partition='persist:fixture-two'; f.runtime.invalidate();
  const fresh=f.runtime.snapshot(); pending.resolve(); await old;
  assert.equal((await refresh).error?.code,'PORTAL_CONTEXT_CHANGED');
  assert.equal(title(await fresh),'persist:fixture-two:2'); assert.equal(f.calls.length,2);
});

test('same-week readers share one request and an older force response cannot replace the new week cache', async () => {
  const f=fixture(), pending=deferred(); f.waits.push(pending.promise);
  const old=f.runtime.scheduleWeek({date:'2027-02-01'});
  const shared=f.runtime.scheduleWeek({date:'2027-02-02'});
  assert.equal(f.calls.length,1);
  const latest=await f.runtime.scheduleWeek({date:'2027-02-01',force:true});
  pending.resolve(); await old; await shared;
  assert.equal(title(await f.runtime.scheduleWeek({date:'2027-02-01'})),title(latest));
});

test('a full refresh retires weekly cache entries and older weekly publication rights', async () => {
  for(const paused of [false,true]) {
    const f=fixture(), pending=deferred(); if(paused)f.waits.push(pending.promise);
    const old=observe(f.runtime.scheduleWeek({date:'2027-01-11'})); if(!paused)await old;
    const fresh=await f.runtime.snapshot({force:true}); pending.resolve();
    const prior=await old;
    if(paused) assert.equal(prior.error?.code,'PORTAL_CONTEXT_CHANGED');
    else assert.ok(prior.value);
    assert.equal(title(await f.runtime.scheduleWeek({date:'2027-01-11'})),title(fresh));
  }
});

test('week requests waiting on a new full refresh still populate their own cache', async () => {
  const f=fixture(), pending=deferred(); f.waits.push(pending.promise);
  const full=f.runtime.snapshot(), week=f.runtime.scheduleWeek({date:'2027-02-01'});
  pending.resolve(); await full; const value=await week;
  assert.equal(title(await f.runtime.scheduleWeek({date:'2027-02-01'})),title(value));
  assert.equal(f.calls.length,2);
});
