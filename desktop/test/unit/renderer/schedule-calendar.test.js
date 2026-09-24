'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleWeekModel, scheduleWeekLayout } = require('../../../renderer/features/campus-data/index.mjs');
const date = (day, hour = 0) => new Date(2027, 0, day, hour).getTime();

test('compact week keeps all three concurrent records readable through one full-width group', () => {
  const events = [[15,16.5], [16.5,18+20/60], [16.5,18+20/60], [16.5,18+20/60], [18.5,19.5]]
    .map(([from,to],id)=>({id:String(id),title:`Event ${id}`,startsAt:date(13)+from*3600000,endsAt:date(13)+to*3600000}));
  const model=scheduleWeekModel(events,date(13)); const layout=scheduleWeekLayout(model);
  assert.equal(layout.start,14*60); assert.equal(layout.end,20*60);
  assert.equal(layout.height,216);
  assert.deepEqual(layout.groups.map(group=>group.members.length),[1,3,1]);
  // Consecutive non-overlapping courses are not falsely described as concurrent.
  const exact = scheduleWeekLayout(scheduleWeekModel(events.slice(0,4),date(13)));
  assert.deepEqual(exact.groups.map(group=>group.members.length),[1,3]);
  assert.equal(exact.groups.flatMap(group=>group.members).length,4);
  for(let i=1;i<layout.groups.length;i++)assert.ok(layout.groups[i-1].bottom<=layout.groups[i].top);
});

test('compact full-day and empty weeks stay bounded without hiding event records', () => {
  const model=scheduleWeekModel([{startsAt:date(13),endsAt:date(14),title:'All day'}],date(13));
  const layout=scheduleWeekLayout(model);
  assert.ok(layout.height<=300);assert.equal(layout.groups[0].members[0].entry.title,'All day');
  assert.ok(scheduleWeekLayout(scheduleWeekModel([],date(13))).height<=300);
});

test('miniature week reduces height and preserves every calendar segment', () => {
  const model = scheduleWeekModel([{ startsAt: date(13,15), endsAt: date(13,17), title: 'Core' }], date(13));
  const full = scheduleWeekLayout(model);
  const mini = scheduleWeekLayout(model, true);
  assert.ok(mini.height < full.height);
  assert.ok(mini.height <= 180);
  assert.equal(mini.groups.flatMap(group=>group.members).length, model.events.length);
  assert.ok(mini.groups.every(group=>group.bottom-group.top>=28));
});

test('campus week and event slots stay stable when the host has not reached Monday', () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
      process.env.TZ = zone;
      const model = scheduleWeekModel([{
        startsAt: Date.parse('2027-01-18T10:00:00+08:00'),
        endsAt: Date.parse('2027-01-18T12:00:00+08:00'),
      }], Date.parse('2027-01-17T20:00:00Z'), true);
      assert.equal(model.start, Date.parse('2027-01-17T16:00:00Z'), zone);
      assert.equal(model.events[0].day, 0);
      assert.equal(model.events[0].slot, 1);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('cross-day events project only onto intersecting calendar dates', () => {
  const entry = { id: 'overnight', startsAt: date(12, 20), endsAt: date(13, 10) };
  const model = scheduleWeekModel([entry], date(13));
  assert.deepEqual(model.events.map(({ day }) => day), [1, 2]);
  assert.deepEqual(model.events.map(({ segmentStart, segmentEnd }) => [segmentStart, segmentEnd]),
    [[date(12, 20), date(13)], [date(13), date(13, 10)]]);
  assert.equal(model.eventCount, 1);
  assert.equal(model.events[0].entry, entry);
  assert.equal(model.slotStart, 0);
  assert.equal(model.slotCount, 12);
  assert.equal(model.events[0].slot, 10);
  assert.equal(model.events[0].span, 2);
  assert.equal(model.events[1].slot, 0);
  assert.equal(model.events[1].span, 5);
});

test('ordinary daytime events retain the compact default time axis', () => {
  const model = scheduleWeekModel([{ startsAt: date(12, 10), endsAt: date(12, 12) }], date(13));
  assert.equal(model.slotStart, 480);
  assert.equal(model.slotCount, 7);
  assert.equal(model.events[0].slot, 1);
});

test('week clipping uses interval intersection, not the original weekday', () => {
  const model = scheduleWeekModel([
    { id: 'previous-week', startsAt: date(10, 20), endsAt: date(11, 10) },
    { id: 'next-week', startsAt: date(17, 20), endsAt: date(18, 10) },
  ], date(13));
  assert.deepEqual(model.events.map(({ day }) => day), [0, 6]);
  assert.equal(model.events[0].segmentStart, date(11));
  assert.equal(model.events[1].segmentEnd, date(18));
});

test('exclusive end midnight creates no extra day and invalid intervals are absent', () => {
  const model = scheduleWeekModel([
    { startsAt: date(12, 20), endsAt: date(13) },
    { startsAt: date(13), endsAt: date(13) },
    { startsAt: date(14), endsAt: date(13) },
    { startsAt: Number.MAX_VALUE, endsAt: Infinity },
  ], date(13));
  assert.equal(model.events.length, 1);
  assert.equal(model.events[0].day, 1);
  assert.equal(model.eventCount, 1);
});
