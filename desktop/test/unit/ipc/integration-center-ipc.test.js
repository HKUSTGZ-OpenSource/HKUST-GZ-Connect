'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  confirmIntegrationRequest,
  prepareIntegrationRequest,
  registerIntegrationCenterIpc,
} = require('../../../lib/ipc/integration-center-ipc');

function fixture(overrides = {}) {
  const handlers = new Map();
  const calls = [];
  const runtime = {
    list: () => [{ adapterId: 'clash_mihomo_yaml' }],
    prepare: async (value) => { calls.push(['prepare', value]); return { confirmationHandle: 'export-1' }; },
    confirm: async (value) => { calls.push(['confirm', value]); return { ok: true }; },
    cancel: (...args) => { calls.push(['cancel', ...args]); return true; },
    ...overrides,
  };
  registerIntegrationCenterIpc({
    register: (channel, handler) => handlers.set(channel, handler), runtime,
  });
  return { handlers, calls };
}

test('IPC registers four exact channels and accepts only closed adapter action handles', async () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()], [
    'list-integrations', 'prepare-integration', 'confirm-integration', 'cancel-integration',
  ]);
  assert.deepEqual(prepareIntegrationRequest({ adapterId: 'clash_mihomo_yaml', action: 'copy' }), {
    adapterId: 'clash_mihomo_yaml', action: 'copy',
  });
  assert.throws(() => prepareIntegrationRequest({
    adapterId: 'clash_mihomo_yaml', action: 'copy', targetFile: '/forbidden',
  }), /未知字段/u);
  assert.throws(() => prepareIntegrationRequest({ adapterId: 'shell', action: 'launch' }),
    /集成类型/u);
  assert.throws(() => prepareIntegrationRequest({
    adapterId: 'clash_verge_rev_managed', action: 'install',
  }), /集成类型/u);
  assert.deepEqual(confirmIntegrationRequest({ confirmationHandle: ' managed-1 ' }), {
    confirmationHandle: 'managed-1',
  });
  assert.equal((await f.handlers.get('prepare-integration')({}, {
    adapterId: 'clash_mihomo_yaml', action: 'copy',
  })).ok, true);
  assert.equal((await f.handlers.get('confirm-integration')({}, {
    confirmationHandle: 'export-1',
  })).ok, true);
  assert.deepEqual(f.handlers.get('cancel-integration')(), { ok: true, cancelled: true });
});

test('optional cancellation handle is validated without falling back to global cancellation',()=>{
  const f=fixture();
  for(const value of [null,{},[],{confirmationHandle:''},{confirmationHandle:'x'.repeat(65)},
    {confirmationHandle:'valid',targetFile:'/forbidden'}, {confirmationHandle:undefined}]) {
    assert.deepEqual(f.handlers.get('cancel-integration')({},value),{ok:false,code:'INTEGRATION_EXPORT_FAILED'});
  }
  assert.deepEqual(f.calls,[]);
  assert.deepEqual(f.handlers.get('cancel-integration')({},{confirmationHandle:'export-123'}),
    {ok:true,cancelled:true});
  assert.deepEqual(f.calls,[['cancel','export-123']]);
  assert.deepEqual(f.handlers.get('cancel-integration')(),{ok:true,cancelled:true});
  assert.deepEqual(f.calls.at(-1),['cancel']);
});

test('scoped cancellation returns no sensitive error details and exposes nonmatching no-op',()=>{
  const failed=fixture({cancel:()=>{throw new Error('synthetic private target');}});
  assert.deepEqual(failed.handlers.get('cancel-integration')({},{confirmationHandle:'export-123'}),
    {ok:false,code:'INTEGRATION_EXPORT_FAILED'});
  const absent=fixture({cancel:()=>false});
  assert.deepEqual(absent.handlers.get('cancel-integration')({},{confirmationHandle:'export-123'}),
    {ok:true,cancelled:false});
});

test('errors collapse to stable value-free codes and never return paths or payloads', async () => {
  const failure = new Error('/Users/student/private.yaml');
  failure.code = 'INTEGRATION_TARGET_CHANGED';
  const f = fixture({
    list: () => { throw failure; },
    prepare: async () => { throw failure; },
    confirm: async () => { throw new Error('secret payload'); },
  });
  assert.deepEqual(f.handlers.get('list-integrations')(), {
    ok: false, code: 'INTEGRATION_TARGET_CHANGED', integrations: [],
  });
  assert.deepEqual(await f.handlers.get('prepare-integration')({}, {
    adapterId: 'clash_mihomo_yaml', action: 'copy',
  }), { ok: false, code: 'INTEGRATION_TARGET_CHANGED' });
  assert.deepEqual(await f.handlers.get('confirm-integration')({}, {
    confirmationHandle: 'export-1',
  }), { ok: false, code: 'INTEGRATION_EXPORT_FAILED' });
});
