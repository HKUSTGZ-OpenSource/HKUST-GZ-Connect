'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MyPortalDataRuntime,
  hkustMyPortalSources,
} = require('../../../lib/browser/session/browser-session-manager');

function runtime({ response, source, fetchError = null } = {}) {
  const calls = [];
  const targetSession = {
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (fetchError) throw fetchError;
      return response;
    },
  };
  return {
    calls,
    subject: new MyPortalDataRuntime({
      electronSession: { fromPartition: (partition) => {
        calls.push({ partition });
        return targetSession;
      } },
      getPartition: () => 'persist:hkustgz-campus-browser',
      getPortalUrl: () => 'https://myportal.hkust-gz.edu.cn/path?ignored=1',
      getSources: () => source || {},
      now: () => 1_800_000_000_000,
      cacheMs: 30_000,
      timeoutMs: 500,
    }),
  };
}

function headers(location = null) {
  return { get: (name) => name.toLowerCase() === 'location' ? location : null };
}

test('HKUST calendar local timestamps represent campus UTC+08 time on any host', async () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
      process.env.TZ = zone;
      for (const [start, end] of [
        ['2027-01-15 10:00:00', '2027-01-15 12:00:00'],
        ['2027-01-15T10:00:00', '2027-01-15T12:00:00'],
        ['2027-01-15T02:00:00Z', '2027-01-15T04:00:00Z'],
        ['2027-01-15T03:00:00+01:00', '2027-01-15T05:00:00+01:00'],
      ]) {
        let requestUrl;
        const value = await hkustMyPortalSources.schedule.read({
          session: { fetch: async (url) => { requestUrl = new URL(url); return ({ status: 200, headers: headers(),
            text: async () => JSON.stringify([{ title: 'Campus time fixture', startsAt: start, endsAt: end }]),
          }); } },
          portalUrl: 'https://myportal.hkust-gz.edu.cn/', sessionUrl: 'https://myportal.hkust-gz.edu.cn/',
          checkedAt: Date.parse('2027-01-17T20:00:00Z'), timeoutMs: 500,
        });
        assert.equal(value.items[0].startsAt, Date.parse('2027-01-15T02:00:00Z'), zone);
        assert.equal(value.items[0].endsAt, Date.parse('2027-01-15T04:00:00Z'), zone);
        assert.equal(requestUrl.searchParams.get('fromDate'), '2027-01-17T16:00:00.000Z');
        assert.equal(requestUrl.searchParams.get('endDate'), '2027-01-24T15:59:59.999Z');
      }
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('schedule ingress rejects impossible and non-positive intervals before renderer projection', async () => {
  for (const [startsAt, endsAt] of [
    [1_800_000_000_000, 1_800_000_000_000],
    [1_800_000_000_001, 1_800_000_000_000],
    [8_640_000_000_000_001, 8_640_000_000_000_002],
  ]) {
    const fixture = runtime({
      response: { status: 200, url: 'https://myportal.hkust-gz.edu.cn/', headers: headers() },
      source: { schedule: { read: async () => ({
        state: 'ready', source: 'fixture', fetchedAt: 1_800_000_000_000, stale: false,
        items: [{ id: 'invalid-event', title: 'Invalid fixture', startsAt, endsAt }],
      }) } },
    });
    const snapshot = await fixture.subject.snapshot();
    assert.equal(snapshot.modules.schedule.state, 'failed');
    assert.deepEqual(snapshot.modules.schedule.items, []);
    assert.equal(snapshot.sessionState, 'authenticated');
    assert.equal(snapshot.modules.loans.state, 'source-unavailable');
  }
});

test('reviewed calendar adapter rejects zero-length events instead of reporting ready', async () => {
  await assert.rejects(hkustMyPortalSources.schedule.read({
    session: { fetch: async () => ({ status: 200, headers: headers(),
      text: async () => JSON.stringify([{ title: 'Invalid fixture',
        startsAt: 1_800_000_000_000, endsAt: 1_800_000_000_000 }]),
    }) },
    portalUrl: 'https://myportal.hkust-gz.edu.cn/',
    sessionUrl: 'https://myportal.hkust-gz.edu.cn/',
    checkedAt: 1_800_000_000_000, timeoutMs: 500,
  }), { code: 'PORTAL_RESPONSE_INVALID' });
});

test('calendar adapter rejects impossible calendar dates instead of rolling into another month', async () => {
  await assert.rejects(hkustMyPortalSources.schedule.read({
    session: { fetch: async () => ({ status: 200, headers: headers(),
      text: async () => JSON.stringify([{ title: 'Invalid date fixture',
        startsAt: '2027-02-30 10:00:00', endsAt: '2027-02-30 12:00:00' }]),
    }) },
    portalUrl: 'https://myportal.hkust-gz.edu.cn/',
    sessionUrl: 'https://myportal.hkust-gz.edu.cn/',
    checkedAt: 1_800_000_000_000, timeoutMs: 500,
  }), { code: 'PORTAL_RESPONSE_INVALID' });
});

test('myPortal redirect produces an honest signed-out snapshot without reading APIs', async () => {
  let sourceReads = 0;
  const fixture = runtime({
    response: { status: 200, url: 'https://sso.hkust-gz.edu.cn/Account/Login', headers: headers() },
    source: { schedule: { read: async () => { sourceReads += 1; } } },
  });
  const snapshot = await fixture.subject.snapshot();
  assert.equal(snapshot.portalUrl, 'https://myportal.hkust-gz.edu.cn/');
  assert.equal(snapshot.sessionState, 'unauthenticated');
  assert.deepEqual(Object.values(snapshot.modules).map(({ state }) => state), [
    'not-authenticated', 'not-authenticated', 'source-unavailable',
  ]);
  assert.equal(sourceReads, 0);
  const request = fixture.calls.find(({ url }) => url);
  assert.equal(request.options.credentials, 'include');
  assert.equal(request.options.redirect, 'follow');
});

test('authenticated sessions call only configured sources and leave others unavailable', async () => {
  const fixture = runtime({
    response: { status: 200, url: 'https://myportal.hkust-gz.edu.cn/?tt=opaque', headers: headers() },
    source: {
      schedule: {
        read: async () => ({
          state: 'ready', source: 'official-api', fetchedAt: 1_800_000_000_000, stale: false,
          items: [{
            id: 'event-1', title: 'Research meeting', startsAt: 1_800_000_000_000,
            endsAt: 1_800_003_600_000, location: 'E1', kind: 'meeting',
            url: 'https://myportal.hkust-gz.edu.cn/schedule/event-1',
          }],
        }),
      },
    },
  });
  const snapshot = await fixture.subject.snapshot();
  assert.equal(snapshot.sessionState, 'authenticated');
  assert.equal(snapshot.modules.schedule.state, 'ready');
  assert.equal(snapshot.modules.schedule.items[0].title, 'Research meeting');
  assert.equal(snapshot.modules.loans.state, 'source-unavailable');
  assert.equal(snapshot.modules.news.state, 'source-unavailable');
  assert.equal(snapshot.catalog.state, 'source-unavailable');
});

test('session probe failures degrade independently without exposing the error', async () => {
  const fixture = runtime({ fetchError: new Error('secret cookie value') });
  const snapshot = await fixture.subject.snapshot();
  assert.equal(snapshot.sessionState, 'unknown');
  assert.deepEqual(Object.values(snapshot.modules).map(({ state }) => state), [
    'source-unavailable', 'source-unavailable', 'source-unavailable',
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|cookie/u);
  assert.equal(snapshot.catalog.state, 'source-unavailable');
});

test('cached reads avoid repeated portal probes while forced refresh rechecks', async () => {
  const fixture = runtime({ response: {
    status: 200, url: 'https://sso.hkust-gz.edu.cn/Account/Login', headers: headers(),
  } });
  await fixture.subject.snapshot();
  await fixture.subject.snapshot();
  assert.equal(fixture.calls.filter(({ url }) => url).length, 1);
  await fixture.subject.snapshot({ force: true });
  assert.equal(fixture.calls.filter(({ url }) => url).length, 2);
});

test('the default portal cache lasts one day and manual schedule refresh is isolated', async () => {
  let now = 1_800_000_000_000;
  let scheduleReads = 0;
  let newsReads = 0;
  let catalogReads = 0;
  const module = (id, title) => ({
    state: 'ready', source: `official-${id}`, fetchedAt: now, stale: false,
    items: id === 'schedule' ? [{
      id, title, startsAt: now + 3_600_000, endsAt: now + 7_200_000,
      location: null, kind: 'course', url: null,
    }] : [{ id, title, publishedAt: now, unread: false, url: null }],
  });
  const subject = new MyPortalDataRuntime({
    electronSession: { fromPartition: () => ({ fetch: async () => {
      throw new Error('live session hint should avoid the root probe');
    } }) },
    getPartition: () => 'persist:hkustgz-campus-browser',
    getPortalUrl: () => 'https://myportal.hkust-gz.edu.cn/',
    getSessionUrlHint: () => 'https://myportal.hkust-gz.edu.cn/',
    getSources: () => ({
      schedule: { read: async () => { scheduleReads += 1; return module('schedule', `Class ${scheduleReads}`); } },
      news: { read: async () => { newsReads += 1; return module('news', `News ${newsReads}`); } },
      catalog: { read: async () => {
        catalogReads += 1;
        return { state: 'empty', source: 'myportal-catalog', fetchedAt: now,
          applicationGroups: [], applications: [], serviceGroups: [], serviceItems: [] };
      } },
    }),
    now: () => now,
    timeoutMs: 500,
  });
  const first = await subject.snapshot();
  now += 24 * 60 * 60 * 1_000 - 1;
  assert.equal(await subject.snapshot(), first);
  assert.deepEqual({ scheduleReads, newsReads, catalogReads }, {
    scheduleReads: 1, newsReads: 1, catalogReads: 1,
  });

  const refreshed = await subject.refreshSchedule();
  assert.equal(refreshed.modules.schedule.items[0].title, 'Class 2');
  assert.equal(refreshed.modules.news.items[0].title, 'News 1');
  assert.deepEqual({ scheduleReads, newsReads, catalogReads }, {
    scheduleReads: 2, newsReads: 1, catalogReads: 1,
  });
});

test('a live portal tab hint bypasses the ambiguous root probe without crossing Renderer', async () => {
  const calls = [];
  let sourceSessionUrl = '';
  const subject = new MyPortalDataRuntime({
    electronSession: { fromPartition: () => ({ fetch: async () => {
      calls.push('unexpected-root-probe');
      throw new Error('root probe must be bypassed');
    } }) },
    getPartition: () => 'persist:hkustgz-campus-browser',
    getPortalUrl: () => 'https://myportal.hkust-gz.edu.cn/',
    getSessionUrlHint: () => 'https://myportal.hkust-gz.edu.cn/?tt=short-lived-routing-nonce',
    getSources: () => ({ schedule: { read: async (context) => {
      sourceSessionUrl = context.sessionUrl;
      return { state: 'empty', source: 'myportal-calendar', fetchedAt: 1_800_000_000_000,
        stale: false, items: [] };
    } } }),
    now: () => 1_800_000_000_000,
    timeoutMs: 500,
  });
  const snapshot = await subject.snapshot();
  assert.equal(snapshot.sessionState, 'authenticated');
  assert.equal(snapshot.modules.schedule.state, 'empty');
  assert.equal(calls.length, 0);
  assert.match(sourceSessionUrl, /tt=short-lived-routing-nonce/u);
  assert.doesNotMatch(JSON.stringify(snapshot), /short-lived-routing-nonce/u);
});

test('the portal calendar day envelope without events becomes an explicit empty state', async () => {
  const module = await hkustMyPortalSources.schedule.read({
    session: { fetch: async () => ({
      status: 200,
      headers: headers(),
      text: async () => 'portalProbe([{"day":"2027-01-15 00:00:00","holidayName":"","isHoliday":false,"teachingWeek":1}]);',
    }) },
    portalUrl: 'https://myportal.hkust-gz.edu.cn/',
    sessionUrl: 'https://myportal.hkust-gz.edu.cn/',
    checkedAt: 1_800_000_000_000,
    timeoutMs: 500,
  });
  assert.deepEqual(module, {
    state: 'empty', source: 'myportal-calendar', fetchedAt: 1_800_000_000_000,
    stale: false, items: [],
  });
});

test('the portal weekly day envelope maps schedule beginTime and endTime events', async () => {
  const module = await hkustMyPortalSources.schedule.read({
    session: { fetch: async () => ({
      status: 200,
      headers: headers(),
      text: async () => 'portalProbe([{"day":"2027-01-15 00:00:00","holidayName":"","isHoliday":false,"teachingWeek":1,"events":[{"schedule":{"id":7,"title":"Robotics Seminar","location":"E1","cateGory":{"name":"My Course"}},"beginTime":"2027-01-15 10:00:00","endTime":"2027-01-15 12:00:00"}]}]);',
    }) },
    portalUrl: 'https://myportal.hkust-gz.edu.cn/',
    sessionUrl: 'https://myportal.hkust-gz.edu.cn/',
    checkedAt: 1_800_000_000_000,
    timeoutMs: 500,
  });
  assert.equal(module.state, 'ready');
  assert.equal(module.items[0].title, 'Robotics Seminar');
  assert.equal(module.items[0].location, 'E1');
  assert.equal(module.items[0].kind, 'My Course');
  assert.equal(module.items[0].endsAt - module.items[0].startsAt, 2 * 3_600_000);
});

test('reviewed HKUST sources map bounded JSONP data without copying the page nonce into APIs', async () => {
  const calls = [];
  const sourceOptions = [];
  const targetSession = {
    fetch: async (url, options) => {
      calls.push(url);
      if (calls.length === 1) {
        return { status: 200, url: 'https://myportal.hkust-gz.edu.cn/?tt=private-session-nonce-1234',
          headers: headers() };
      }
      sourceOptions.push(options);
      if (String(url).includes('calendarList.rst')) {
        return {
          status: 200, url: 'https://sso.hkust-gz.edu.cn/incorrect-response-url', headers: headers(),
          text: async () => 'hkustgzConnectSchedule({"result":"1","data":{"list":[{"id":"e1","title":"Seminar","startTime":"2027-01-15 10:00:00","endTime":"2027-01-15 11:00:00","location":"E1"}]}});',
        };
      }
      return {
        status: 200, url, headers: headers(),
        text: async () => 'hkustgzConnectNews({"result":"1","data":{"list":[{"id":"n1","title":"Campus notice","date":"2027-01-14 09:00:00","linkUrl":"/news/n1"}]}});',
      };
    },
  };
  const subject = new MyPortalDataRuntime({
    electronSession: { fromPartition: () => targetSession },
    getPartition: () => 'persist:hkustgz-campus-browser',
    getPortalUrl: () => 'https://myportal.hkust-gz.edu.cn/',
    getSources: () => hkustMyPortalSources,
    now: () => 1_800_000_000_000,
    timeoutMs: 500,
  });
  const snapshot = await subject.snapshot();
  assert.equal(snapshot.modules.schedule.state, 'ready');
  assert.equal(snapshot.modules.schedule.items[0].title, 'Seminar');
  assert.equal(snapshot.modules.news.state, 'ready');
  assert.equal(snapshot.modules.news.items[0].url, 'https://myportal.hkust-gz.edu.cn/news/n1');
  assert.equal(snapshot.modules.loans.state, 'source-unavailable');
  const sourceCalls = calls.slice(1);
  assert.equal(sourceCalls.every((url) => !String(url).includes('tt=')), true);
  const calendarUrl = new URL(sourceCalls.find((url) => String(url).includes('calendarList.rst')));
  assert.match(calendarUrl.href, /categoryIds=-3%2C-2%2C1%2C-4/u);
  const from = new Date(calendarUrl.searchParams.get('fromDate'));
  const through = new Date(calendarUrl.searchParams.get('endDate'));
  const campusWeekday = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'Asia/Shanghai' });
  assert.equal(campusWeekday.format(from), 'Mon');
  assert.equal(campusWeekday.format(through), 'Sun');
  assert.equal(through.getTime() - from.getTime(), 7 * 86_400_000 - 1);
  assert.equal(sourceOptions.every(({ redirect, headers }) => (
    redirect === 'follow' && headers.Accept === '*/*'
  )), true);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-session-nonce/u);
});
