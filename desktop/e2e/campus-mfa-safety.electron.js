'use strict';

// Real Chromium/preload regression for the Campus Browser credential boundary.
// The isolated HTTPS protocol is served entirely in memory: no school endpoint,
// account, cookie, OTP, or network request is used.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { scheduleTemporaryProfileCleanup } = require('../scripts/temp-profile-cleanup');

const PARTITION = `hkustgz-mfa-e2e-${process.pid}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-mfa-safety-'));
fs.chmodSync(profile, 0o700);
app.setPath('userData', profile);
let profileCleanupScheduled = false;
function scheduleProfileCleanup() {
  if (profileCleanupScheduled) return;
  profileCleanupScheduled = true;
  scheduleTemporaryProfileCleanup(profile, 'hkustgz-mfa-safety');
}
app.once('quit', scheduleProfileCleanup);
process.once('exit', scheduleProfileCleanup);
const TEST_TIMEOUT_MS = 15_000;
const WAIT_TIMEOUT_MS = 3_000;
const SYNTHETIC_LOGIN = 'https://sso.example.invalid/login';
const SYNTHETIC_CHALLENGE = 'https://sso.example.invalid/challenge';
const SYNTHETIC_AMBIGUOUS = 'https://sso.example.invalid/ambiguous-secret';

const loginPage = `<!doctype html>
  <title>Campus sign in</title>
  <form onsubmit="event.preventDefault()">
    <input id="username" autocomplete="username">
    <input id="password" type="password" autocomplete="current-password">
    <button>Sign in</button>
  </form>`;

const challengePage = `<!doctype html>
  <title>Two-factor verification</title>
  <main>Enter the security code, then approve sign-in on your device.</main>
  <form id="explicit" onsubmit="event.preventDefault()">
    <input id="otp" type="password" autocomplete="one-time-code" name="otp">
    <button>Verify</button>
  </form>
  <form id="unlabelled" onsubmit="event.preventDefault()">
    <input id="unlabelled-password-shape" type="password" name="password">
    <button>Continue</button>
  </form>`;

const ambiguousSecretPage = `<!doctype html>
  <title>Continue</title>
  <form id="ambiguous" onsubmit="event.preventDefault()">
    <input id="ambiguous-secret" type="password" inputmode="numeric">
    <button>Continue</button>
  </form>`;

const resources = {
  browser: null,
  campusSession: null,
};

function waitFor(condition, description) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await condition()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${description}`));
      setTimeout(poll, 20);
    };
    poll().catch(reject);
  });
}

async function installSyntheticHttps(campusSession) {
  const handler = (request, callback) => {
    const source = request.url === SYNTHETIC_LOGIN
      ? loginPage
      : request.url === SYNTHETIC_AMBIGUOUS ? ambiguousSecretPage : challengePage;
    callback({ mimeType: 'text/html', charset: 'utf-8', data: Buffer.from(source) });
  };
  await campusSession.protocol.interceptBufferProtocol('https', handler);
}

async function cleanup() {
  resources.browser?.destroy();
  resources.browser = null;
  if (resources.campusSession) {
    await resources.campusSession.protocol.uninterceptProtocol('https');
  }
  resources.campusSession = null;
}

async function run() {
  await app.whenReady();
  const campusSession = session.fromPartition(PARTITION);
  resources.campusSession = campusSession;
  await installSyntheticHttps(campusSession);

  const browser = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '..', 'campus-preload.js'),
      session: campusSession,
    },
  });
  resources.browser = browser;
  let messages = [];
  browser.webContents.on('ipc-message', (_event, channel, value) => {
    messages.push({ channel, value });
  });

  await browser.loadURL(SYNTHETIC_CHALLENGE);
  await waitFor(
    () => messages.some(({ channel, value }) => (
      channel === 'campus-credential-page-state' && value?.hasChallengeForm === true &&
      value?.hasLoginForm === false
    )),
    'challenge-aware page state',
  );
  browser.webContents.send('campus-credential-fill', {
    origin: 'https://sso.example.invalid',
    username: 'synthetic-user',
    password: 'synthetic-campus-password',
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await browser.webContents.executeJavaScript(`({
    otp: document.getElementById('otp').value,
    unlabelled: document.getElementById('unlabelled-password-shape').value,
  })`), { otp: '', unlabelled: '' }, 'campus password must not enter challenge inputs');

  await browser.webContents.executeJavaScript(`
    document.getElementById('otp').value = 'synthetic-otp';
    document.getElementById('explicit').requestSubmit();
  `);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages.some(({ channel }) => channel === 'campus-credential-candidate'), false,
    'submitting a challenge must not create a password-vault candidate');

  messages = [];
  await browser.loadURL(SYNTHETIC_AMBIGUOUS);
  browser.webContents.send('campus-credential-fill', {
    origin: 'https://sso.example.invalid',
    username: 'synthetic-user',
    password: 'synthetic-campus-password',
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await browser.webContents.executeJavaScript(
    "document.getElementById('ambiguous-secret').value",
  ), '', 'an ambiguous single secret must not receive the campus password');
  await browser.webContents.executeJavaScript(`
    document.getElementById('ambiguous-secret').value = 'synthetic-ambiguous-secret';
    document.getElementById('ambiguous').requestSubmit();
  `);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages.some(({ channel }) => channel === 'campus-credential-candidate'), false,
    'an ambiguous single secret must not enter the password vault flow');

  messages = [];
  await browser.loadURL(SYNTHETIC_LOGIN);
  await waitFor(
    () => messages.some(({ channel, value }) => (
      channel === 'campus-credential-page-state' && value?.hasLoginForm === true &&
      value?.hasChallengeForm === false
    )),
    'ordinary password page state',
  );
  browser.webContents.send('campus-credential-fill', {
    origin: 'https://sso.example.invalid',
    username: 'synthetic-user',
    password: 'synthetic-campus-password',
  });
  await waitFor(async () => browser.webContents.executeJavaScript(
    "document.getElementById('password').value === 'synthetic-campus-password'",
  ), 'ordinary password autofill');
  await browser.webContents.executeJavaScript(
    "document.querySelector('form').requestSubmit()",
  );
  await waitFor(
    () => messages.some(({ channel }) => channel === 'campus-credential-candidate'),
    'ordinary password candidate',
  );
  const candidate = messages.find(({ channel }) => channel === 'campus-credential-candidate').value;
  assert.deepEqual(candidate, {
    origin: 'https://sso.example.invalid',
    username: 'synthetic-user',
    password: 'synthetic-campus-password',
  });

  process.stdout.write('campus MFA credential safety: PASS\n');
}

const hardTimeout = setTimeout(() => {
  process.stderr.write('campus MFA credential safety: hard timeout\n');
  void cleanup().finally(() => app.exit(1));
}, TEST_TIMEOUT_MS);

run().then(
  async () => {
    clearTimeout(hardTimeout);
    await cleanup();
    app.quit();
  },
  async (error) => {
    clearTimeout(hardTimeout);
    process.stderr.write(`${error.stack || error}\n`);
    await cleanup();
    app.exit(1);
  },
);
