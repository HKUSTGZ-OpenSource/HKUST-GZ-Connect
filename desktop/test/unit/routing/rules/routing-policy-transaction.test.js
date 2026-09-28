'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const {
  RoutingPolicyCoordinator,
  RoutingPolicyTransactionQueue,
  runRoutingPolicyTransaction,
} = require('../../../../lib/routing/rules/routing-policy-transaction');

function coordinatorFixture() {
  const calls = [];
  const token = Object.freeze({});
  let current = true, live = true, rules = [], strict = false;
  const queue = new RoutingPolicyTransactionQueue({ isContextCurrent: () => current });
  const policy = {
    list: () => rules.slice(),
    resolve: url => ({ route: 'campus', url }),
    upsert: payload => { calls.push('commit'); rules.push(payload); return payload; },
    remove: () => { calls.push('remove'); rules = []; },
    replace: previous => { calls.push('rollback'); rules = previous.slice(); },
    buildPac: (port, options) => JSON.stringify({ port, options, rules }),
  };
  const owner = new RoutingPolicyCoordinator({
    policy, externalPacFile: '/synthetic/external.pac', browserPacFile: '/synthetic/browser.pac',
    getSettings: () => ({ port: 6180, strictProxyAuth: strict }),
    getSocksPort: () => 6180, canResumeBrowser: () => live,
    getBrowser: () => ({
      suspendRoutingPolicy: async () => calls.push('suspend'),
      resumeRoutingPolicy: async port => calls.push(`resume:${port}`),
    }),
    assertPersistence: () => calls.push('admit'),
    runTransaction: operations => queue.run(token, operations),
    encodePac: source => `encoded:${source}`,
    writePac: (file, source) => {
      calls.push(file.endsWith('browser.pac') ? 'browser-pac' : 'external-pac');
      return { url: `file://${file}?v=synthetic`, source };
    },
  });
  return { owner, calls, policy, retire: () => { current = false; },
    setLive: value => { live = value; }, setStrict: value => { strict = value; } };
}

test('Routing coordinator constructs without effects and preserves derived PAC modes', () => {
  const f = coordinatorFixture();
  assert.deepEqual(f.calls, []);
  assert.equal(f.owner.pacUrl(), pathToFileURL('/synthetic/external.pac').href);
  const external = f.owner.refreshExternal();
  assert.equal(JSON.parse(external.source).options.defaultRoute, 'direct');
  assert.equal(f.owner.pacUrl(), 'file:///synthetic/external.pac?v=synthetic');
  for (const strict of [false, true]) {
    f.setStrict(strict);
    const config = f.owner.browserPolicy.proxyConfig(6180);
    assert.equal(config.mode, 'pac_script');
    assert.equal(config.proxyBypassRules, '<-loopback>');
    const projected = JSON.parse(config.pacScript.slice('encoded:'.length));
    assert.equal(projected.options.proxyKind, strict ? 'http' : 'socks5');
    assert.equal(projected.options.campusPrivateIpv4, true);
  }
});

test('Routing coordinator uses one context queue for mutation and external-before-Browser apply', async () => {
  const f = coordinatorFixture();
  const rule = { host: 'synthetic.invalid', route: 'campus' };
  assert.deepEqual(await f.owner.browserPolicy.upsert(rule), rule);
  assert.deepEqual(f.calls, ['admit', 'suspend', 'commit', 'external-pac', 'resume:6180']);
  assert.deepEqual(f.owner.browserPolicy.list(), [rule]);
  f.calls.length = 0;
  f.setLive(false);
  await f.owner.browserPolicy.remove(rule);
  assert.deepEqual(f.calls, ['admit', 'suspend', 'remove', 'external-pac']);
  f.retire();
  await assert.rejects(f.owner.browserPolicy.upsert(rule), error => error.code === 'stale_context');
  assert.deepEqual(f.owner.browserPolicy.list(), []);
});

test('Routing coordinator restores source and external PAC after a failed apply', async () => {
  const f = coordinatorFixture();
  f.owner.writePac = () => { f.calls.push('failed-pac'); throw new Error('synthetic disk failure'); };
  await assert.rejects(f.owner.browserPolicy.upsert({ host: 'synthetic.invalid', route: 'campus' }),
    error => error.rollbackIncomplete === true && error.message === 'synthetic disk failure');
  assert.deepEqual(f.owner.browserPolicy.list(), []);
  assert.deepEqual(f.calls, ['admit', 'suspend', 'commit', 'failed-pac', 'rollback', 'failed-pac']);
});

test('Routing coordinator can defer Browser apply without skipping recovery', async () => {
  const f = coordinatorFixture();
  await f.owner.run(() => ({ commit: () => f.calls.push('custom-commit'), resumeBrowser: false }));
  assert.deepEqual(f.calls, ['admit', 'suspend', 'custom-commit', 'external-pac']);
});

