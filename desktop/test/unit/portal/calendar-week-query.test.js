'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calendarWeekQuery, MyPortalDataRuntime, hkustMyPortalSources } = require('../../../lib/browser/session/browser-session-manager');

test('arbitrary calendar selection is exact, campus-time and not a URL/query passthrough', () => {
  const query = calendarWeekQuery({ date: '2032-02-29' });
  assert.equal(new Date(query.start).toISOString(), '2032-02-22T16:00:00.000Z');
  assert.equal(query.end - query.start, 7 * 86400000);
  for (const value of [null, [], {}, { date: '2027-02-29' }, { date: '2027-13-01' },
    { date: '2027-01-01', url: 'https://invalid.example' }, { date: '2027-01-01', force: 'yes' },
    { date: '2027-01-01T00:00:00Z' }]) assert.throws(() => calendarWeekQuery(value), TypeError);
});

test('reviewed adapter requests the selected week instead of the fetch-time week', async () => {
  let requested;
  await hkustMyPortalSources.schedule.read({
    checkedAt: Date.parse('2026-09-07T00:00:00Z'),
    scheduleWeekStart: calendarWeekQuery({ date: '2027-01-13' }).start,
    portalUrl: 'https://myportal.hkust-gz.edu.cn/',
    session: { fetch: async url => { requested = new URL(url); return { status: 200,
      headers: { get: () => null }, text: async () => JSON.stringify({ total: 0, items: [] }) }; } },
  });
  assert.equal(requested.searchParams.get('fromDate'), '2027-01-10T16:00:00.000Z');
  assert.equal(requested.searchParams.get('endDate'), '2027-01-17T15:59:59.999Z');
  assert.equal(requested.pathname, '/calendar/mgr/api/hkust/calendarList.rst');
});

function fixture() {
  const f = { now: Date.parse('2026-09-07T00:00:00Z'), reads: [], partition: 'persist:fixture-one' };
  f.runtime = new MyPortalDataRuntime({
    electronSession: { fromPartition: () => ({}) }, getPartition: () => f.partition,
    getPortalUrl: () => 'https://myportal.hkust-gz.edu.cn/',
    getSessionUrlHint: () => 'https://myportal.hkust-gz.edu.cn/', now: () => f.now,
    getSources: () => ({ schedule: { read: async context => {
      const state = f.state || 'empty';
      f.reads.push(context.scheduleWeekStart); if (f.pause) await f.pause;
      return { state, source: 'myportal-calendar', fetchedAt: f.now, stale: false, items: [] };
    } } }),
  });
  return f;
}

test('week caches are separate, expire daily, allow manual refresh and remain bounded', async () => {
  const f = fixture();
  await f.runtime.scheduleWeek({ date: '2027-01-11' });
  await f.runtime.scheduleWeek({ date: '2027-01-12' });
  assert.equal(f.reads.length, 1);
  await f.runtime.scheduleWeek({ date: '2027-01-18' });
  assert.equal(f.reads.length, 2);
  await f.runtime.scheduleWeek({ date: '2027-01-11', force: true });
  assert.equal(f.reads.length, 3);
  f.now += 86400001;
  await f.runtime.scheduleWeek({ date: '2027-01-11' });
  assert.equal(f.reads.length, 4);
  for (let i = 1; i < 25; i++) {
    await f.runtime.scheduleWeek({ date: new Date(Date.UTC(2027, 2, i * 7)).toISOString().slice(0, 10) });
  }
  assert.equal(f.runtime.calendarCache.size, 12);
  f.runtime.invalidate(); assert.equal(f.runtime.calendarCache.size, 0);
});

test('authoritative calendar revocation evicts all weeks and fences older results', async () => {
  for (const state of ['session-expired', 'not-authenticated', 'forbidden']) for (const request of ['week','snapshot','refresh']) {
    const f=fixture();
    await f.runtime.snapshot();
    await f.runtime.scheduleWeek({date:'2027-01-11'});
    await f.runtime.scheduleWeek({date:'2027-01-18'});
    let resolve;
    f.pause=new Promise(done=>{resolve=done;});
    const pending=f.runtime.scheduleWeek({date:'2027-01-25'});
    f.pause=null; f.state=state;
    const denied=await (request==='week' ? f.runtime.scheduleWeek({date:'2027-01-11',force:true})
      : request==='snapshot' ? f.runtime.snapshot({force:true}) : f.runtime.refreshSchedule());
    assert.equal(denied.modules.schedule.state,state);
    assert.equal(f.runtime.calendarCache.size,0,'other cached weeks must lose authorization');
    assert.equal(f.runtime.cached,null,'the current-week snapshot must not bypass revocation');
    resolve(); await assert.rejects(pending,/context changed/);
    f.state='empty'; const count=f.reads.length;
    await f.runtime.scheduleWeek({date:'2027-01-18'});
    assert.equal(f.reads.length,count+1,'a previous cache hit must now revalidate');
  }
});

test('late calendar data cannot cross partition change or invalidation', async () => {
  for (const switchContext of [false, true]) {
    const f = fixture(); let finish; f.pause = new Promise(resolve => { finish = resolve; });
    const pending = f.runtime.scheduleWeek({ date: '2027-01-11' });
    if (switchContext) f.partition = 'persist:fixture-two'; else f.runtime.invalidate();
    finish();
    await assert.rejects(pending, /context changed/);
    assert.equal(f.runtime.calendarCache.size, 0);
  }
});

test('signed-out status remains cacheable without retaining personal week caches', async () => {
  const f=fixture(); await f.runtime.scheduleWeek({date:'2027-01-11'});
  let probes=0;
  f.runtime.getSessionUrlHint=()=>null;
  f.runtime.electronSession.fromPartition=()=>({fetch:async()=>{
    probes++;return {status:401,url:'https://myportal.hkust-gz.edu.cn/'};
  }});
  const denied=await f.runtime.snapshot({force:true});
  assert.equal(denied.sessionState,'unauthenticated');
  assert.equal(f.runtime.calendarCache.size,0);
  assert(Object.values(f.runtime.cached.modules).every(module=>module.items.length===0));
  await f.runtime.snapshot(); assert.equal(probes,1);
  await f.runtime.snapshot({force:true}); assert.equal(probes,2);
});

test('a fresh full revalidation fences denial from an older week request', async () => {
  const f=fixture(); let resolve;
  f.state='session-expired'; f.pause=new Promise(done=>{resolve=done;});
  const old=f.runtime.scheduleWeek({date:'2027-01-11'});
  f.pause=null; f.state='empty';
  await f.runtime.snapshot({force:true});
  resolve(); await assert.rejects(old,/context changed/);
  assert.equal(f.runtime.cached.modules.schedule.state,'empty');
});
