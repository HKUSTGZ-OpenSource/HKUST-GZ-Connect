'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadPreload() {
  const source = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', '..', 'lib', 'browser', 'workspace', 'campus-workspace-preload.js',
  ), 'utf8');
  const listeners = new Map();
  const sends = [];
  let exposed = null;
  let nextTimer = 0;
  const timers = new Map();
  const ipcRenderer = {
    send(channel, payload) { sends.push({ channel, payload }); },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
  };
  vm.runInNewContext(source, {
    Date,
    Promise,
    clearTimeout(identity) { timers.delete(identity); },
    setTimeout(callback) {
      const identity = ++nextTimer;
      timers.set(identity, () => { timers.delete(identity); callback(); });
      return identity;
    },
    require(request) {
      assert.equal(request, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, 'campusWorkspace');
            exposed = value;
          },
        },
        ipcRenderer,
      };
    },
  }, { filename: 'campus-workspace-preload.js' });
  return { api: exposed, listeners, sends, timers };
}

function reply(fixture, sent, result) {
  fixture.listeners.get('campus-workspace-result')({}, {
    requestId: sent.payload.requestId,
    ...result,
  });
}

test('Workspace mutation request sends only a request identity and ID-only command', async () => {
  const fixture = loadPreload();
  const pending = fixture.api.request('toggle-favorite', {
    resourceId: 'canvas', url: 'https://must-not-cross.example/',
  });
  assert.equal(fixture.sends.length, 1);
  const sent = fixture.sends[0];
  assert.equal(sent.channel, 'campus-workspace-command');
  assert.match(sent.payload.requestId, /^workspace-[a-z0-9-]+$/u);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.payload.command)), {
    command: 'toggle-favorite', resourceId: 'canvas',
  });
  assert.equal(JSON.stringify(sent.payload).includes('must-not-cross'), false);
  reply(fixture, sent, { ok: true });
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    requestId: sent.payload.requestId, ok: true,
  });
});

test('concurrent Workspace results correlate by request identity out of order', async () => {
  const fixture = loadPreload();
  const first = fixture.api.request('create-group', { name: 'A' });
  const second = fixture.api.request('create-group', { name: 'B' });
  const [firstSent, secondSent] = fixture.sends;
  reply(fixture, secondSent, {
    ok: false,
    code: 'WORKSPACE_MUTATION_FAILED',
    error: 'second failed',
  });
  reply(fixture, firstSent, { ok: true });
  assert.equal((await first).requestId, firstSent.payload.requestId);
  assert.deepEqual(JSON.parse(JSON.stringify(await second)), {
    requestId: secondSent.payload.requestId,
    ok: false,
    code: 'WORKSPACE_MUTATION_FAILED',
    error: 'second failed',
  });
});

test('unknown and malformed stale results cannot settle a live request', async () => {
  const fixture = loadPreload();
  let settled = false;
  const pending = fixture.api.request('delete-group', { groupId: 'group_abcdefghijkl' });
  pending.then(() => { settled = true; });
  const sent = fixture.sends[0];
  fixture.listeners.get('campus-workspace-result')({}, {
    requestId: 'workspace-unknown', ok: true,
  });
  fixture.listeners.get('campus-workspace-result')({}, {
    requestId: sent.payload.requestId, ok: true, secret: 'must-not-cross',
  });
  await Promise.resolve();
  assert.equal(settled, false);
  reply(fixture, sent, {
    ok: false,
    code: 'WORKSPACE_MUTATION_STALE',
    error: 'retry from the latest state',
  });
  assert.equal((await pending).code, 'WORKSPACE_MUTATION_STALE');
});

test('request timeout resolves stale and a late result is ignored', async () => {
  const fixture = loadPreload();
  const pending = fixture.api.request('create-group', { name: 'Slow' });
  const sent = fixture.sends[0];
  assert.equal(fixture.timers.size, 1);
  [...fixture.timers.values()][0]();
  const result = await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    requestId: sent.payload.requestId,
    ok: false,
    code: 'WORKSPACE_MUTATION_STALE',
    error: '',
  });
  reply(fixture, sent, { ok: true });
  assert.equal(result.ok, false, 'late success cannot rewrite the settled stale outcome');
});

test('non-mutation request and invalid ID fail locally without crossing IPC', async () => {
  const fixture = loadPreload();
  assert.equal((await fixture.api.request('open-resource', { resourceId: 'canvas' })).ok, false);
  assert.equal((await fixture.api.request('toggle-favorite', { resourceId: '../canvas' })).ok, false);
  assert.equal(fixture.sends.length, 0);
});
