'use strict';

// Only in-memory HTTPS responses and a disposable profile. No school network,
// installed profile, credentials, Cookie jar or system proxy is used.
const { app, session, net } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MyPortalDataRuntime, hkustMyPortalSources } = require('../lib/browser/session/browser-session-manager');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-portal-expiry-'));
app.setPath('userData', root);
let timer;

async function run() {
  await app.whenReady();
  const isolated = session.fromPartition('portal-expiry-fixture');
  const portal = 'https://myportal.hkust-gz.edu.cn/';
  const login = 'https://sso.hkust-gz.edu.cn/Account/Login';
  let signedIn = true;
  let stall = false;
  let signInRequests = 0;
  isolated.protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.href === login) {
      signInRequests++;
      return new Response('<!doctype html><title>Synthetic sign-in</title>',
        { headers: { 'Content-Type': 'text/html' } });
    }
    if (url.origin !== new URL(portal).origin) throw new Error('unexpected fixture origin');
    if (!signedIn) return Response.redirect(login, 302);
    if (url.pathname === '/') return new Response('<!doctype html><title>Synthetic portal</title>');
    if (!url.pathname.endsWith('calendarList.rst')) throw new Error('unexpected fixture API');
    if (stall) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('[')); } }));
    return new Response(JSON.stringify([{ id: 'synthetic-course', title: 'Synthetic course',
      startTime: '2026-10-29 10:00:00', endTime: '2026-10-29 11:00:00' }]),
    { headers: { 'Content-Type': 'application/json' } });
  });
  isolated.protocol.handle('http', () => { throw new Error('insecure fixture request'); });
  const runtime = new MyPortalDataRuntime({
    electronSession: { fromPartition: () => isolated }, electronNet: net,
    getPartition: () => 'persist:synthetic-portal-expiry', getPortalUrl: () => portal,
    getSessionUrlHint: () => `${portal}?tt=synthetic-hint`,
    getSources: () => ({ schedule: hkustMyPortalSources.schedule }),
    now: () => Date.parse('2026-10-29T10:00:00+08:00'), timeoutMs: 500,
  });
  try {
    assert.equal((await runtime.snapshot()).modules.schedule.state, 'ready');
    await runtime.scheduleWeek({ date: '2026-10-12' });
    signedIn = false;
    const expired = await runtime.refreshSchedule();
    assert.equal(signInRequests, 0, 'the native redirect is stopped before requesting authentication content');
    assert.equal(expired.modules.schedule.state, 'session-expired');
    assert.equal(runtime.cached, null);
    assert.equal(runtime.calendarCache.size, 0);
    assert.doesNotMatch(JSON.stringify(expired), /Synthetic course|Account\/Login|synthetic-hint/);
    signedIn = true; // Simulates completion by the user, not an automated login.
    const recovered = await runtime.snapshot({ force: true });
    assert.equal(recovered.modules.schedule.state, 'ready');
    assert.equal(recovered.modules.schedule.items.length, 1);
    stall = true;
    assert.equal((await runtime.refreshSchedule()).modules.schedule.state, 'failed');
    stall = false;
    assert.equal((await runtime.refreshSchedule()).modules.schedule.state, 'ready');
    runtime.getSessionUrlHint = () => null; signedIn = false;
    assert.equal((await runtime.snapshot({ force: true })).sessionState, 'unauthenticated');
    signedIn = true;
    assert.equal((await runtime.snapshot({ force: true })).modules.schedule.state, 'ready');
    console.log('portal session expiry: PASS (Chromium redirect, cache revocation, recovery; no external requests)');
  } finally {
    isolated.protocol.unhandle('https'); isolated.protocol.unhandle('http');
    await isolated.closeAllConnections();
  }
}

Promise.race([run(), new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error('portal expiry fixture deadline')), 20_000);
})]).then(() => 0).catch(error => { console.error(error); return 1; }).then(code => {
  clearTimeout(timer); app.exit(code);
});
