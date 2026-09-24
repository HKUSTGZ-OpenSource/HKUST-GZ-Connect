'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const native = require('../../../renderer/features/integration-center/index.mjs');
const renderer = path.resolve(__dirname,'../../../renderer');
const preview = {schemaVersion:1,adapterId:'clash_mihomo_yaml',action:'copy',
  confirmationHandle:'export-'+'a'.repeat(32),expiresAt:2000,containsLocalProxyCredential:true,
  warningCodes:['INTEGRATION_LOCAL_CREDENTIAL_PRIVATE'],changes:{create:1,replace:0,remove:0,unchanged:0}};

test('native import is side-effect free and retired globals cannot return',()=>{
  assert.equal(Object.hasOwn(globalThis,'integrationCenter'),false);
  assert.deepEqual(Object.keys(native).sort(),['adapterView','create','createIntegrationCenter','previewView']);
  assert.equal(fs.existsSync(path.join(renderer,'integration-center.js')),false);
});

test('projection rejects invalid handles, actions, adapters, expiry and warning codes',()=>{
  for(const patch of [{confirmationHandle:'export-invalid'},{action:'install'},{adapterId:'unknown'},
    {expiresAt:1000},{containsLocalProxyCredential:'yes'},{warningCodes:['not-a-code']},{schemaVersion:2}]) {
    assert.equal(native.previewView({...preview,...patch},1000),null,JSON.stringify(patch));
  }
  for(const value of [null,[],{}, {...preview,action:'remove'}]) assert.equal(native.previewView(value,1000),null);
});

test('projection retains only display metadata and freezes nested projected values',()=>{
  const source={...preview,payload:'must-not-cross',targetFile:'/must-not-cross',accountKey:'must-not-cross'};
  const value=native.previewView(source,1000);
  assert.deepEqual(Object.keys(value).sort(),['action','adapterId','byteLength','changes','confirmationHandle',
    'containsLocalProxyCredential','expiresAt','ruleCount','warnings']);
  assert.equal(JSON.stringify(value).includes('must-not-cross'),false);
  assert.equal(Object.isFrozen(value),true);assert.equal(Object.isFrozen(value.changes),true);
  assert.equal(Object.isFrozen(value.warnings),true);
  const adapter=native.adapterView({schemaVersion:1,adapterId:'vscode_remote_ssh',compatibilityState:'supported',
    bindingState:'not-installed',supportedActions:['preview','copy'],updatedAt:null,targetFile:'/must-not-cross'});
  assert.deepEqual(adapter.supportedActions,['copy']);assert.equal(Object.hasOwn(adapter,'targetFile'),false);
  assert.equal(Object.isFrozen(adapter.supportedActions),true);
});

test('controller construction requires injected APIs but does not query or export on its own',async()=>{
  let calls=0;
  const node=()=>({dataset:{},children:[],textContent:'',addEventListener(){},append(...items){this.children.push(...items);},
    replaceChildren(...items){this.children=items;}});
  const nodes=new Map();
  const document={getElementById:id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node};
  const api={listIntegrations:async()=>{calls++;return {ok:true,integrations:[]};},
    prepareIntegration:async()=>{throw new Error('unexpected export');},confirmIntegration:async()=>{},cancelIntegration:async()=>{}};
  assert.throws(()=>native.createIntegrationCenter({api:{},document,translate:String}),/API is incomplete/);
  const owner=native.createIntegrationCenter({api,document,translate:String});assert.equal(calls,0);
  owner.start();assert.equal(calls,0);await owner.refresh();assert.equal(calls,1);
});

test('compatibility entry and native owners remain bounded and HTML loading is explicit',()=>{
  for(const [file,limit] of [['features/integration-center/lifecycle.mjs',80],['features/integration-center/model.mjs',80],
    ['features/integration-center/lifetime.mjs',80],
    ['features/integration-center/controller.mjs',250]]) {
    assert.ok(fs.readFileSync(path.join(renderer,file),'utf8').trimEnd().split('\n').length<=limit,file);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(renderer,'index.html'),'utf8'),/src="integration-center.js"/);
  const verifier=fs.readFileSync(path.resolve(renderer,'../build/verify-package.js'),'utf8');
  for(const name of ['index','model','controller','lifecycle','lifetime']) {
    assert.ok(verifier.includes(`/renderer/features/integration-center/${name}.mjs`));
  }
});
