'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {IntegrationCenterRuntime} = require('../../../lib/integrations/integration-center-runtime');
const {createGenericExportCoordinator} = require('../../../lib/integrations/generic-export-coordinator');
const {createIntegrationBinding} = require('../../../lib/integrations/integration-schema');
const {createProfileNetworkRules} = require('../../../lib/integrations/profile-network-rules');
const rules=createProfileNetworkRules({profileDocument:JSON.parse(fs.readFileSync(
  path.resolve(__dirname,'../../../assets/profiles/hkustgz/school-profile.json'),'utf8'))});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture() {
  const writes=[],borrowed=[],patch={activeContextEpoch:1};let entropy=0;
  const target=path.resolve('synthetic-export.yaml');
  const fileTransaction={inspect:(targetFile,payload)=>{borrowed.push(payload);return {targetFile,change:'create',before:{bytes:0}};},
    apply:(plan,payload,validate)=>{assert.equal(validate(payload),true);writes.push(['save',plan.targetFile]);}};
  const coordinator=createGenericExportCoordinator({fileTransaction,
    writeClipboard:()=>{writes.push(['copy']);return true;},randomBytes:size=>Buffer.alloc(size,++entropy)});
  const getContext=()=>{const state={...patch};return {networkRules:rules,port:6180,
    credential:{withStrings:callback=>callback('A'.repeat(32),'B'.repeat(32))},
    bindingFor:adapterId=>createIntegrationBinding({adapterId,adapterVersion:1,
      profileId:rules.profileId,profileRevision:rules.profileRevision,profileCredentialBindingRevision:rules.profileCredentialBindingRevision,
      accountKey:'account-'+'a'.repeat(32),accountRevision:1,accountCredentialRevision:1,
      workspaceKey:'workspace-'+'b'.repeat(32),activeContextEpoch:state.activeContextEpoch,
      listenerKind:'socks5-authenticated',loopbackHost:'127.0.0.1',loopbackPort:6180,proxySecurityRevision:3,
      credentialRef:'credential-'+'c'.repeat(32),networkRulesDigest:rules.rulesDigest,pacDigest:'d'.repeat(64),engineGeneration:1,recordRevision:1})};};
  const runtime=new IntegrationCenterRuntime({getContext,selectTarget:async()=>target,genericCoordinator:coordinator,
    helperPath:path.resolve('synthetic-proxy-command'),credentialFile:path.resolve('synthetic-credential')});
  return {runtime,coordinator,writes,borrowed,patch,target,prepare:action=>runtime.prepare({adapterId:'clash_mihomo_yaml',action})};
}