test('Routing coordinator retains Browser restoration after a recoverable external failure', async () => {
  const f = coordinatorFixture();
  let writes = 0;
  f.owner.writePac = () => {
    f.calls.push(++writes === 1 ? 'failed-pac' : 'restored-pac');
    if (writes === 1) throw new Error('synthetic write failed');
    return { url: 'file:///restored.pac' };
  };
  await assert.rejects(f.owner.run(() => ({
    commit: () => f.calls.push('custom-commit'),
    rollback: () => f.calls.push('custom-rollback'), resumeBrowser: false,
  })), error => error.message === 'synthetic write failed' && !error.rollbackIncomplete);
  assert.deepEqual(f.calls, ['admit', 'suspend', 'custom-commit', 'failed-pac',
    'custom-rollback', 'restored-pac', 'resume:6180']);
});

test('Routing coordinator never emits Browser PAC when its diagnostic write fails', () => {
  const f = coordinatorFixture();
  let encoded = false;
  f.owner.encodePac = () => { encoded = true; return 'unexpected'; };
  f.owner.writePac = () => { throw new Error('synthetic diagnostic failure'); };
  assert.throws(() => f.owner.browserPolicy.proxyConfig(6180), /synthetic diagnostic failure/u);
  assert.equal(encoded, false);
  assert.equal(f.owner.pacUrl(), pathToFileURL('/synthetic/external.pac').href);
});

test('Routing coordinator snapshots queued rules after the preceding commit', async () => {
  const f = coordinatorFixture();
  const firstRule = { host: 'first.invalid', route: 'campus' };
  const secondRule = { host: 'second.invalid', route: 'direct' };
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const upsert = f.policy.upsert;
  f.policy.upsert = async rule => {
    if (rule === firstRule) { started(); await blocked; }
    return upsert(rule);
  };
  const first = f.owner.browserPolicy.upsert(firstRule);
  await entered;
  const second = f.owner.browserPolicy.upsert(secondRule);
  let writes = 0;
  const writePac = f.owner.writePac;
  f.owner.writePac = (file, source) => {
    if (++writes === 2) throw new Error('synthetic second apply failure');
    return writePac(file, source);
  };
  release();
  assert.equal(await first, firstRule);
  await assert.rejects(second, /synthetic second apply failure/u);
  assert.deepEqual(f.owner.browserPolicy.list(), [firstRule],
    'the second rollback must preserve the first committed mutation');
});

test('Routing coordinator rejects unavailable persistence before reading or suspending', async () => {
  const f = coordinatorFixture();
  f.owner.assertPersistence = () => { throw new Error('synthetic unavailable persistence'); };
  f.policy.list = () => { throw new Error('snapshot must not be read'); };
  await assert.rejects(f.owner.browserPolicy.upsert({ host: 'synthetic.invalid', route: 'campus' }),
    /synthetic unavailable persistence/u);
  assert.deepEqual(f.calls, []);
});

test('routing policy commits source, external PAC, then browser under suspension', async () => {
  const calls = [];
  const result = await runRoutingPolicyTransaction({
    suspend: async () => calls.push('suspend'),
    commit: async () => { calls.push('commit'); return 'candidate'; },
    applyExternal: async () => calls.push('external'),
    applyBrowser: async () => calls.push('browser'),
    rollback: async () => calls.push('rollback'),
    restoreExternal: async () => calls.push('restore-external'),
    restoreBrowser: async () => calls.push('restore-browser'),
  });
  assert.equal(result, 'candidate');
  assert.deepEqual(calls, ['suspend', 'commit', 'external', 'browser']);
});

for (const failingStage of ['external', 'browser']) {
  test(`${failingStage} failure rolls the source, PAC, and live browser back in order`, async () => {
    const calls = [];
    const failure = new Error(`${failingStage} failed`);
    await assert.rejects(runRoutingPolicyTransaction({
      suspend: async () => calls.push('suspend'),
      commit: async () => calls.push('commit'),
      applyExternal: async () => {
        calls.push('external');
        if (failingStage === 'external') throw failure;
      },
      applyBrowser: async () => {
        calls.push('browser');
        if (failingStage === 'browser') throw failure;
      },
      rollback: async () => calls.push('rollback'),
      restoreExternal: async () => calls.push('restore-external'),
      restoreBrowser: async () => calls.push('restore-browser'),
    }), (error) => {
      assert.equal(error, failure);
      assert.equal(error.rollbackIncomplete, undefined);
      return true;
    });
    assert.deepEqual(calls, [
      'suspend',
      'commit',
      'external',
      ...(failingStage === 'browser' ? ['browser'] : []),
      'rollback',
      'restore-external',
      'restore-browser',
    ]);
  });
}

test('failed recovery leaves the browser suspended and marks rollback incomplete', async () => {
  const calls = [];
  await assert.rejects(runRoutingPolicyTransaction({
    suspend: async () => calls.push('suspend'),
    commit: async () => calls.push('commit'),
    applyExternal: async () => { calls.push('external'); throw new Error('disk full'); },
    rollback: async () => { calls.push('rollback'); throw new Error('JSON rollback failed'); },
    restoreExternal: async () => calls.push('restore-external'),
    restoreBrowser: async () => calls.push('restore-browser'),
  }), (error) => {
    assert.equal(error.message, 'disk full');
    assert.equal(error.rollbackIncomplete, true);
    assert.deepEqual(error.recoveryFailures, ['JSON rollback failed']);
    return true;
  });
  assert.deepEqual(calls, [
    'suspend', 'commit', 'external', 'rollback', 'restore-external',
  ], 'a partially restored source/PAC must not reactivate the Session');
});

