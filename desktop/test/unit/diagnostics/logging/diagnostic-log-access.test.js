'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DiagnosticLogAccessRuntime } = require('../../../../lib/diagnostics/logging/log-writer');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const f = { token: {}, quitting: false, calls: [], flush: null, tail: null, flushFailure: null, openFailure: null };
  f.writer = { closed: false, flush: () => { f.calls.push('flush');
    if (f.flushFailure) return Promise.reject(f.flushFailure); return f.flush?.promise || Promise.resolve(); } };
  f.effects = { file: '/synthetic/engine.log', getWriter: () => f.writer,
    captureContext: () => f.token, isContextCurrent: token => token === f.token,
    isQuitting: () => f.quitting,
    onFlushFailure: error => { f.calls.push(['error', error]); },
    readTail: (_file, options) => { f.calls.push('read'); assert.equal(options.contextCurrent(), true);
      return f.tail?.promise || Promise.resolve('synthetic log tail'); },
    openPath: async file => { f.calls.push(['open', file]); if (f.openFailure) throw f.openFailure; },
  };
  f.owner = new DiagnosticLogAccessRuntime(f.effects);
  return f;
}

test('diagnostic access validates capabilities without construction effects', () => {
  const f = fixture(); assert.deepEqual(f.calls, []);
  for (const overrides of [{ file: '' }, { getWriter: null }, { captureContext: null },
    { isContextCurrent: null }, { isQuitting: null }, { onFlushFailure: null }, { openPath: null }, { readTail: null }]) {
    assert.throws(() => new DiagnosticLogAccessRuntime({ ...f.effects, ...overrides }), TypeError);
  }
});

test('live reads and openings preserve flush-before-operation and return shapes', async () => {
  const f = fixture(); assert.equal(await f.owner.read(), 'synthetic log tail');
  assert.deepEqual(f.calls.splice(0), ['flush', 'read']);
  assert.equal(await f.owner.open(), undefined);
  assert.deepEqual(f.calls, ['flush', ['open', '/synthetic/engine.log']]);
});

test('quit, context change, writer replacement or close during flush suppresses further effects', async () => {
  for (const retire of [f => { f.quitting = true; }, f => { f.token = {}; },
    f => { f.writer = { closed: false, flush: () => assert.fail('new writer cannot be borrowed') }; },
    f => { f.writer.closed = true; }]) {
    for (const operation of ['read', 'open']) {
      const f = fixture(); f.flush = deferred(); const pending = f.owner[operation]();
      assert.deepEqual(f.calls, ['flush']); retire(f); f.flush.resolve();
      assert.equal(await pending, operation === 'read' ? '' : undefined);
      assert.deepEqual(f.calls, ['flush']);
    }
  }
});

test('retired read results are discarded after the tail operation itself awaits', async () => {
  const f = fixture(); f.tail = deferred(); const pending = f.owner.read();
  await new Promise(setImmediate); assert.deepEqual(f.calls, ['flush', 'read']);
  f.token = {}; f.tail.resolve('synthetic old-context tail'); assert.equal(await pending, '');
});

test('live flush failures report then continue; late failures cannot report into another context', async () => {
  const f = fixture(), failure = new Error('synthetic flush failure'); f.flushFailure = failure;
  assert.equal(await f.owner.read(), 'synthetic log tail');
  assert.deepEqual(f.calls, ['flush', ['error', failure], 'read']);
  const retired = fixture(); retired.flush = deferred(); const pending = retired.owner.open();
  retired.token = {}; retired.flush.reject(failure); await pending;
  assert.deepEqual(retired.calls, ['flush']);
});

test('already quitting, gated context, missing or closed writer create no log operations', async () => {
  for (const setup of [f => { f.quitting = true; },
    f => { f.effects.captureContext = () => { throw new Error('synthetic gated context'); }; },
    f => { f.writer = null; }, f => { f.writer.closed = true; }]) {
    const f = fixture(); setup(f); f.owner = new DiagnosticLogAccessRuntime(f.effects);
    assert.equal(await f.owner.read(), ''); assert.equal(await f.owner.open(), undefined);
    assert.deepEqual(f.calls, []);
  }
});

test('live external opening rejection keeps the existing advisory no-error result', async () => {
  const f = fixture(); f.openFailure = new Error('synthetic open failure');
  assert.equal(await f.owner.open(), undefined); assert.equal(f.calls[1][0], 'open');
});

test('tail failures retain live identity but are suppressed after context retirement', async () => {
  const failure = new Error('synthetic tail failure'), live = fixture(); live.tail = deferred();
  const activeRead = live.owner.read(); await new Promise(setImmediate); live.tail.reject(failure);
  await assert.rejects(activeRead, error => error === failure);
  const retired = fixture(); retired.tail = deferred();
  const lateRead = retired.owner.read(); await new Promise(setImmediate);
  retired.quitting = true; retired.tail.reject(failure); assert.equal(await lateRead, '');
});
