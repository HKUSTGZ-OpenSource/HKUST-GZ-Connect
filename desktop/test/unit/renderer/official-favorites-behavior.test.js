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

function fixture(overrides = {}, { autoStart = true } = {}) {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const doc = new EventTarget();
  Object.assign(doc, { getElementById: node, createElement: () => new Element(), documentElement: { lang: 'zh-CN' } });
  const f = { node, doc, hooks:{}, calls: [], groups: [{ id: 'existing', name: 'Existing folder', resourceIds: [] }], resources: [], saved: [], toasts: [] };
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
    getGroups: () => f.groups, setResources: value => { f.resources = value; f.hooks.resources?.(); }, setGroups: value => { f.groups = value; f.hooks.groups?.(); },
    onSaved: value => f.saved.push(value), toast: value => f.toasts.push(value) });
  f.entry = { id: 'official', url: 'https://example.edu/app#section', name: 'Fallback',
    localizedName: { zh: '课程系统', en: 'Course System' }, localizedUseCase: { zh: '选课', en: 'Enroll' } };
  f.submit = async () => { node('officialFavoriteForm').dispatchEvent(new Event('submit', { cancelable: true })); await new Promise(resolve => setImmediate(resolve)); };
  if (autoStart) { assert.equal(f.owner.start(), true); assert.equal(f.owner.start(), false); }
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

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('closing or replacing a dialog during group creation cannot save the new entry',async()=>{
  for(const replace of [false,true]) {
    const d=deferred();const f=fixture({createFavoriteGroup:()=>d.promise});
    f.owner.open(f.entry);f.node('officialFavoriteGroup').value='__new_group__';f.node('officialFavoriteNewGroup').value='Pending';
    await f.submit();
    f.node('officialFavoriteDialog').close();
    if(replace)f.owner.open({...f.entry,id:'other',url:'https://example.edu/other'});
    d.resolve({ok:true,groups:[{id:'new',name:'Pending'}]});await tick();
    assert.deepEqual(f.calls,[]);assert.equal(f.groups[0].id,'existing');
    assert.deepEqual(f.saved,[]);assert.deepEqual(f.toasts,[]);
  }
});

test('older resource completion cannot move data or unlock a newer save',async()=>{
  const old=deferred(),fresh=deferred();let count=0;
  const f=fixture({createFavoriteResource:()=>++count===1?old.promise:fresh.promise});
  f.owner.open(f.entry);await f.submit();
  f.node('officialFavoriteDialog').close();f.owner.open({...f.entry,id:'other',url:'https://example.edu/other'});await f.submit();
  old.resolve({ok:true,resource:{id:'old'},resources:[{id:'old'}]});await tick();
  assert.equal(f.node('saveOfficialFavorite').disabled,true);
  assert.deepEqual(f.resources,[]);assert.deepEqual(f.calls,[]);
  fresh.resolve({ok:false,error:'New failure'});await tick();
  assert.equal(f.node('officialFavoriteError').textContent,'New failure');
});

