'use strict';

const assert = require('node:assert/strict');
const NETWORK_FILTER = Object.freeze({
  urls: Object.freeze(['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']),
});
const MAIN_FIXTURE_DEADLINE_MS = 60_000;

// This is an outbound test constraint, not a replacement for Browser readiness.
// Keep the actual listener's four-protocol filter and loopback decision intact.
function createOfflineGuard() {
  const installed = new WeakSet(), blockedOrigins = new Set();
  const counts = { sessions: 0, registrations: 0, blocked: 0,
    loopbackDefault: 0, delegated: 0, originalAllowed: 0, originalCancelled: 0 };
  function installSession(owner) {
    if (installed.has(owner)) return;
    const request = owner.webRequest, register = request.onBeforeRequest.bind(request);
    let listener = null;
    request.onBeforeRequest = (filter, next) => {
      if (filter === null && next === undefined) { listener = null; return; }
      assert.deepEqual(Object.keys(filter).sort(), ['urls'], 'unexpected Main fixture request filter');
      assert.deepEqual([...filter.urls].sort(), [...NETWORK_FILTER.urls].sort(),
        'the Main fixture must preserve all production request protocols');
      assert.ok(next === null || typeof next === 'function', 'invalid request listener');
      listener = next; counts.registrations++;
    };
    register(NETWORK_FILTER, (details, callback) => {
      const target = new URL(details.url);
      if (!['127.0.0.1', '[::1]'].includes(target.hostname)) {
        counts.blocked++; blockedOrigins.add(target.origin); callback({ cancel: true }); return;
      }
      if (!listener) { counts.loopbackDefault++; callback({}); return; }
      counts.delegated++;
      listener(details, result => {
        if (result?.cancel === true) counts.originalCancelled++; else counts.originalAllowed++;
        callback(result);
      });
    });
    installed.add(owner); counts.sessions++;
  }
  return Object.freeze({ installSession,
    snapshot: () => ({ ...counts, blockedOrigins: [...blockedOrigins].sort() }),
    assertObserved(origins) {
      for (const origin of origins) assert.ok(blockedOrigins.has(origin), `fixture did not block ${origin}`);
      assert.ok(counts.registrations >= 1, 'actual Browser request listener was not registered');
      assert.ok(counts.loopbackDefault + counts.delegated >= 2, 'real loopback deadline/recovery requests were not observed');
    },
  });
}

function createMainOfflineFixture({ app, session, dialog,
  report = text => process.stderr.write(`${text}\n`) }) {
  assert.equal(app.isReady(), false, 'install Main fixture isolation before startup');
  const guard = createOfflineGuard();
  let phase = 'startup';
  app.on('session-created', guard.installSession);
  app.once('ready', () => guard.installSession(session.defaultSession));
  const timer = setTimeout(() => {
    report(`main integration timed out during ${phase}`);
    app.exit(1);
  }, MAIN_FIXTURE_DEADLINE_MS);
  app.once('quit', () => clearTimeout(timer));
  dialog.showErrorBox = (_title, message) => {
    report(`synthetic Main startup failed: ${String(message)}`);
    app.exit(1);
  };
  return Object.freeze({
    stage: value => { phase = value; },
    assertIsolation: origins => guard.assertObserved(origins),
    snapshot: guard.snapshot,
  });
}

module.exports = { createOfflineGuard, createMainOfflineFixture, MAIN_FIXTURE_DEADLINE_MS };
