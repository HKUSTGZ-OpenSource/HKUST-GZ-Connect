'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { renderSchedule } = require('../../../renderer/features/campus-data/calendar-view.mjs');
const stamp = Date.parse('2027-01-13T15:00:00+08:00');
const escapeHtml = value => String(value).replace(/[&<>"']/gu,
  char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function options(extra = {}) {
  return { selectedDate:'2027-01-13', clockNow:()=>stamp, miniature:false, locale:()=> 'en',
    translate:(key,vars)=>key+(vars ? JSON.stringify(vars) : ''), escapeHtml,
    stateHtml:module=>'STATE:'+module.state, actionHtml:()=>'<button>SOURCE</button>',
    scheduleNotice:'', onGroups:()=>{}, ...extra };
}

test('calendar view escapes display strings and returns unchanged entries through grouped detail bindings', () => {
  const items = [0,1].map(id=>({id:String(id),title:'<script>alert("fixture")</script>',
    startsAt:stamp,endsAt:stamp+3600000}));
  const before = JSON.stringify(items);
  let groups;
  const html = renderSchedule({state:'ready',source:'myportal-calendar',items},
    options({onGroups:value=>{groups=value;},scheduleNotice:'workspace.scheduleRefreshFailed'}));
  assert.equal((html.match(/role="columnheader"/gu)||[]).length,8);
  assert.equal(groups.length,1);
  assert.equal(groups[0].members.length,2);
  assert.equal(groups[0].members[0].entry,items[0]);
  assert.equal(JSON.stringify(items),before);
  assert.match(html,/data-count="2"/u);
  assert.match(html,/data-schedule-index="0"/u);
  assert.match(html,/&lt;script&gt;/u);
  assert.doesNotMatch(html,/<script>/u);
  assert.match(html,/week-refresh-notice/u);
});

test('calendar view keeps miniature empty weeks bounded and exposes all seven days', () => {
  let groups;
  const html = renderSchedule({state:'empty',source:'myportal-calendar',items:[]},
    options({miniature:true,onGroups:value=>{groups=value;}}));
  assert.deepEqual(groups,[]);
  assert.match(html,/week-table is-mini/u);
  assert.match(html,/week-empty/u);
  assert.equal((html.match(/role="columnheader"/gu)||[]).length,8);
  assert.doesNotMatch(html,/data-schedule-index/u);
});

test('non-ready views preserve navigation and delegate state copy without reading a clock or binding events', () => {
  for(const state of ['failed','session-expired','forbidden']) {
    const html = renderSchedule({state,items:[]},options({
      clockNow:()=>{throw new Error('non-ready view read clock');},
      onGroups:()=>{throw new Error('non-ready view emitted stale detail groups');},
    }));
    assert.match(html,/id="scheduleDate"/u);
    assert.ok(html.endsWith('STATE:'+state));
    assert.doesNotMatch(html,/class="week-table/u);
  }
});

test('pending view keeps only bounded geometry and never reuses prior event groups', () => {
  for (const miniature of [false,true]) {
    let groups;
    const html=renderSchedule({state:'loading',items:[]},options({miniature,
      lastScheduleLayout:{start:840,end:1200,height:300,slotCount:3},
      onGroups:value=>{groups=value;},onLayout:()=>{throw new Error('pending cannot publish ready geometry');}}));
    assert.deepEqual(groups,[]);
    assert.equal((html.match(/role="columnheader"/gu)||[]).length,8);
    assert.match(html,/aria-busy="true"/u);
    assert.match(html,new RegExp(`data-height="${miniature?140:180}"`));
    assert.doesNotMatch(html,/week-empty|data-schedule-index|STATE:loading/u);
  }
  let geometry;
  renderSchedule({state:'empty',items:[]},options({onLayout:value=>{geometry=value;}}));
  assert.deepEqual(Object.keys(geometry).sort(),['end','height','slotCount','start']);
});
