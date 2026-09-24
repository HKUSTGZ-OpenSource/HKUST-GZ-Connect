'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { accepted, retire, runChild } = require('../../../e2e/renderer-module-asar');

const passed = () => ({closed:true,code:0,output:'renderer native modules in ASAR: PASS'});
test('ASAR success requires the assertion marker, closed child and no execution failure', () => {
  assert.equal(accepted(passed()),true);
  for(const bad of [{closed:false},{code:1},{signal:'SIGTERM'},{timedOut:true},
    {launchError:true},{outputLimit:true},{interrupted:true},{output:''}]) assert.equal(accepted({...passed(),...bad}),false);
});

test('real child outcomes distinguish success, nonzero exit, timeout and byte-bounded output', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'asar-runner-unit-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const stage=path.join(root,'stage.js');
  fs.writeFileSync(stage,"console.log('renderer native modules in ASAR: PASS');");
  assert.equal(accepted(await runChild(process.execPath,root,{stage})),true);
  fs.writeFileSync(stage,"console.log('renderer native modules in ASAR: PASS');process.exitCode=7;");
  const failed=await runChild(process.execPath,root,{stage});
  assert.equal(failed.code,7); assert.equal(failed.closed,true); assert.equal(accepted(failed),false);
  fs.writeFileSync(stage,'setInterval(()=>{},1000);');
  const hung=await runChild(process.execPath,root,{stage,timeoutMs:100});
  assert.equal(hung.timedOut,true); assert.equal(hung.closed,true); assert.equal(accepted(hung),false);
  fs.writeFileSync(stage,"process.stdout.write('测'.repeat(400000));");
  const flood=await runChild(process.execPath,root,{stage});
  assert.equal(flood.outputLimit,true); assert.equal(flood.closed,true); assert.equal(accepted(flood),false);
  assert.ok(Buffer.byteLength(flood.output)<=1024*1024);
});
test('fixture retirement rejects changed identities and propagates cleanup failures', () => {
  const identity={dev:1,ino:2}; let removed=false;
  const fake={lstatSync:()=>({...identity,isDirectory:()=>true,isSymbolicLink:()=>false}),
    rmSync:()=>{removed=true;},existsSync:()=>false};
  retire('/synthetic-fixture',identity,fake); assert.equal(removed,true);
  removed=false;
  assert.throws(()=>retire('/synthetic-fixture',{dev:1,ino:3},fake),/identity changed/u);
  assert.equal(removed,false);
  assert.throws(()=>retire('/synthetic-fixture',identity,{...fake,rmSync:()=>{throw new Error('locked');}}),/locked/u);
  assert.throws(()=>retire('/synthetic-fixture',identity,{...fake,existsSync:()=>true}),/incomplete/u);
});
