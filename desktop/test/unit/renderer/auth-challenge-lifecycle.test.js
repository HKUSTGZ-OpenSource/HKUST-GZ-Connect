'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {createAuthChallengeFeature} = require('../../../renderer/features/auth-challenge/index.mjs');
const i18n = require('../../../renderer/features/localization/index.mjs');
const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const settle = () => new Promise(resolve=>setImmediate(resolve));
const CHALLENGE = {kind:'otp',maskedDestination:'s***@example.test',attemptsRemaining:3,
  expiresAtUnixMs:null,resendAfterUnixMs:null,resendAvailable:true};

function harness(overrides={}, autoStart=true) {
  const listeners=new Set(), timers=new Map(), nodes=new Map(), subscriptions=new Set(), calls=[];
  let clock=1000, timerId=0;
  const target=()=>({
    value:'',textContent:'',hidden:false,disabled:false,open:false,
    addEventListener(type,callback){listeners.add({node:this,type,callback});},
    removeEventListener(type,callback){for(const item of listeners) if(item.node===this&&item.type===type&&item.callback===callback) listeners.delete(item);},
    dispatch(type){for(const item of [...listeners]) if(item.node===this&&item.type===type)item.callback({preventDefault(){}});},
    showModal(){this.open=true;},close(){this.open=false;},focus(){},
  });
  const get=id=>{if(!nodes.has(id))nodes.set(id,target());return nodes.get(id);};
  const doc={...target(),documentElement:{lang:'en'},getElementById:get};
  const eventTarget=target(); const initial=deferred();
  const api={
    getState:()=>initial.promise,
    onAuthChallenge:callback=>{subscriptions.add(callback);return ()=>subscriptions.delete(callback);},
    respondAuthChallenge:async value=>{calls.push(['respond',value,get('authChallengeResponse').value]);return {ok:true};},
    resendAuthChallenge:async()=>{calls.push(['resend']);return {ok:true};},
    cancelAuthChallenge:async()=>{calls.push(['cancel']);return {ok:true};},...overrides,
  };
  const options={document:doc,target:eventTarget,api,i18n,now:()=>clock,
    setTimeoutFn:(callback,delay)=>{const id=timerId++;timers.set(id,{callback,delay});return id;},
    clearTimeoutFn:id=>timers.delete(id)};
  const feature=createAuthChallengeFeature(options);
  if(autoStart) feature.start?.();
  const send=()=>{get('authChallengeResponse').value='synthetic-response';get('authChallengeForm').dispatch('submit');};
  return {feature,options,get,send,initial,listeners,timers,subscriptions,calls,api,eventTarget,clock:value=>{clock=value;}};
}

test('older command failure cannot paint or unlock a replacement challenge', async t=>{
  const old=deferred(), current=deferred(); let count=0;
  const h=harness({respondAuthChallenge:()=>++count===1?old.promise:current.promise});t.after(()=>h.feature.dispose?.());
  h.feature.render(CHALLENGE);h.send();
  h.feature.render({...CHALLENGE,kind:'captcha'});h.send();
  old.resolve({ok:false,code:'challenge_expired'});await settle();
  assert.equal(h.get('authChallengeError').textContent,'');
  assert.equal(h.get('authChallengeSubmit').disabled,true);
  current.resolve({ok:true});await settle();assert.equal(h.get('authChallengeSubmit').disabled,false);
});

test('a late rejected command cannot restore an error after the challenge clears', async t=>{
  const pending=deferred();const h=harness({respondAuthChallenge:()=>pending.promise});t.after(()=>h.feature.dispose?.());
  h.feature.render(CHALLENGE);h.send();h.feature.render(null);pending.reject(new Error('synthetic failure'));await settle();
  assert.equal(h.get('authChallengeDialog').open,false);assert.equal(h.get('authChallengeError').textContent,'');
  assert.equal(h.get('authChallengeDestination').textContent,'');assert.equal(h.get('authChallengeAttempts').textContent,'');
});

