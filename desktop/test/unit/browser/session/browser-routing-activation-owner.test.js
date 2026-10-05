'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const acorn = require('acorn');
const { BrowserRoutingActivationOwner } = require('../../../../lib/browser/session/browser-session-manager');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  const state = { suspended: false, requestsBlocked: true, configuredPort: null, campusSession: null };
  const calls = [];
  const session = {};
  let contextCurrent = true;
  const activate = async (kind, port) => {
    calls.push([kind, port]);
    state.suspended = false;
    state.requestsBlocked = false;
    state.configuredPort = port;
    state.campusSession = session;
    return session;
  };
  const owner = new BrowserRoutingActivationOwner({
    getSessionState: () => state,
    ensureCampusReady: async () => { calls.push(['ready']); return true; },
    isContextCurrent: () => contextCurrent,
    configure: (port) => activate('configure', port),
    resume: (port) => activate('resume', port),
    ...overrides,
  });
  return { owner, state, calls, session, retire: () => { contextCurrent = false; } };
}

test('activation owner rejects incomplete injected Session capabilities', () => {
  assert.throws(() => new BrowserRoutingActivationOwner({}), TypeError);
});

test('optional entry admission fences readiness and activation without changing other callers',async()=>{
  const f=fixture();assert.equal(await f.owner.ensureReady({route:'campus'},6180,()=>false),false);
  assert.deepEqual(f.calls,[]);
  const ready=deferred(),g=fixture({ensureCampusReady:()=>ready.promise});let current=true;
  const waiting=g.owner.ensureReady({route:'campus'},6180,()=>current);current=false;ready.resolve(true);
  assert.equal(await waiting,false);assert.deepEqual(g.calls,[]);
  await assert.rejects(g.owner.ensureReady({route:'direct'},6180,null),/admission is invalid/);
  assert.equal(await f.owner.ensureReady({route:'direct'},6180),true);
});

test('the extracted routing activation owner stays below the M2 owner ceiling', () => {
  const source = fs.readFileSync(require.resolve('../../../../lib/browser/session/browser-session-manager'), 'utf8');
  const tree = acorn.parse(source, { ecmaVersion: 'latest', locations: true });
  const owner = tree.body.find(node => node.type === 'ClassDeclaration' &&
    node.id.name === 'BrowserRoutingActivationOwner');
  assert.ok(owner, 'the production owner must exist at its public entrypoint');
  assert.ok(owner.loc.end.line - owner.loc.start.line + 1 <= 600,
    'the extracted owner must not exceed the M2 ceiling');
});

test('a ready Session is reused without reconfiguring; a suspended Session resumes', async () => {
  const f = fixture();
  assert.equal(await f.owner.activate(6180), f.session);
  assert.equal(await f.owner.activate('6180'), f.session);
  assert.deepEqual(f.calls, [['configure', 6180]]);
  f.state.suspended = true;
  f.state.requestsBlocked = true;
  assert.equal(await f.owner.activate(6180), f.session);
  assert.deepEqual(f.calls, [['configure', 6180], ['resume', 6180]]);
  assert.equal(f.owner.inFlight, null);
});

test('concurrent same-port activation shares one Session transition', async () => {
  const pending = deferred();
  const f = fixture({ configure: async (port) => {
    f.calls.push(['configure', port]);
    await pending.promise;
    Object.assign(f.state, { configuredPort: port, requestsBlocked: false, campusSession: f.session });
    return f.session;
  } });
  const first = f.owner.activate(6180);
  const second = f.owner.activate(6180);
  assert.equal(f.calls.length, 1);
  assert.equal(f.owner.inFlight.port, 6180);
  pending.resolve();
  assert.deepEqual(await Promise.all([first, second]), [f.session, f.session]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.owner.inFlight, null);
});

test('a different requested port waits before configuring a second Session transition', async () => {
  const pending = deferred();
  const f = fixture({ configure: async (port) => {
    f.calls.push(['configure', port]);
    if (port === 6180) await pending.promise;
    Object.assign(f.state, { configuredPort: port, requestsBlocked: false, campusSession: f.session });
    return f.session;
  } });
  const first = f.owner.activate(6180);
  const second = f.owner.activate(7180);
  assert.deepEqual(f.calls, [['configure', 6180]]);
  pending.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(f.calls, [['configure', 6180], ['configure', 7180]]);
  assert.equal(f.state.configuredPort, 7180);
});

test('same-port followers behind another port still share the next transition', async t => {
  const firstGate = deferred();
  const nextGate = deferred();
  t.after(() => { firstGate.resolve(); nextGate.resolve(); });
  const f = fixture({ configure: async port => {
    f.calls.push(['configure', port]);
    await (port === 6180 ? firstGate.promise : nextGate.promise);
    Object.assign(f.state, { configuredPort: port, requestsBlocked: false, campusSession: f.session });
    return f.session;
  } });
  const first = f.owner.activate(6180);
  const next = f.owner.activate(7180);
  const follower = f.owner.activate(7180);
  firstGate.resolve();
  await first;
  assert.deepEqual(f.calls, [['configure', 6180], ['configure', 7180]],
    'waiting followers must recheck a replacement flight before starting another transition');
  nextGate.resolve();
  await Promise.all([next, follower]);
  assert.equal(f.owner.inFlight, null);
});

