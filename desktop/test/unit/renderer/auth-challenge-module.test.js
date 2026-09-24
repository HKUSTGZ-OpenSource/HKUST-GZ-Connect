'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const owner = require('../../../renderer/features/auth-challenge/index.mjs');
const i18n = require('../../../renderer/features/localization/index.mjs');

function fixture() {
  const elements = new Map(), handlers = new Map(), timers = new Map();
  let clock = 1000, sequence = 0, listener, resolveState;
  const calls = [];
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      value:'', textContent:'', hidden:false, disabled:false, open:false,
      addEventListener(type, callback) { handlers.set(id+':'+type,callback); },
      showModal() { this.open=true; }, close() { this.open=false; }, focus() {},
    });
    return elements.get(id);
  };
  const document = {documentElement:{lang:'en'},getElementById:get};
  const api = {
    onAuthChallenge(callback) { listener=callback; calls.push('subscribe'); return ()=>{}; },
    getState() { calls.push('snapshot'); return new Promise(resolve=>{resolveState=resolve;}); },
    respondAuthChallenge: async response => { calls.push(['respond',response,get('authChallengeResponse').value]); return {ok:true}; },
    resendAuthChallenge: async () => { calls.push('resend'); return {ok:true}; },
    cancelAuthChallenge: async () => { calls.push('cancel'); return {ok:true}; },
  };
  const options = {api,document,i18n,target:{addEventListener:(name,callback)=>handlers.set(name,callback)},
    now:()=>clock,setTimeoutFn:(callback,delay)=>{timers.set(++sequence,{callback,delay});return sequence;},
    clearTimeoutFn:id=>timers.delete(id)};
  return {get,calls,options,timers,clock:value=>{clock=value;},
    emit:value=>listener(value),resolve:value=>resolveState(value),
    dispatch:(id,type)=>handlers.get(type?id+':'+type:id)?.({preventDefault(){}})};
}
const challenge = {kind:'otp',maskedDestination:'s***@example.test',attemptsRemaining:3,
  expiresAtUnixMs:null,resendAfterUnixMs:null,resendAvailable:true};
const settle = () => new Promise(resolve=>setImmediate(resolve));

test('native entrypoint has no auto-start or global export and exposes only its declared API', () => {
  assert.deepEqual(Object.keys(owner).sort(),['MAX_RESPONSE_BYTES','createAuthChallengeFeature','start']);
  assert.equal(Object.hasOwn(globalThis,'authChallenge'),false);
  assert.equal(owner.MAX_RESPONSE_BYTES,4096);
  assert.equal(owner.start(),null);
});

test('startup subscribes before the snapshot and ignores a superseded initial snapshot', async () => {
  const f=fixture(); const feature=owner.start(f.options);
  assert.deepEqual(f.calls,['subscribe','snapshot']);
  f.emit(challenge); f.resolve({authChallenge:null}); await settle();
  assert.equal(f.get('authChallengeDialog').open,true);
  f.get('authChallengeResponse').value='synthetic'; f.dispatch('beforeunload');
  assert.equal(f.get('authChallengeResponse').value,'');
  feature.render(null);
});

test('startup restores an initial display challenge when no newer event exists', async () => {
  const f=fixture(); const feature=owner.start(f.options);
  f.resolve({authChallenge:challenge}); await settle();
  assert.equal(f.get('authChallengeDialog').open,true);
  assert.match(f.get('authChallengeDestination').textContent,/s\*\*\*@example\.test/);
  feature.render(null);
});

test('injected clock retains resend cooldown and expiry behavior', () => {
  const f=fixture(); const feature=owner.createAuthChallengeFeature(f.options);
  feature.render({...challenge,resendAfterUnixMs:2000,expiresAtUnixMs:3000});
  assert.equal(f.get('authChallengeResend').disabled,true);
  let timer=[...f.timers.values()][0]; assert.equal(timer.delay,1001);
  f.clock(2001); timer.callback();
  assert.equal(f.get('authChallengeResend').disabled,false);
  timer=[...f.timers.values()][0]; assert.equal(timer.delay,1000);
  f.clock(3001); timer.callback();
  assert.equal(f.get('authChallengeSubmit').disabled,true);
  assert.match(f.get('authChallengeError').textContent,/expired/i);
  assert.equal(f.timers.size,0); feature.render(null);
});

test('native submission retains byte limits, immediate input clearing and Escape cancellation', async () => {
  const f=fixture(); const feature=owner.createAuthChallengeFeature(f.options);
  feature.render(challenge);
  for (const value of ['', '界'.repeat(1400)]) {
    f.get('authChallengeResponse').value=value; f.dispatch('authChallengeForm','submit');
    assert.equal(f.get('authChallengeResponse').value,''); assert.equal(f.calls.length,0);
  }
  f.get('authChallengeResponse').value='synthetic-response'; f.dispatch('authChallengeForm','submit'); await settle();
  assert.deepEqual(f.calls,[['respond','synthetic-response','']]);
  f.get('authChallengeResponse').value='must-clear'; f.dispatch('authChallengeDialog','cancel'); await settle();
  assert.equal(f.get('authChallengeResponse').value,''); assert.equal(f.calls.at(-1),'cancel');
  feature.render(null);
});

test('legacy facade stays bounded instead of regaining authentication behavior', () => {
  const source=fs.readFileSync(path.resolve(__dirname,'../../../renderer/auth-challenge.js'),'utf8');
  assert.ok(source.trimEnd().split('\n').length<=12);
  assert.doesNotMatch(source,/function render|function updateActions|function run/);
});
