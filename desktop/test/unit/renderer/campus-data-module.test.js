'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const feature = require('../../../renderer/features/campus-data/index.mjs');
const renderer = path.resolve(__dirname, '../../../renderer');

test('campus data exposes one native public entrypoint without reintroducing its global facade', () => {
  assert.deepEqual(Object.keys(feature).sort(), ['create','scheduleWeekLayout','scheduleWeekModel','weekRange']);
  assert.equal(fs.existsSync(path.join(renderer,'campus-data-modules.js')),false);
  const app=fs.readFileSync(path.join(renderer,'app.js'),'utf8');
  assert.match(app,/import \{ create as createCampusData \} from '\.\/features\/campus-data\/index\.mjs'/u);
  assert.doesNotMatch(app,/window\.campusDataModules/u);
  for(const name of ['calendar-model.mjs','calendar-view.mjs','controller.mjs','index.mjs']) {
    const source=fs.readFileSync(path.join(renderer,'features/campus-data',name),'utf8');
    assert.doesNotMatch(source,/\b(?:window|globalThis|self)\.[A-Za-z_$][\w$]*\s*=/u);
    assert.ok(source.split('\n').length<=500,`${name} stays below its feature-owner limit`);
  }
});

test('native extraction keeps miniature layout and grouped details in the same model contract', () => {
  const start=Date.parse('2027-01-13T15:00:00+08:00');
  const entries=[0,1,2].map(id=>({id:String(id),title:`Synthetic ${id}`,startsAt:start,endsAt:start+5400000}));
  const model=feature.scheduleWeekModel(entries,start,true);
  const mini=feature.scheduleWeekLayout(model,true);
  assert.equal(model.days.length,7);
  assert.equal(mini.groups.length,1);
  assert.equal(mini.groups[0].members.length,3);
  assert.ok(mini.height<=180);
});