test('rejected activation releases its flight so the next explicit attempt can proceed', async () => {
  const pending = deferred();
  let fail = true;
  const f = fixture({ configure: async () => {
    if (fail) return pending.promise;
    return f.session;
  } });
  const first = f.owner.activate(6180);
  const second = f.owner.activate(6180);
  pending.reject(new Error('synthetic activation failure'));
  await assert.rejects(first, /synthetic activation/);
  await assert.rejects(second, /synthetic activation/);
  assert.equal(f.owner.inFlight, null);
  fail = false;
  assert.equal(await f.owner.activate(6180), f.session);
});

test('direct readiness skips Engine startup, while failed campus readiness stays closed', async () => {
  const direct = fixture();
  assert.equal(await direct.owner.ensureReady({ route: 'direct' }, 6180), true);
  assert.deepEqual(direct.calls, [['configure', 6180]]);
  const campus = fixture({ ensureCampusReady: async () => false });
  assert.equal(await campus.owner.ensureReady({ route: 'campus' }, 6180), false);
  assert.equal(await campus.owner.ensureReady({ route: 'unknown' }, 6180), false);
  assert.equal(await campus.owner.ensureReady(null, 6180), false);
  assert.deepEqual(campus.calls, []);
});

test('context retirement during Engine readiness prevents late Session activation', async () => {
  const ready = deferred();
  const f = fixture({ ensureCampusReady: () => ready.promise });
  const waiting = f.owner.ensureReady({ route: 'campus' }, 6180);
  f.retire();
  ready.resolve(true);
  assert.equal(await waiting, false);
  assert.deepEqual(f.calls, []);
});

for (const retirement of ['context', 'reset']) {
  test(`${retirement} retirement during accepted Session activation cannot report new readiness`, async () => {
    const gate = deferred();
    const f = fixture({ configure: async port => {
      await gate.promise;
      Object.assign(f.state, { configuredPort: port, requestsBlocked: false, campusSession: f.session });
      return f.session;
    } });
    const pending = f.owner.ensureReady({ route: 'direct' }, 6180);
    if (retirement === 'context') f.retire(); else f.owner.reset();
    gate.resolve();
    assert.equal(await pending, false);
    assert.equal(f.state.campusSession, f.session, 'accepted Session IO is not falsely rolled back');
    assert.equal(f.owner.inFlight, null);
  });
}

test('retired activation failure is quiet while the same current failure preserves its cause', async () => {
  for (const retired of [false, true]) {
    const gate = deferred(), failure = new Error('synthetic activation failure');
    const f = fixture({ configure: () => gate.promise });
    const pending = f.owner.ensureReady({ route: 'direct' }, 6180);
    if (retired) f.retire();
    gate.reject(failure);
    if (retired) assert.equal(await pending, false);
    else await assert.rejects(pending, error => error === failure);
  }
});

test('retired Engine-readiness failure is quiet but a current failure remains actionable', async () => {
  for (const retired of [false, true]) {
    const gate = deferred(), failure = new Error('synthetic readiness failure');
    const f = fixture({ ensureCampusReady: () => gate.promise });
    const pending = f.owner.ensureReady({ route: 'campus' }, 6180);
    if (retired) f.owner.reset();
    gate.reject(failure);
    if (retired) assert.equal(await pending, false);
    else await assert.rejects(pending, error => error === failure);
    assert.deepEqual(f.calls, []);
  }
});

test('an already retired context cannot request Engine readiness or inspect Session state', async () => {
  const f = fixture(); f.retire();
  f.owner.getSessionState = () => { throw new Error('retired Session read'); };
  assert.equal(await f.owner.ensureReady({ route: 'campus' }, 6180), false);
  assert.deepEqual(f.calls, []);
});

test('completion retirement is checked before another owner is read and again after that read', async () => {
  const gate = deferred(), f = fixture({ configure: () => gate.promise });
  const pending = f.owner.ensureReady({ route: 'direct' }, 6180);
  f.owner.getSessionState = () => { throw new Error('retired Session read'); };
  f.retire(); gate.resolve(f.session);
  assert.equal(await pending, false);
  const g = fixture(), readState = g.owner.getSessionState;
  g.owner.getSessionState = () => {
    const state = readState();
    if (state.campusSession) g.retire();
    return state;
  };
  assert.equal(await g.owner.ensureReady({ route: 'direct' }, 6180), false);
});

test('a superseding Session suspension keeps a completed readiness attempt fail closed', async () => {
  const f = fixture({ configure: async () => {
    f.state.suspended = true;
    f.state.requestsBlocked = true;
    return null;
  } });
  assert.equal(await f.owner.ensureReady({ route: 'campus' }, 6180), false);
});

test('repeated window reset is idempotent and an old completion cannot erase a new flight', async () => {
  const old = deferred();
  const replacement = deferred();
  const f = fixture({ configure: (port) => port === 6180 ? old.promise : replacement.promise });
  const first = f.owner.activate(6180);
  f.owner.reset();
  f.owner.reset();
  const second = f.owner.activate(7180);
  const replacementFlight = f.owner.inFlight;
  old.resolve(f.session);
  await first;
  assert.equal(f.owner.inFlight, replacementFlight);
  replacement.resolve(f.session);
  await second;
  assert.equal(f.owner.inFlight, null);
});
