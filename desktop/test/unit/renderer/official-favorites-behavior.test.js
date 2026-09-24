'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { create } = require('../../../renderer/features/official-favorites/index.mjs');

class Element extends EventTarget {
  value = ''; textContent = ''; open = false; hidden = false; disabled = false;
  replaceChildren(...children) { this.children = children; this.value = children.find(node => node.selected)?.value || ''; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
}

function fixture(overrides = {}) {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const doc = new EventTarget();
  Object.assign(doc, { getElementById: node, createElement: () => new Element(), documentElement: { lang: 'zh-CN' } });
  const f = { node, doc, calls: [], groups: [{ id: 'existing', name: 'Existing folder', resourceIds: [] }], resources: [], saved: [], toasts: [] };
  const api = {
    createFavoriteGroup: async name => { f.calls.push(['group', name]); return { ok: true, groups: [...f.groups, { id: 'new', name, resourceIds: [] }] }; },
    createFavoriteResource: async value => {
      f.calls.push(['resource', value]); const resource = { ...value, id: 'resource', favorite: true };
      return { ok: true, resource, resources: [...f.resources, resource] };
    },
    moveFavoriteResource: async value => {
      f.calls.push(['move', value]);
      return { ok: true, groups: f.groups.map(group => group.id === value.groupId ? { ...group, resourceIds: [value.resourceId] } : group) };
    },
    ...overrides,
  };
  f.owner = create({ api, document: doc, translate: key => key, getResources: () => f.resources,
    getGroups: () => f.groups, setResources: value => { f.resources = value; }, setGroups: value => { f.groups = value; },
    onSaved: value => f.saved.push(value), toast: value => f.toasts.push(value) });
  f.entry = { id: 'official', url: 'https://example.edu/app#section', name: 'Fallback',
    localizedName: { zh: '课程系统', en: 'Course System' }, localizedUseCase: { zh: '选课', en: 'Enroll' } };
  f.submit = async () => { node('officialFavoriteForm').dispatchEvent(new Event('submit', { cancelable: true })); await new Promise(resolve => setImmediate(resolve)); };
  assert.equal(f.owner.start(), true); assert.equal(f.owner.start(), false);
  return f;
}

test('existing folder and ungrouped saves preserve exact ID-only placement and localized payload', async () => {
  for (const groupId of ['existing', '']) {
    const f = fixture();
    f.owner.open(f.entry); f.node('officialFavoriteGroup').value = groupId;
    await f.submit();
    assert.deepEqual(f.calls, [
      ['resource', { name: '课程系统', url: f.entry.url, description: '选课', routePreference: 'auto', groupId: null }],
      ['move', { resourceId: 'resource', groupId: groupId || null, index: 0 }],
    ]);
    assert.equal(f.node('officialFavoriteDialog').open, false);
    assert.equal(f.saved.length, 1); assert.equal(f.toasts.length, 1);
    assert.equal(f.owner.isFavorite({ url: 'https://example.edu/app#other' }), true);
  }
});

test('new folder validation precedes writes and English saves retain ordered group/resource/move flow', async () => {
  const f = fixture(); f.doc.documentElement.lang = 'en'; f.owner.open(f.entry);
  f.node('officialFavoriteGroup').value = '__new_group__';
  f.node('officialFavoriteGroup').dispatchEvent(new Event('change'));
  assert.equal(f.node('officialFavoriteNewGroupField').hidden, false);
  await f.submit();
  assert.deepEqual(f.calls, []); assert.equal(f.node('saveOfficialFavorite').disabled, false);
  f.node('officialFavoriteNewGroup').value = 'Research'; await f.submit();
  assert.deepEqual(f.calls.map(call => call[0]), ['group', 'resource', 'move']);
  assert.equal(f.calls[1][1].name, 'Course System'); assert.equal(f.calls[1][1].description, 'Enroll');
  assert.equal(f.calls[2][1].groupId, 'new'); assert.deepEqual(f.groups.at(-1).resourceIds, ['resource']);
});

test('create failure keeps chooser open and clears busy state without publishing success', async () => {
  const f = fixture({ createFavoriteResource: async () => ({ ok: false, error: 'Synthetic failure' }) });
  f.owner.open(f.entry); await f.submit();
  assert.equal(f.node('officialFavoriteDialog').open, true);
  assert.equal(f.node('officialFavoriteError').textContent, 'Synthetic failure');
  assert.equal(f.node('saveOfficialFavorite').disabled, false);
  assert.equal(f.saved.length, 0); assert.equal(f.toasts.length, 0); assert.deepEqual(f.calls, []);
});