test('cancelled file selection cannot resurrect a prepared export',async()=>{
  const f=fixture(), gate=deferred();f.runtime.selectTarget=()=>gate.promise;
  const work=f.prepare('save');f.runtime.cancel();gate.resolve(f.target);
  await assert.rejects(work,{code:'INTEGRATION_TARGET_CHANGED'});
  assert.equal(f.coordinator.transactionOwner.snapshot(),null);assert.deepEqual(f.writes,[]);
});
test('an older file selection cannot replace a newer preview',async()=>{
  const f=fixture(), gate=deferred();f.runtime.selectTarget=()=>gate.promise;
  const old=f.prepare('save'), next=await f.prepare('copy');gate.resolve(f.target);
  await assert.rejects(old,{code:'INTEGRATION_TARGET_CHANGED'});
  assert.equal(f.coordinator.transactionOwner.snapshot().confirmationHandle,next.confirmationHandle);
  await f.runtime.confirm(next);assert.deepEqual(f.writes,[['copy']]);
});
test('context is revalidated after the native target dialog',async()=>{
  const f=fixture(), gate=deferred();f.runtime.selectTarget=()=>gate.promise;
  const work=f.prepare('save');f.patch.activeContextEpoch=2;gate.resolve(f.target);
  await assert.rejects(work,{code:'INTEGRATION_PROFILE_STALE'});
  assert.equal(f.coordinator.transactionOwner.snapshot(),null);assert.equal(f.borrowed.length,0);
});
test('a failed older confirmation cannot clear a newer prepared export',async()=>{
  const f=fixture(), gate=deferred(),entered=deferred();
  f.coordinator.beforePerform=()=>{entered.resolve();return gate.promise;};
  const old=await f.prepare('copy'),work=f.runtime.confirm(old);await entered.promise;
  const next=await f.prepare('copy');gate.reject(new Error('synthetic preparation failure'));
  await assert.rejects(work,{code:'INTEGRATION_EXPORT_FAILED'});
  assert.equal(f.coordinator.transactionOwner.snapshot()?.confirmationHandle,next.confirmationHandle);
  f.coordinator.beforePerform=()=>{};await f.runtime.confirm(next);assert.deepEqual(f.writes,[['copy']]);
});
for (const action of ['copy','save']) for (const reason of ['cancel','context']) {
  test(`${reason} during pre-export preparation prevents ${action} and erases borrowed payload`,async()=>{
    const f=fixture(), gate=deferred(),entered=deferred();
    f.coordinator.beforePerform=()=>{entered.resolve();return gate.promise;};
    const preview=await f.prepare(action),work=f.runtime.confirm(preview);await entered.promise;
    if(reason==='cancel') f.runtime.cancel();else f.patch.activeContextEpoch=2;
    gate.resolve();await assert.rejects(work,{code:reason==='cancel'?'INTEGRATION_TARGET_CHANGED':'INTEGRATION_PROFILE_STALE'});
    assert.deepEqual(f.writes,[]);assert.ok(f.borrowed.every(buffer=>buffer.every(byte=>byte===0)));
    if(action==='save') assert.equal(f.borrowed.length,1,'the zeroization assertion must observe a payload');
  });
}
test('cancellation after the synchronous commit boundary is not misreported as rollback',async()=>{
  const f=fixture();f.coordinator.writeClipboard=()=>{f.writes.push(['copy']);f.runtime.cancel();return true;};
  const preview=await f.prepare('copy');assert.equal((await f.runtime.confirm(preview)).ok,true);
  assert.deepEqual(f.writes,[['copy']]);
});

test('handle-scoped internal cleanup leaves a newer preview intact; global cancel still clears it',async()=>{
  const f=fixture(),old=await f.prepare('copy'),next=await f.prepare('copy');
  assert.equal(f.coordinator.cancel(old.confirmationHandle),false);
  assert.equal(f.coordinator.transactionOwner.snapshot().confirmationHandle,next.confirmationHandle);
  assert.equal(f.coordinator.cancel(next.confirmationHandle),true);
  assert.equal(f.coordinator.transactionOwner.snapshot(),null);
  await f.prepare('copy');assert.equal(f.runtime.cancel(),true);assert.equal(f.coordinator.transactionOwner.snapshot(),null);
});

test('a failed replacement target selection keeps the previous valid preview usable',async()=>{
  const f=fixture(),old=await f.prepare('copy');f.runtime.selectTarget=async()=>null;
  await assert.rejects(f.prepare('save'),{code:'INTEGRATION_EXPORT_CANCELLED'});
  assert.equal(f.coordinator.transactionOwner.snapshot().confirmationHandle,old.confirmationHandle);
  assert.equal((await f.runtime.confirm(old)).ok,true);assert.deepEqual(f.writes,[['copy']]);
});

test('a newer prepare revokes an older confirmation before its write without losing its own record',async()=>{
  const f=fixture(),gate=deferred(),entered=deferred();
  f.coordinator.beforePerform=()=>{entered.resolve();return gate.promise;};
  const first=await f.prepare('copy'),work=f.runtime.confirm(first);await entered.promise;
  const next=await f.prepare('copy');gate.resolve();await assert.rejects(work,{code:'INTEGRATION_TARGET_CHANGED'});
  assert.deepEqual(f.writes,[]);assert.equal(f.coordinator.transactionOwner.snapshot().confirmationHandle,next.confirmationHandle);
  f.coordinator.beforePerform=()=>{};await f.runtime.confirm(next);assert.deepEqual(f.writes,[['copy']]);
});

