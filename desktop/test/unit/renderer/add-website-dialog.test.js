'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { create } = require('../../../renderer/add-website-dialog');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Element extends EventTarget {
  value = ''; textContent = ''; open = false; hidden = false; disabled = false;
  classList = { add() {}, remove() {} };
  replaceChildren(...children) { this.value = children.find(node => node.selected)?.value || ''; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
}
function fixture(overrides = {}) {
  const nodes = new Map();
  const f = { resources: [], groups: [], calls: [], toasts: [], active: null };
  const node = id => {
    if (!nodes.has(id)) {
      const element = new Element();
      element.focus = () => { if (!element.disabled) f.active = id; };
      nodes.set(id, element);
    }
    return nodes.get(id);
  };
  node('addWebsiteForm').reset = () => {
    for (const id of ['addWebsiteUrl', 'addWebsiteName', 'addWebsiteGroup', 'addWebsiteRoute']) node(id).value = '';
  };
  const doc = new EventTarget();
  Object.assign(doc, { getElementById: node, createElement: () => new Element() });
  const api = {
    previewRoutingTarget: async url => ({ ok: true, target: { host: new URL(url).hostname }, resolution: { route: 'campus' } }),
    createFavoriteResource: async payload => {
      f.calls.push(['create', payload]);
      const resource = { ...payload, id: 'saved', favorite: true };
      return { ok: true, resource, resources: [resource], groups: [] };
    },
    openResource: async id => { f.calls.push(['open', id]); return { ok: true }; },
    getState: async () => { f.calls.push(['state']); return { campusResources: f.resources, resourceGroups: f.groups }; },
    ...overrides,
  };
  f.owner = create({ api, document: doc, translate: key => key,
    getResources: () => f.resources, getGroups: () => f.groups,
    setResources: value => { f.resources = value; },
    setGroups: value => { f.groups = value; },
    toast: (...args) => { f.toasts.push(args); },
  });
  f.owner.start(); f.node = node;
  f.open = (name = 'Current draft') => {
    f.owner.open(); node('addWebsiteUrl').value = 'https://synthetic.example.edu/'; node('addWebsiteName').value = name;
  };
  f.submit = async () => { node('addWebsiteForm').dispatchEvent(new Event('submit', { cancelable: true })); await tick(); };
  f.reopen = () => { node('addWebsiteDialog').close(); f.open('New draft'); };
  return f;
}
const saved = { ok: true, resource: { id: 'old' }, resources: [{ id: 'old' }], groups: [] };

test('retired successful creation reconciles current model without closing or opening the replacement draft', async () => {
  const pending = deferred(), fresh = [{ id: 'old' }, { id: 'newer' }], groups = [{ id: 'current-group' }];
  const f = fixture({ createFavoriteResource: () => pending.promise,
    getState: async () => ({ campusResources: fresh, resourceGroups: groups }) });
  f.open(); await f.submit(); f.reopen(); pending.resolve(saved); await tick();
  assert.equal(f.node('addWebsiteDialog').open, true);
  assert.equal(f.node('addWebsiteName').value, 'New draft'); assert.equal(f.active, 'addWebsiteUrl');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.toasts, []);
  assert.equal(f.resources, fresh); assert.equal(f.groups, groups);
});

test('old rejection or failure cannot write errors or unlock a newer pending submission', async () => {
  for (const rejects of [false, true]) {
    const old = deferred(), current = deferred(); let count = 0;
    const f = fixture({ createFavoriteResource: () => ++count === 1 ? old.promise : current.promise });
    f.open(); await f.submit(); f.reopen(); await f.submit();
    if (rejects) old.reject(new Error('Old rejection')); else old.resolve({ ok: false, error: 'Old failure' });
    await tick();
    assert.equal(f.node('submitAddWebsite').disabled, true);
    assert.equal(f.node('addWebsiteError').textContent, ''); assert.deepEqual(f.calls, []);
    current.resolve({ ok: false, error: 'Current failure' }); await tick();
    assert.equal(f.node('addWebsiteError').textContent, 'Current failure');
    assert.equal(f.node('submitAddWebsite').disabled, false);
  }
});