test('dispose owns all listeners, subscriptions, zero-id timer and displayed data', async()=>{
  const h=harness();h.feature.render({...CHALLENGE,expiresAtUnixMs:5000});
  h.get('authChallengeResponse').value='must-clear';
  const callbacks=[...h.subscriptions], staleTimers=[...h.timers.values()];
  h.feature.dispose?.();
  assert.equal(h.listeners.size,0);assert.equal(h.subscriptions.size,0);assert.equal(h.timers.size,0);
  assert.equal(h.get('authChallengeResponse').value,'');assert.equal(h.get('authChallengeDestination').textContent,'');
  assert.equal(h.get('authChallengeDialog').open,false);
  for(const callback of callbacks) callback(CHALLENGE);
  for(const timer of staleTimers) timer.callback();
  h.initial.resolve({authChallenge:CHALLENGE});await settle();h.feature.render(CHALLENGE);h.send();
  assert.equal(h.get('authChallengeDialog').open,false);assert.equal(h.calls.length,0);
  assert.equal(h.feature.start(),false);assert.equal(h.feature.dispose(),false);
});

test('expired, cooling-down and unsupported synthetic actions never reach Main', async t=>{
  const h=harness();t.after(()=>h.feature.dispose?.());
  h.feature.render({...CHALLENGE,expiresAtUnixMs:500});h.send();h.get('authChallengeResend').dispatch('click');
  h.feature.render({...CHALLENGE,resendAfterUnixMs:5000});h.get('authChallengeResend').dispatch('click');
  h.feature.render({...CHALLENGE,kind:'future-kind'});h.send();h.get('authChallengeResend').dispatch('click');
  await settle();assert.equal(h.calls.length,0);assert.equal(h.get('authChallengeResponse').value,'');
  h.get('authChallengeCancel').dispatch('click');await settle();assert.deepEqual(h.calls,[['cancel']]);
});

test('start is idempotent and snapshot completion cannot revive a disposed owner', async()=>{
  const h=harness();const size=h.listeners.size;
  assert.equal(h.feature.start(),true);assert.equal(h.listeners.size,size);assert.equal(h.subscriptions.size,1);
  h.feature.dispose();h.initial.resolve({authChallenge:CHALLENGE});await settle();
  assert.equal(h.get('authChallengeDialog').open,false);assert.equal(h.listeners.size,0);
});

test('partial event binding failure retires bindings already registered',()=>{
  const h=harness({},false), form=h.get('authChallengeForm'), add=form.addEventListener;
  form.addEventListener=function(...args){add.apply(this,args);throw new Error('synthetic bind failure');};
  assert.throws(()=>h.feature.start(),/bind failure/);assert.equal(h.listeners.size,0);
  assert.equal(h.subscriptions.size,0);assert.equal(h.feature.start(),false);
});

test('retirement during subscription cleans a handle returned after disposal',()=>{
  const h=harness({},false);
  h.api.onAuthChallenge=callback=>{h.feature.dispose();h.subscriptions.add(callback);return()=>h.subscriptions.delete(callback);};
  assert.throws(()=>h.feature.start(),/retired/);assert.equal(h.listeners.size,0);assert.equal(h.subscriptions.size,0);
});

test('subscription without cleanup is rejected and its retained callback becomes inert',()=>{
  const h=harness({},false);let callback;
  h.api.onAuthChallenge=value=>{callback=value;};
  assert.throws(()=>h.feature.start(),/cleanup/);callback(CHALLENGE);
  assert.equal(h.get('authChallengeDialog').open,false);assert.equal(h.listeners.size,0);
});

test('unsubscribe failure does not prevent sensitive field, timer and DOM cleanup',()=>{
  const h=harness({},false);
  h.api.onAuthChallenge=callback=>{h.subscriptions.add(callback);return()=>{h.subscriptions.delete(callback);throw new Error('synthetic cleanup failure');};};
  h.feature.start();h.feature.render({...CHALLENGE,expiresAtUnixMs:5000});h.get('authChallengeResponse').value='must-clear';
  assert.throws(()=>h.feature.dispose(),AggregateError);
  assert.equal(h.listeners.size,0);assert.equal(h.timers.size,0);assert.equal(h.get('authChallengeResponse').value,'');
  assert.equal(h.get('authChallengeDialog').open,false);assert.equal(h.feature.dispose(),false);
});

