'use strict';
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const test = require('node:test');
const registryFactory = () => require('../../../renderer/features/feature-host/registry.mjs').createFeatureRegistry;
const define = (id, events, overrides = {}) => ({ id, create: options => {
  events.push(['create', id, options]);
  return { start: () => { events.push(['start', id]); return true; },
    dispose: () => { events.push(['dispose', id]); return true; }, ...overrides };
} });

test('definitions are preflight checked without factory effects or listener leaks', () => {
  const create = registryFactory(), events = [], target = new EventTarget();
  for (const definitions of [null, [{}], [{ id:'bad/id', create() {} }], [define('one',events), define('one',events)]]) {
    assert.throws(() => create({ definitions, target }), TypeError);
    assert.deepEqual(events, []); assert.equal(getEventListeners(target,'pagehide').length, 0);
  }
});

test('mount preserves injected options and order, rejects unknown/duplicate IDs, and reverses disposal', () => {
  const events = [], target = new EventTarget();
  const registry = registryFactory()({ definitions:[define('one',events),define('two',events)], target });
  const options = { synthetic:true }; registry.mount('one', options); registry.mount('two', {});
  assert.equal(events[0][2], options);
  assert.throws(() => registry.mount('unknown', {}), /unknown/u);
  assert.throws(() => registry.mount('one', {}), /already/u);
  assert.equal(registry.dispose(), true); assert.equal(registry.dispose(), false);
  assert.deepEqual(events.map(([op,id])=>`${op}:${id}`), ['create:one','start:one','create:two','start:two','dispose:two','dispose:one']);
  assert.equal(getEventListeners(target,'pagehide').length, 0);
  assert.throws(() => registry.mount('one', {}), /disposed/u);
});

test('factory definitions are captured and cannot be swapped after registry construction', () => {
  const events = [], definition = define('one',events);
  const registry = registryFactory()({ definitions:[definition] });
  definition.create = () => { throw Error('mutated'); }; definition.id = 'changed';
  registry.mount('one', {}); assert.equal(events[0][1], 'one'); registry.dispose();
});

test('start failure cleans the failing instance then prior instances and preserves the primary error', () => {
  const events = [], original = new Error('Synthetic start failure');
  const registry = registryFactory()({ definitions:[define('one',events),define('two',events,{start:()=>{throw original;}})] });
  registry.mount('one', {}); assert.throws(() => registry.mount('two', {}), error=>error===original);
  assert.deepEqual(events.filter(([op])=>op==='dispose').map(([,id])=>id), ['two','one']);
  assert.equal(registry.dispose(), false);
});

test('invalid lifecycle contracts fail closed and clean recoverable instances', () => {
  for (const overrides of [{start:null},{start:()=>false}]) {
    const events = [], registry = registryFactory()({ definitions:[define('one',events,overrides)] });
    assert.throws(()=>registry.mount('one', {}));
    assert.deepEqual(events.filter(([op])=>op==='dispose'), [['dispose','one']]);
    assert.throws(()=>registry.mount('one', {}), /disposed/u);
  }
});

test('cleanup failure never prevents retirement of another feature', () => {
  const events = [], cleanup = new Error('Synthetic cleanup failure');
  const registry = registryFactory()({definitions:[define('one',events),define('two',events,{dispose:()=>{throw cleanup;}})]});
  registry.mount('one', {}); registry.mount('two', {});
  assert.throws(()=>registry.dispose(), error=>error instanceof AggregateError && error.errors[0]===cleanup);
  assert.ok(events.some(([op,id])=>op==='dispose'&&id==='one'));
  assert.equal(registry.dispose(), false);
});

test('a failing lifecycle target removal still retires mounted owners', () => {
  const events=[];
  const target={addEventListener(){},removeEventListener(){throw new Error('Synthetic listener removal failure');}};
  const registry=registryFactory()({definitions:[define('one',events)],target});
  registry.mount('one',{});
  assert.throws(()=>registry.dispose(),error=>error instanceof AggregateError);
  assert.ok(events.some(([op,id])=>op==='dispose'&&id==='one'));
  assert.equal(registry.dispose(),false);
});

test('pagehide disposes once and removes the registry listener', () => {
  const events = [], target = new EventTarget();
  const registry = registryFactory()({definitions:[define('one',events)],target}); registry.mount('one', {});
  target.dispatchEvent(new Event('pagehide')); target.dispatchEvent(new Event('pagehide'));
  assert.equal(events.filter(([op])=>op==='dispose').length, 1);
  assert.equal(getEventListeners(target,'pagehide').length, 0);
});

test('retirement during construction or start cannot publish an unowned live instance', () => {
  for (const step of ['create','start']) {
    let registry, disposals=0;
    registry=registryFactory()({definitions:[{id:'one',create:()=>{
      if(step==='create')registry.dispose();
      return {start:()=>{if(step==='start')registry.dispose();return true;},dispose:()=>{disposals++;}};
    }}]});
    assert.throws(()=>registry.mount('one', {}), /disposed/u); assert.equal(disposals,1);
  }
});

test('a reentrant mount cannot construct another feature behind the bootstrap order', () => {
  const events=[]; let registry;
  registry=registryFactory()({definitions:[{id:'one',create:()=>{registry.mount('two', {});}},define('two',events)]});
  assert.throws(()=>registry.mount('one', {}), /reentrant/u); assert.deepEqual(events,[]);
});

test('native feature catalog is immutable and contains only the migrated public factories', () => {
  const { FEATURE_DEFINITIONS } = require('../../../renderer/features/feature-host/index.mjs');
  assert.equal(Object.isFrozen(FEATURE_DEFINITIONS), true);
  assert.deepEqual(FEATURE_DEFINITIONS.map(({id})=>id), ['auth-challenge','integration-center','official-favorites','campus-data']);
  for (const definition of FEATURE_DEFINITIONS) {
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(definition.create, require(`../../../renderer/features/${definition.id}/index.mjs`).create);
  }
});

test('declared asynchronous constructors and starts are rejected before their effects', () => {
  let effects=0; const create=registryFactory();
  assert.throws(()=>create({definitions:[{id:'one',create:async()=>{effects++;}}]}), TypeError);
  const events=[], registry=create({definitions:[define('one',events,{start:async()=>{effects++;return true;}})]});
  assert.throws(()=>registry.mount('one', {}), TypeError);
  assert.equal(effects,0); assert.deepEqual(events.filter(([op])=>op==='dispose'),[['dispose','one']]);
  const asyncCleanup=create({definitions:[define('one',events,{dispose:async()=>{effects++;}})]});
  assert.throws(()=>asyncCleanup.mount('one', {})); assert.equal(effects,0);
});

test('startup and cleanup failures retain the primary cause and still retire earlier owners', () => {
  const events=[], primary=new Error('Startup'), secondary=new Error('Cleanup');
  const registry=registryFactory()({definitions:[define('one',events),define('two',events,{
    start:()=>{throw primary;},dispose:()=>{throw secondary;},
  })]}); registry.mount('one', {});
  assert.throws(()=>registry.mount('two', {}),error=>{
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors,[primary,secondary]); return true;
  });
  assert.ok(events.some(([op,id])=>op==='dispose'&&id==='one'));
});
