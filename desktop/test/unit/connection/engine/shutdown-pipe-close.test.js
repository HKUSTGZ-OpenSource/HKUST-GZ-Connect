'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { EngineSupervisor } = require('../../../../lib/connection/engine/engine-supervisor');
const { EngineConnectionRuntime } = require('../../../../lib/connection/engine/engine-connection-runtime');
const { EngineControlRegistry } = require('../../../../lib/connection/engine/engine-control-suite');

// Real local pipe/process only. No filesystem, credentials, sockets or school endpoint.
const CHILD = String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
send({type:'hello',apiVersion:1,capabilities:['password','l3']});
readline.createInterface({input:process.stdin}).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'hello') send({type:'control_hello',apiVersion:2,requestId:frame.requestId,capabilities:['engine.shutdown']});
  if (frame.command?.name === 'provider_capabilities') send({type:'provider_capabilities',apiVersion:2,
    requestId:frame.requestId,profileId:'synthetic',profileRevision:1,engineGeneration:1,
    compiled:{'auth.password':'supported'},provider:{'auth.password':'supported'}});
  if (frame.command?.name === 'shutdown') send({type:'control_result',apiVersion:2,requestId:frame.requestId,status:'accepted'});
});
process.on('message', value => { if (value?.type === 'finish') process.exit(value.code); });
`;

for (const code of [0, 7]) {
  test(`real retired-child shutdown waits beyond acknowledgement and preserves exit code ${code}`, {
    timeout: 10000,
  }, async t => {
    const supervisor = new EngineSupervisor({spawnProcess:spawn});
    const registry = new EngineControlRegistry({authChallenges:{bind(){},detach(){}}});
    const started = supervisor.start({command:process.execPath,args:['-e',CHILD],
      options:{stdio:['pipe','pipe','pipe','ipc'],windowsHide:true}});
    assert.equal(started.ok,true);
    const child = started.child, signals = [];
    const kill = child.kill.bind(child);
    child.kill = signal => { signals.push(signal || 'SIGTERM'); return kill(signal); };
    let runtime;
    t.after(async () => {
      runtime?.dispose(); registry.clear();
      if (child.exitCode === null && child.signalCode === null) kill('SIGKILL');
      let timer;
      try {
        await Promise.race([started.closed,new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('owned fixture child did not close')),3000);
        })]);
      } finally { clearTimeout(timer); }
    });
    runtime = new EngineConnectionRuntime({generation:started.generation,contextToken:{},expectedPort:6180,
      stdin:child.stdin,controlRegistry:registry,isCurrent:g=>supervisor.isCurrent(g)});
    runtime.start(child.stdout);
    await registry.active.client.handshake();
    supervisor.invalidate();
    let acknowledge, settled=false;
    const ack = new Promise(resolve=>{acknowledge=resolve;});
    const stopping = supervisor.stop({requestGracefulStop:()=>registry.shutdown().then(value=>{
      acknowledge(); return value;
    })});
    stopping.then(()=>{settled=true;});
    assert.equal(await Promise.race([ack.then(()=>'ack'),stopping.then(()=>'closed-before-ack')]),'ack');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false,'an acknowledgement is not process cleanup');
    assert.equal(supervisor.hasActive,true);
    assert.equal(child.exitCode,null);
    child.send({type:'finish',code});
    const result = await stopping;
    assert.equal(result.ok,true);
    assert.equal(result.phase,'control','valid acknowledgement must not fall back to signals');
    assert.equal(result.cleanExit,code===0,'nonzero exit must still block automatic recovery');
    assert.equal(supervisor.hasActive,false);
    assert.deepEqual(signals,[]);
    assert.equal((await started.closed).code,code);
  });
}
