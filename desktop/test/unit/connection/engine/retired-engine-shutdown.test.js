'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EngineConnectionRuntime } = require('../../../../lib/connection/engine/engine-connection-runtime');
const { EngineControlRegistry } = require('../../../../lib/connection/engine/engine-control-suite');
const bytes = value => Buffer.from(JSON.stringify(value)+'\n');
const accepted = id => bytes({type:'control_result',apiVersion:2,requestId:id,status:'accepted'});
function fixture(t) {
  let current=true; const frames=[],calls=[];
  const registry=new EngineControlRegistry({authChallenges:{bind(){},detach(){}}});
  const writable={write(data,done){frames.push(JSON.parse(data.toString()));done?.();return true;}};
  const runtime=new EngineConnectionRuntime({generation:1,contextToken:{},expectedPort:6180,
    stdin:writable,controlRegistry:registry,isCurrent:()=>current,
    handlers:{onDiagnostic:e=>calls.push(e),onConnectionCandidate:()=>calls.push('ready')}});
  const client=registry.active.client;client.v2.negotiated=true;
  t.after(()=>{runtime.dispose();registry.clear();});
  return {runtime,registry,client,writable,frames,calls,retire:()=>{current=false;}};
}
test('owned shutdown acknowledgement survives generation invalidation, including fragmented replies',async t=>{
  const f=fixture(t),work=f.registry.shutdown();work.catch(()=>{});
  const reply=accepted(f.frames.at(-1).requestId);
  f.runtime.feed(reply.subarray(0,12));f.retire();f.runtime.feed(reply.subarray(12));
  assert.equal(f.client.v2.pending.size,0,'the outstanding shutdown must not time out after its ack arrived');
  assert.equal(await work,true);assert.deepEqual(f.calls,[]);
});
test('retired pipe ignores readiness, authentication and non-shutdown replies',async t=>{
  const f=fixture(t);let authFeeds=0;f.client.auth.feed=()=>{authFeeds++;};
  const query=f.client.providerCapabilities();query.catch(()=>{});const queryId=f.frames.at(-1).requestId;
  const stop=f.registry.shutdown();stop.catch(()=>{});const stopId=f.frames.at(-1).requestId;
  f.retire();
  f.runtime.feed(bytes({type:'provider_capabilities',apiVersion:2,requestId:queryId,profileId:'synthetic',profileRevision:1,
    engineGeneration:1,compiled:{'auth.password':'supported'},provider:{'auth.password':'supported'}}));
  f.runtime.feed(bytes({type:'auth_cancelled',apiVersion:3,requestId:1}));
  f.runtime.feed(bytes({type:'state_changed',apiVersion:1,generation:1,state:'connected'}));
  f.runtime.feed(accepted(stopId+100));
  assert.equal(f.client.v2.pending.size,2);assert.equal(authFeeds,0);assert.deepEqual(f.calls,[]);
  f.runtime.feed(accepted(stopId));assert.equal(await stop,true);
  assert.equal(f.client.v2.pending.has(queryId),true,'ordinary pending queries remain unacknowledged');
});
test('a retired child cannot acknowledge the replacement child shutdown request',async t=>{
  const f=fixture(t),old=f.registry.shutdown();old.catch(()=>{});f.retire();
  const next=f.registry.bind(2,f.writable,{});next.v2.negotiated=true;
  const work=f.registry.shutdown();work.catch(()=>{});const id=f.frames.at(-1).requestId;
  f.runtime.feed(accepted(id));assert.equal(next.v2.pending.size,1);
  next.feed(accepted(id));assert.equal(await work,true);await assert.rejects(old,/closed/);
});
test('retired shutdown errors remain failures rather than being converted to clean stop',async t=>{
  const f=fixture(t),work=f.registry.shutdown();work.catch(()=>{});f.retire();
  f.runtime.feed(bytes({type:'control_error',apiVersion:2,requestId:f.frames.at(-1).requestId,error:{code:'shutdown_failed'}}));
  assert.equal(f.client.v2.pending.size,0);await assert.rejects(work,{code:'shutdown_failed'});
});