test('a commit failure restores the old live browser without running source rollback', async () => {
  const calls = [];
  await assert.rejects(runRoutingPolicyTransaction({
    suspend: async () => calls.push('suspend'),
    commit: async () => { calls.push('commit'); throw new Error('JSON rename failed'); },
    rollback: async () => calls.push('rollback'),
    restoreExternal: async () => calls.push('restore-external'),
    restoreBrowser: async () => calls.push('restore-browser'),
  }), /JSON rename failed/);
  assert.deepEqual(calls, ['suspend', 'commit', 'restore-browser']);
});

test('a failure after an atomic rename is rolled back before browser restore', async () => {
  const calls = [];
  const failure = new Error('directory fsync failed');
  failure.commitApplied = true;
  await assert.rejects(runRoutingPolicyTransaction({
    suspend: async () => calls.push('suspend'),
    commit: async () => { calls.push('commit'); throw failure; },
    rollback: async () => calls.push('rollback'),
    restoreExternal: async () => calls.push('restore-external'),
    restoreBrowser: async () => calls.push('restore-browser'),
  }), (error) => error === failure);
  assert.deepEqual(calls, [
    'suspend', 'commit', 'rollback', 'restore-external', 'restore-browser',
  ]);
});

test('queued transaction factories run serially and observe the latest committed source', async () => {
  const token = Object.freeze({});
  const queue = new RoutingPolicyTransactionQueue({ isContextCurrent: (value) => value === token });
  const snapshots = [];
  let state = 0;
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let firstCommitStarted;
  const firstStarted = new Promise((resolve) => { firstCommitStarted = resolve; });

  const makeTransaction = (next, blocked = null) => () => {
    const previous = state;
    snapshots.push(previous);
    return {
      commit: async () => {
        if (blocked) {
          firstCommitStarted();
          await blocked;
        }
        state = next;
        return next;
      },
      rollback: async () => { state = previous; },
    };
  };

  const first = queue.run(token, makeTransaction(1, firstBlocked));
  await firstStarted;
  const second = queue.run(token, makeTransaction(2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(snapshots, [0], 'the second snapshot must not be captured before its turn');
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(snapshots, [0, 1]);
  assert.equal(state, 2);
});

test('cancelAndDrain rejects queued stale work before its factory observes state', async () => {
  const token = Object.freeze({});
  const queue = new RoutingPolicyTransactionQueue({ isContextCurrent: () => true });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  let secondObserved = false;
  const first = queue.run(token, () => ({
    commit: async () => { started(); await blocked; },
  }));
  await firstStarted;
  const second = queue.run(token, () => {
    secondObserved = true;
    return { commit: async () => {} };
  });
  const draining = queue.cancelAndDrain();
  release();
  await assert.rejects(first, (error) => error.code === 'stale_context');
  await assert.rejects(second, (error) => error.code === 'stale_context');
  assert.equal(await draining, true);
  assert.equal(secondObserved, false);
});

test('stale in-flight commit rolls back old source and PAC then re-gates Browser', async () => {
  const token = Object.freeze({});
  let current = true;
  let releaseExternal;
  const externalBlocked = new Promise((resolve) => { releaseExternal = resolve; });
  let externalStarted;
  const externalStart = new Promise((resolve) => { externalStarted = resolve; });
  const calls = [];
  const queue = new RoutingPolicyTransactionQueue({ isContextCurrent: () => current });
  const mutation = queue.run(token, {
    suspend: async () => calls.push('suspend'),
    commit: async () => calls.push('commit'),
    applyExternal: async () => { calls.push('external'); externalStarted(); await externalBlocked; },
    applyBrowser: async () => calls.push('browser'),
    rollback: async () => calls.push('rollback'),
    restoreExternal: async () => calls.push('restore-external'),
    restoreBrowser: async () => calls.push('restore-browser'),
  });
  await externalStart;
  current = false;
  const draining = queue.cancelAndDrain();
  releaseExternal();
  await assert.rejects(mutation, (error) => error.code === 'stale_context');
  assert.equal(await draining, true);
  assert.deepEqual(calls, [
    'suspend', 'commit', 'external', 'rollback', 'restore-external', 'suspend',
  ]);
});

test('rollback uncertainty makes context drain fail closed permanently', async () => {
  const token = Object.freeze({});
  let current = true;
  const queue = new RoutingPolicyTransactionQueue({ isContextCurrent: () => current });
  const mutation = queue.run(token, {
    commit: async () => { current = false; },
    rollback: async () => { throw new Error('rollback failed'); },
    restoreExternal: async () => {},
  });
  await assert.rejects(mutation, (error) => error.rollbackIncomplete === true);
  assert.equal(await queue.cancelAndDrain(), false);
});