test('disposal fences queued writes and removes owned listeners',async()=>{
  const {getEventListeners}=require('node:events');const d=deferred();
  const f=fixture({createFavoriteResource:()=>d.promise});
  const external=()=>{};f.doc.addEventListener('app-locale-changed',external);
  f.owner.open(f.entry);await f.submit();
  assert.equal(f.owner.dispose(),true);assert.equal(f.owner.dispose(),false);assert.equal(f.owner.start(),false);
  d.resolve({ok:true,resource:{id:'old'},resources:[{id:'old'}]});await tick();
  assert.deepEqual(f.resources,[]);assert.deepEqual(f.calls,[]);assert.deepEqual(f.saved,[]);
  assert.equal(f.owner.open(f.entry),false);
  assert.equal(getEventListeners(f.node('officialFavoriteForm'),'submit').length,0);
  assert.deepEqual(getEventListeners(f.doc,'app-locale-changed'),[external]);
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

test('submitted payload is captured before a pending group request or locale change',async()=>{
  const d=deferred();const f=fixture({createFavoriteGroup:()=>d.promise});
  const url=f.entry.url;f.owner.open(f.entry);f.node('officialFavoriteGroup').value='__new_group__';f.node('officialFavoriteNewGroup').value='Pending';
  await f.submit();f.entry.url='https://example.edu/replaced';f.doc.documentElement.lang='en';
  d.resolve({ok:true,groups:[...f.groups,{id:'new',name:'Pending'}]});await tick();
  assert.equal(f.calls[0][1].url,url);assert.equal(f.calls[0][1].name,'课程系统');
});

test('ambiguous newly created folders never choose an arbitrary destination',async()=>{
  const f=fixture({createFavoriteGroup:async()=>({ok:true,groups:[{id:'new-a'},{id:'new-b'}]})});
  f.owner.open(f.entry);f.node('officialFavoriteGroup').value='__new_group__';f.node('officialFavoriteNewGroup').value='Pending';await f.submit();
  assert.deepEqual(f.calls,[]);assert.equal(f.node('officialFavoriteError').textContent,'favoriteDialog.failed');
});

test('reentrant publication can retire the operation before subsequent writes',async()=>{
  const f=fixture();f.hooks.resources=()=>f.owner.dispose();f.owner.open(f.entry);await f.submit();
  assert.deepEqual(f.calls.map(call=>call[0]),['resource']);assert.deepEqual(f.saved,[]);assert.deepEqual(f.toasts,[]);
});

test('late native close events do not clear a reopened dialog',async()=>{
  const f=fixture();f.owner.open(f.entry);f.node('officialFavoriteDialog').close();
  f.owner.open({...f.entry,id:'other',url:'https://example.edu/other'});
  f.node('officialFavoriteDialog').dispatchEvent(new Event('close'));await f.submit();
  assert.equal(f.calls[0][1].url,'https://example.edu/other');
});

test('partial start failure removes earlier listeners and retires the owner',()=>{
  const {getEventListeners}=require('node:events');const f=fixture({}, {autoStart:false});
  f.node('officialFavoriteForm').addEventListener=()=>{throw new Error('Synthetic binding failure');};
  assert.throws(()=>f.owner.start(),/Synthetic binding failure/);
  assert.equal(getEventListeners(f.node('officialFavoriteGroup'),'change').length,0);
  assert.equal(f.owner.start(),false);assert.equal(f.owner.open(f.entry),false);
});

test('move completion after closure cannot publish groups or success',async()=>{
  const d=deferred();const f=fixture({moveFavoriteResource:()=>d.promise});
  f.owner.open(f.entry);await f.submit();f.node('officialFavoriteDialog').close();
  d.resolve({ok:true,groups:[{id:'late'}]});await tick();
  assert.equal(f.groups[0].id,'existing');assert.deepEqual(f.saved,[]);assert.deepEqual(f.toasts,[]);
});

test('resource publication cannot change the ID of the pending placement',async()=>{
  const f=fixture();f.hooks.resources=()=>{f.resources.at(-1).id='mutated';};
  f.owner.open(f.entry);await f.submit();
  assert.equal(f.calls[1][1].resourceId,'resource');assert.equal(f.saved[0].resource.id,'resource');
});

test('queued submit and locale callbacks are inert after disposal',async()=>{
  const {getEventListeners}=require('node:events');const f=fixture();f.owner.open(f.entry);
  const submit=getEventListeners(f.node('officialFavoriteForm'),'submit')[0];
  const locale=getEventListeners(f.doc,'app-locale-changed')[0];
  f.owner.dispose();submit(new Event('submit',{cancelable:true}));locale(new Event('app-locale-changed'));await tick();
  assert.deepEqual(f.calls,[]);assert.equal(f.node('officialFavoriteName').textContent,'');
  assert.deepEqual(f.node('officialFavoriteGroup').children,[]);
});