test('unverifiable context after target selection fails closed without constructing payload',async()=>{
  const f=fixture(),gate=deferred();f.runtime.selectTarget=()=>gate.promise;
  const work=f.prepare('save');f.runtime.getContext=()=>{throw new Error('synthetic context unavailable');};gate.resolve(f.target);
  await assert.rejects(work,{code:'INTEGRATION_PROFILE_STALE'});assert.equal(f.borrowed.length,0);assert.deepEqual(f.writes,[]);
});

test('retirement during synchronous prepare cannot publish its newly allocated record',async()=>{
  const f=fixture(),prepare=f.coordinator.prepare.bind(f.coordinator);
  f.coordinator.prepare=value=>{f.runtime.cancel();return prepare(value);};
  await assert.rejects(f.prepare('save'),{code:'INTEGRATION_TARGET_CHANGED'});
  assert.equal(f.coordinator.transactionOwner.snapshot(),null);assert.equal(f.borrowed.length,1);
  assert.ok(f.borrowed[0].every(byte=>byte===0));assert.deepEqual(f.writes,[]);
});

test('retirement while reading confirmation context prevents consuming a replacement record',async()=>{
  const f=fixture(), old=await f.prepare('copy'), read=f.runtime.getContext;
  let next,once=true;
  f.runtime.getContext=()=>{
    if(once){once=false;next=f.prepare('copy');}
    return read();
  };
  await assert.rejects(f.runtime.confirm(old),{code:'INTEGRATION_TARGET_CHANGED'});
  const preview=await next;
  assert.equal(f.coordinator.transactionOwner.snapshot().confirmationHandle,preview.confirmationHandle);
  await f.runtime.confirm(preview);assert.deepEqual(f.writes,[['copy']]);
});

test('a duplicate confirmation without pending material cannot revoke the accepted operation',async()=>{
  const f=fixture(),gate=deferred(),entered=deferred();f.coordinator.beforePerform=()=>{entered.resolve();return gate.promise;};
  const preview=await f.prepare('copy'),accepted=f.runtime.confirm(preview);await entered.promise;
  await assert.rejects(f.runtime.confirm(preview),{code:'INTEGRATION_TARGET_CHANGED'});
  gate.resolve();assert.equal((await accepted).ok,true);assert.deepEqual(f.writes,[['copy']]);
});

test('the coordinator requires an explicit synchronous authority guard before consuming a handle',async()=>{
  const f=fixture(),preview=await f.prepare('copy');
  for(const assertCurrent of [undefined,null,async()=>{}]) {
    assert.throws(()=>f.coordinator.confirm({confirmationHandle:preview.confirmationHandle,
      currentBinding:f.runtime.getContext().bindingFor('clash_mihomo_yaml',1),assertCurrent}),/synchronous export authority guard/);
  }
  assert.equal(f.coordinator.transactionOwner.snapshot().confirmationHandle,preview.confirmationHandle);
  await f.runtime.confirm(preview);assert.deepEqual(f.writes,[['copy']]);
});

test('promise-returning authority checks cannot silently authorize an export',async()=>{
  const f=fixture(),preview=await f.prepare('copy');
  assert.throws(()=>f.coordinator.confirm({confirmationHandle:preview.confirmationHandle,
    currentBinding:f.runtime.getContext().bindingFor('clash_mihomo_yaml',1),
    assertCurrent:()=>Promise.reject(new Error('synthetic asynchronous check'))}),/must return synchronously/);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.coordinator.transactionOwner.snapshot(),null);assert.deepEqual(f.writes,[]);
});

test('retired preview cancellation cannot consume a replacement preview',async()=>{
  const f=fixture(),old=await f.prepare('copy'),next=await f.prepare('copy');
  for(const value of [old.confirmationHandle,null,{},'', 'export-'+'f'.repeat(32)]) {
    assert.equal(f.runtime.cancel(value),false);
    assert.equal(f.coordinator.transactionOwner.snapshot()?.confirmationHandle,next.confirmationHandle);
  }
  assert.equal((await f.runtime.confirm(next)).ok,true);assert.deepEqual(f.writes,[['copy']]);
});

