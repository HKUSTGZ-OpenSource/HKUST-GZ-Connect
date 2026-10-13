'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hkustPortalCatalogSource } = require('../../../../lib/browser/session/myportal-catalog');
const { MyPortalDataRuntime, hkustMyPortalSources } = require('../../../../lib/browser/session/browser-session-manager');

async function flushMicrotasks() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

test('a timed-out portal refresh releases its single-flight slot and allows a later refresh', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stall = true;
  const release = [];
  const portalUrl = 'https://portal.example.test/';
  const targetSession = { fetch: async url => {
    if (new URL(url).pathname === '/') return { status: 200, url: portalUrl };
    return { status: 200, headers: { get: () => null }, text: () => stall
      ? new Promise(resolve => release.push(() => resolve('[]'))) : Promise.resolve('[]') };
  } };
  const runtime = new MyPortalDataRuntime({
    electronSession: { fromPartition: () => targetSession },
    getPartition: () => 'persist:portal-deadline-fixture', getPortalUrl: () => portalUrl,
    getSources: () => ({ schedule: hkustMyPortalSources.schedule }),
    timeoutMs: 500, now: () => 1_800_000_000_000,
  });
  const pending = runtime.refreshSchedule();
  await flushMicrotasks();
  assert.equal(release.length, 7);
  t.mock.timers.tick(500);
  const failed = await pending;
  assert.equal(failed.modules.schedule.state, 'failed');
  assert.equal(runtime.inflight, null);
  assert.deepEqual(failed.modules.schedule.items, []);
  stall = false;
  const recovered = await runtime.refreshSchedule();
  assert.equal(recovered.modules.schedule.state, 'empty');
  for (const finish of release) finish();
  await flushMicrotasks();
  assert.equal(runtime.cached, recovered, 'late body completion must not overwrite the later refresh');
  assert.equal(runtime.inflight, null);
});

for (const [name, source, count] of [
  ['catalog', hkustPortalCatalogSource, 3],
  ['calendar', hkustMyPortalSources.schedule, 7],
  ['news', hkustMyPortalSources.news, 1],
]) {
  test(`${name} source deadline remains active while response body is pending`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const signals = [];
    const release = [];
    const context = {
      portalUrl: 'https://portal.example.test/',
      checkedAt: Date.parse('2026-09-30T10:00:00+08:00'),
      timeoutMs: 500,
      session: { fetch: async (_url, { signal }) => {
        signals.push(signal);
        return { status: 200, headers: { get: () => null },
          text: () => new Promise(resolve => release.push(() => resolve('[]'))) };
      } },
    };
    let outcome = null;
    const operation = source.read(context).then(
      value => { outcome = { value }; }, error => { outcome = { error }; },
    );
    try {
      await flushMicrotasks();
      assert.equal(signals.length, count);
      assert.equal(release.length, count, 'all headers arrived and body reads started');
      t.mock.timers.tick(500);
      await flushMicrotasks();
      assert.equal(signals.every(signal => signal.aborted), true,
        'a headers-only success must not cancel the response-body deadline');
      assert.equal(outcome?.error?.code, 'PORTAL_SOURCE_TIMEOUT',
        'the public operation must settle even if a body ignores abort');
    } finally {
      for (const finish of release) finish();
      await operation;
    }
  });

  test(`${name} late response headers never start a body read after deadline`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const signals = [];
    const release = [];
    let bodyReads = 0;
    const operation = source.read({
      portalUrl: 'https://portal.example.test/', checkedAt: 1_800_000_000_000, timeoutMs: 500,
      session: { fetch: (_url, { signal }) => {
        signals.push(signal);
        return new Promise(resolve => release.push(() => resolve({
          status: 200, headers: { get: () => null },
          text: async () => { bodyReads++; return '[]'; },
        })));
      } },
    }).then(value => ({ value }), error => ({ error }));
    await flushMicrotasks();
    assert.equal(signals.length, count);
    t.mock.timers.tick(500);
    const outcome = await operation;
    assert.equal(outcome.error?.code, 'PORTAL_SOURCE_TIMEOUT');
    assert.equal(signals.every(signal => signal.aborted), true);
    for (const finish of release) finish();
    await flushMicrotasks();
    assert.equal(bodyReads, 0, 'retired fetch completion cannot consume a response');
  });

  test(`${name} success and error completions clear the same request deadline`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const [status, body, expected] of [
      [200, '[]', null],
      [401, '[]', 'PORTAL_SESSION_EXPIRED'],
      [403, '[]', 'PORTAL_FORBIDDEN'],
      [500, '[]', 'PORTAL_RESPONSE_INVALID'],
      [200, 'invalid synthetic JSON', 'PORTAL_RESPONSE_INVALID'],
    ]) {
      const signals = [];
      const outcome = await source.read({
        portalUrl: 'https://portal.example.test/', checkedAt: 1_800_000_000_000, timeoutMs: 500,
        session: { fetch: async (url, { signal }) => {
          signals.push(signal);
          let text = body;
          if (name === 'catalog' && status === 200 && body === '[]') {
            const item = { appId: 1, name: 'Synthetic app', appUrl: 'https://app.example.test/' };
            const payload = url.includes('loadAllServiceApps') ? { data: { appList: [item] } }
              : url.includes('getPortalCenterTerm') ? { data: [] }
                : { data: [{ id: 0, list: [item] }] };
            text = JSON.stringify(payload);
          }
          return { status, headers: { get: () => null }, text: async () => text };
        } },
      }).then(value => ({ value }), error => ({ error }));
      if (expected) assert.equal(outcome.error?.code, expected);
      else assert.equal(outcome.value?.state, name === 'catalog' ? 'ready' : 'empty');
      await flushMicrotasks();
      t.mock.timers.tick(500);
      await flushMicrotasks();
      assert.equal(signals.length, count);
      assert.equal(signals.some(signal => signal.aborted), false,
        `completed response ${status} must not retain a live deadline`);
    }
  });
}