test('preview owns single submission and retired preview cannot validate or focus a new draft', async () => {
  const pending = deferred(); let previews = 0;
  const f = fixture({ previewRoutingTarget: () => { previews++; return pending.promise; } });
  f.open(); await f.submit(); await f.submit(); assert.equal(previews, 1);
  f.reopen(); pending.resolve({ ok: false }); await tick();
  assert.equal(f.node('addWebsiteError').textContent, ''); assert.equal(f.active, 'addWebsiteUrl');
  assert.equal(f.node('addWebsiteName').value, 'New draft'); assert.deepEqual(f.calls, []);
});

test('queued native close event cannot reset a reopened dialog', () => {
  const f = fixture(); f.open(); f.reopen();
  f.node('addWebsiteDialog').dispatchEvent(new Event('close'));
  assert.equal(f.node('addWebsiteName').value, 'New draft');
});

test('normal save still publishes, closes, opens once and presents current open failure', async () => {
  const f = fixture({ openResource: async id => { f.calls.push(['open', id]); return { ok: false, error: 'Current open failure', resources: [{ id: 'opened' }] }; } });
  f.open(); await f.submit();
  assert.deepEqual(f.calls.map(([name]) => name), ['create', 'open']);
  assert.equal(f.node('addWebsiteDialog').open, false); assert.deepEqual(f.resources, [{ id: 'opened' }]);
  assert.deepEqual(f.toasts, [['addWebsite.saved'], ['Current open failure', 'error']]);
});

test('current validation and save rejection leave the draft retryable', async () => {
  let count = 0;
  const f = fixture({ createFavoriteResource: async () => {
    if (++count === 1) throw new Error('Current rejection');
    return saved;
  } });
  f.open(); await f.submit();
  assert.equal(f.node('addWebsiteDialog').open, true); assert.equal(f.node('addWebsiteError').textContent, 'Current rejection');
  assert.equal(f.node('submitAddWebsite').disabled, false);
  await f.submit(); assert.equal(count, 2); assert.equal(f.node('addWebsiteDialog').open, false);
  const invalid = fixture({ previewRoutingTarget: async () => ({ ok: false }) });
  invalid.open(); await invalid.submit(); assert.equal(invalid.node('addWebsiteError').textContent, 'addWebsite.invalidUrl');
  assert.equal(invalid.node('submitAddWebsite').disabled, false); assert.deepEqual(invalid.calls, []);
});

test('old open result cannot publish its snapshot, errors or unlock a new save', async () => {
  const opening = deferred(), newer = deferred(); let count = 0;
  const f = fixture({ createFavoriteResource: async () => ++count === 1 ? saved : newer.promise,
    openResource: () => opening.promise });
  f.open(); await f.submit(); f.open('New draft'); await f.submit();
  opening.resolve({ ok: false, error: 'Old open failure', resources: [{ id: 'obsolete' }] }); await tick();
  assert.equal(f.node('addWebsiteDialog').open, true); assert.equal(f.node('submitAddWebsite').disabled, true);
  assert.equal(f.node('addWebsiteName').value, 'New draft'); assert.equal(f.toasts.length, 1);
  assert.deepEqual(f.resources, saved.resources);
  newer.resolve({ ok: false }); await tick();
});

test('model reconciliation cannot overwrite a newer publication from this owner or another setter', async () => {
  for (const external of [false, true]) {
    const old = deferred(), snapshot = deferred(); let count = 0;
    const newest = [{ id: 'old' }, { id: 'newest' }];
    const f = fixture({ createFavoriteResource: () => ++count === 1 ? old.promise : Promise.resolve({ ...saved, resources: newest }),
      getState: () => snapshot.promise });
    f.open(); await f.submit(); f.reopen(); old.resolve(saved); await tick();
    if (external) f.resources = newest; else await f.submit();
    snapshot.resolve({ campusResources: [{ id: 'obsolete' }], resourceGroups: [] }); await tick();
    assert.equal(f.resources, newest);
  }
});

test('failed reconciliation cannot revive retired UI effects', async () => {
  const old = deferred();
  const f = fixture({ createFavoriteResource: () => old.promise, getState: async () => { throw new Error('Read failed'); } });
  f.open(); await f.submit(); f.reopen(); old.resolve(saved); await tick();
  assert.equal(f.node('addWebsiteName').value, 'New draft'); assert.equal(f.node('addWebsiteError').textContent, '');
});