test('matching preview cancellation clears only its material and zeroes its payload',async()=>{
  const f=fixture(),preview=await f.prepare('save');
  assert.equal(f.runtime.cancel(preview.confirmationHandle),true);
  assert.equal(f.runtime.cancel(preview.confirmationHandle),false);
  assert.equal(f.coordinator.transactionOwner.snapshot(),null);
  assert.equal(f.borrowed.length,1);assert.ok(f.borrowed[0].every(byte=>byte===0));
  await assert.rejects(f.runtime.confirm(preview),{code:'INTEGRATION_TARGET_CHANGED'});
  assert.deepEqual(f.writes,[]);
});

test('cancelling the old preview does not invalidate a newer native target selection',async()=>{
  const f=fixture(),old=await f.prepare('copy'),gate=deferred();f.runtime.selectTarget=()=>gate.promise;
  const work=f.prepare('save');assert.equal(f.runtime.cancel(old.confirmationHandle),true);
  gate.resolve(f.target);const next=await work;
  assert.equal((await f.runtime.confirm(next)).ok,true);assert.deepEqual(f.writes,[['save',f.target]]);
});

for(const action of ['copy','save']) {
  test(`scoped cancellation alone revokes accepted ${action} before commit and permits a later export`,async()=>{
    const f=fixture(),gate=deferred(),entered=deferred(),target=deferred();
    f.coordinator.beforePerform=()=>{entered.resolve();return gate.promise;};
    const preview=await f.prepare(action),work=f.runtime.confirm(preview);await entered.promise;
    assert.equal(f.runtime.cancel(preview.confirmationHandle),true);
    assert.equal(f.runtime.cancel(preview.confirmationHandle),false);
    gate.resolve();await assert.rejects(work,{code:'INTEGRATION_TARGET_CHANGED'});
    assert.deepEqual(f.writes,[]);
    if(action==='save') {assert.equal(f.borrowed.length,1);assert.ok(f.borrowed[0].every(byte=>byte===0));}
    f.runtime.selectTarget=()=>target.promise;const nextWork=f.prepare('save');
    target.resolve(f.target);const next=await nextWork;
    f.coordinator.beforePerform=()=>{};assert.equal((await f.runtime.confirm(next)).ok,true);
    assert.deepEqual(f.writes,[['save',f.target]]);
  });
}

test('old confirmation cleanup and scoped cancellation cannot revoke a newer accepted confirmation',async()=>{
  const f=fixture(),oldGate=deferred(),oldEntered=deferred(),nextGate=deferred(),nextEntered=deferred();
  f.coordinator.beforePerform=()=>{oldEntered.resolve();return oldGate.promise;};
  const old=await f.prepare('copy'),oldWork=f.runtime.confirm(old);await oldEntered.promise;
  f.coordinator.beforePerform=()=>{nextEntered.resolve();return nextGate.promise;};
  const next=await f.prepare('copy'),nextWork=f.runtime.confirm(next);await nextEntered.promise;
  assert.equal(f.runtime.cancel(old.confirmationHandle),false);
  oldGate.resolve();await assert.rejects(oldWork,{code:'INTEGRATION_TARGET_CHANGED'});
  nextGate.resolve();assert.equal((await nextWork).ok,true);assert.deepEqual(f.writes,[['copy']]);
});

test('scoped cancellation of an older accepted export preserves a newer target-selection intent',async()=>{
  const f=fixture(),gate=deferred(),entered=deferred(),target=deferred();
  f.coordinator.beforePerform=()=>{entered.resolve();return gate.promise;};
  const old=await f.prepare('copy'),oldWork=f.runtime.confirm(old);await entered.promise;
  f.runtime.selectTarget=()=>target.promise;const nextWork=f.prepare('save');
  assert.equal(f.runtime.cancel(old.confirmationHandle),true);
  gate.resolve();await assert.rejects(oldWork,{code:'INTEGRATION_TARGET_CHANGED'});
  target.resolve(f.target);const next=await nextWork;f.coordinator.beforePerform=()=>{};
  assert.equal((await f.runtime.confirm(next)).ok,true);assert.deepEqual(f.writes,[['save',f.target]]);
});