test('cancelled timer callbacks cannot disturb the replacement challenge timer', t=>{
  const h=harness();t.after(()=>h.feature.dispose());h.feature.render({...CHALLENGE,expiresAtUnixMs:5000});
  const old=[...h.timers.values()][0];h.feature.render({...CHALLENGE,expiresAtUnixMs:9000});
  const current=[...h.timers];old.callback();assert.deepEqual([...h.timers],current);
});

test('late callbacks and public methods from a retired owner cannot erase a new owner',async()=>{
  const pending=deferred();const h=harness({respondAuthChallenge:()=>pending.promise});
  h.feature.render(CHALLENGE);h.send();h.feature.dispose();
  const next=createAuthChallengeFeature(h.options);next.start();next.render(CHALLENGE);
  h.get('authChallengeResponse').value='new-synthetic-response';h.feature.clearResponse();
  pending.reject(new Error('late synthetic failure'));await settle();
  assert.equal(h.get('authChallengeResponse').value,'new-synthetic-response');
  assert.equal(h.get('authChallengeError').textContent,'');assert.equal(h.get('authChallengeDialog').open,true);next.dispose();
});

test('dispose before start has no authority over existing DOM and is terminal',()=>{
  const h=harness({},false);h.get('authChallengeResponse').value='other-owner-input';h.feature.dispose();
  assert.equal(h.get('authChallengeResponse').value,'other-owner-input');assert.equal(h.feature.start(),false);
  assert.equal(h.listeners.size,0);assert.equal(h.subscriptions.size,0);
});

test('an event emitted during subscription is newer than the initial snapshot',async()=>{
  const h=harness({},false);
  h.api.onAuthChallenge=callback=>{h.subscriptions.add(callback);callback(CHALLENGE);return()=>h.subscriptions.delete(callback);};
  h.feature.start();h.initial.resolve({authChallenge:null});await settle();
  assert.equal(h.get('authChallengeDialog').open,true);h.feature.dispose();
});

test('retirement during event binding removes even a late registration',()=>{
  const h=harness({},false), form=h.get('authChallengeForm'), add=form.addEventListener;
  form.addEventListener=function(...args){h.feature.dispose();add.apply(this,args);};
  assert.throws(()=>h.feature.start(),/retired/);assert.equal(h.listeners.size,0);assert.equal(h.subscriptions.size,0);
});

test('retirement during timer creation clears the returned handle and never reopens the dialog',()=>{
  const h=harness({},false);let feature, cleared;
  feature=createAuthChallengeFeature({...h.options,setTimeoutFn:()=>{feature.dispose();return 0;},clearTimeoutFn:id=>{cleared=id;}});
  feature.start();feature.render({...CHALLENGE,expiresAtUnixMs:5000});
  assert.equal(cleared,0);assert.equal(h.get('authChallengeDialog').open,false);assert.equal(h.listeners.size,0);
});

test('expiry clears typed input without submitting it',()=>{
  const h=harness();h.feature.render({...CHALLENGE,expiresAtUnixMs:5000});h.get('authChallengeResponse').value='synthetic';
  h.clock(5001);[...h.timers.values()][0].callback();
  assert.equal(h.get('authChallengeResponse').value,'');assert.equal(h.calls.length,0);h.feature.dispose();
});

test('locale repaint preserves typed input and an in-flight submission',async()=>{
  const pending=deferred();const h=harness({respondAuthChallenge:()=>pending.promise});
  h.feature.render(CHALLENGE);h.get('authChallengeResponse').value='keep-synthetic';
  h.options.document.documentElement.lang='zh';h.options.document.dispatch('app-locale-changed');
  assert.equal(h.get('authChallengeDescription').textContent,i18n.createT('zh')('auth.kindOtp'));
  assert.equal(h.get('authChallengeResponse').value,'keep-synthetic');h.send();
  h.options.document.documentElement.lang='en';h.options.document.dispatch('app-locale-changed');
  assert.equal(h.get('authChallengeSubmit').disabled,true);
  pending.resolve({ok:false});await settle();assert.equal(h.get('authChallengeSubmit').disabled,false);
  h.options.document.documentElement.lang='zh';h.options.document.dispatch('app-locale-changed');
  assert.equal(h.get('authChallengeError').textContent,i18n.createT('zh')('auth.failed'));h.feature.dispose();
});
