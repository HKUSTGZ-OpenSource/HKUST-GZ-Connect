'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MyPortalDataRuntime, hkustMyPortalSources } = require('../../../lib/browser/session/browser-session-manager');
const { hkustPortalCatalogSource } = require('../../../lib/browser/session/myportal-catalog');

const portalUrl = 'https://myportal.hkust-gz.edu.cn/';
const signInUrl = 'https://sso.hkust-gz.edu.cn/Account/Login?ReturnUrl=synthetic';
const checkedAt = Date.parse('2026-10-29T10:00:00+08:00');

for (const [name, source] of Object.entries({ schedule: hkustMyPortalSources.schedule,
  news: hkustMyPortalSources.news, catalog: hkustPortalCatalogSource })) {
  test(`${name} recognizes followed SSO redirects before consuming authentication content`, async () => {
    let reads = 0;
    const signals = [];
    await assert.rejects(source.read({ portalUrl, checkedAt, timeoutMs: 500,
      session: { fetch: async (_url, options) => {
        signals.push(options.signal);
        return { status: 200, url: signInUrl, redirected: true,
          text: async () => { reads++; throw new Error('authentication body must not be read'); } };
      } },
    }), { code: 'PORTAL_SESSION_EXPIRED' });
    assert.equal(reads, 0);
    assert.ok(signals.every(signal => signal.aborted));
  });
}

test('old portal hints cannot turn an expired session into a generic failure or cached week', async () => {
  let expired = false;
  const runtime = new MyPortalDataRuntime({
    electronSession: { fromPartition: () => ({ fetch: async url => ({
      status: 200, url: expired ? signInUrl : url, redirected: expired,
      headers: { get: () => null }, text: async () => '[]',
    }) }) },
    getPartition: () => 'persist:synthetic-expiry', getPortalUrl: () => portalUrl,
    getSessionUrlHint: () => `${portalUrl}?tt=synthetic-old-hint`,
    getSources: () => ({ schedule: hkustMyPortalSources.schedule }), now: () => checkedAt,
  });
  await runtime.snapshot();
  await runtime.scheduleWeek({ date: '2026-10-12' });
  assert.equal(runtime.calendarCache.size, 1);
  expired = true;
  const denied = await runtime.scheduleWeek({ date: '2026-10-19', force: true });
  assert.equal(denied.modules.schedule.state, 'session-expired');
  assert.equal(runtime.cached, null);
  assert.equal(runtime.calendarCache.size, 0);
  assert.doesNotMatch(JSON.stringify(denied), /ReturnUrl|synthetic-old-hint|Account\/Login/);
  expired = false; // User completed sign-in; no credential automation is involved.
  assert.equal((await runtime.snapshot({ force: true })).modules.schedule.state, 'empty');
});

test('unknown HTML, other origins and unrelated paths do not become invented auth diagnoses', async () => {
  for (const url of ['https://untrusted.example/Account/Login',
    'https://sso.hkust-gz.edu.cn/incorrect-response-url',
    'https://sso.hkust-gz.edu.cn.evil.example/Account/Login',
    'http://sso.hkust-gz.edu.cn/Account/Login', portalUrl]) {
    await assert.rejects(hkustMyPortalSources.schedule.read({ portalUrl, checkedAt, timeoutMs: 500,
      session: { fetch: async () => ({ status: 200, url, headers: { get: () => null },
        text: async () => '<html>Unrecognized response</html>' }) },
    }), { code: 'PORTAL_RESPONSE_INVALID' });
  }
});
