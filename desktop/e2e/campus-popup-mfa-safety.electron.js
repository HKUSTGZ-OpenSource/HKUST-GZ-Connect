'use strict';

// Real Electron/WebContentsView coverage for a cross-origin popup MFA flow.
// Every page, cookie, credential and challenge is synthetic and served from an
// in-memory protocol handler; no school endpoint or real account is touched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const { CampusBrowser } = require('../lib/browser/session/campus-browser');
const { CAMPUS_PARTITION } = require('../lib/routing/policy/campus-route');

const WAIT_TIMEOUT_MS = 5_000;
const LOGIN_URL = 'https://sso.example.invalid/login';
const CHALLENGE_URL = 'https://mfa.example.invalid/challenge';
const profile = process.argv[2];
if (typeof profile !== 'string' || !path.isAbsolute(profile) ||
    path.dirname(profile) !== fs.realpathSync(os.tmpdir()) ||
    !/^hkustgz-popup-mfa-[a-zA-Z0-9]+$/u.test(path.basename(profile)) ||
    fs.lstatSync(profile).isSymbolicLink() || !fs.lstatSync(profile).isDirectory()) {
  throw new Error('MFA fixture requires an isolated Node-parent profile');
}
app.setPath('userData', profile);
// The parent owns the 20-second deadline and observes process close before file removal.
app.on('window-all-closed', () => {});
process.on('unhandledRejection', error => {
  process.stderr.write(`${error?.stack || error}\n`);
  app.exit(1);
});

const loginPage = `<!doctype html>
  <title>Synthetic SSO</title>
  <form id="login">
    <input id="username" autocomplete="username">
    <input id="password" type="password" autocomplete="current-password">
    <button>Sign in</button>
  </form>
  <script>
    window.addEventListener('message', (event) => {
      if (event.origin === 'https://mfa.example.invalid' &&
          event.data === 'synthetic-mfa-complete') {
        document.body.innerHTML = '<main id="complete">Signed in</main>';
      }
    });
    document.getElementById('login').addEventListener('submit', (event) => {
      event.preventDefault();
      document.cookie = 'synthetic_sso=ready; Domain=example.invalid; Path=/; SameSite=Lax; Secure';
      window.open(${JSON.stringify(CHALLENGE_URL)}, 'synthetic-mfa');
      document.body.innerHTML = '<main id="waiting">Waiting for verification</main>';
    });
  </script>`;

const challengePage = `<!doctype html>
  <title>Synthetic MFA</title>
  <main>Enter a second factor.</main>
  <output id="cookie"></output>
  <form id="challenge">
    <input id="otp" type="password" autocomplete="one-time-code" name="otp">
    <button>Verify</button>
  </form>
  <script>
    document.getElementById('cookie').textContent = document.cookie;
    document.getElementById('challenge').addEventListener('submit', (event) => {
      event.preventDefault();
      window.opener.postMessage('synthetic-mfa-complete', 'https://sso.example.invalid');
      window.close();
    });
  </script>`;

let browser = null;
let campusSession = null;

async function waitFor(condition, description) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function installSyntheticHttps(targetSession) {
  await targetSession.protocol.interceptBufferProtocol('https', (request, callback) => {
    const page = request.url === LOGIN_URL ? loginPage : challengePage;
    callback({ mimeType: 'text/html', charset: 'utf-8', data: Buffer.from(page) });
  });
}

async function cleanup() {
  browser?.close();
  browser = null;
  if (campusSession) await campusSession.protocol.uninterceptProtocol('https');
  campusSession = null;
}

async function run() {
  await app.whenReady();
  campusSession = session.fromPartition(CAMPUS_PARTITION);
  await installSyntheticHttps(campusSession);
  const prompts = [];
  const saved = [];
  const errors = [];
  browser = new CampusBrowser({
    BrowserWindow,
    WebContentsView,
    session,
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async (_window, options) => {
        prompts.push(options);
        return { response: 0 };
      },
    },
    certificateTrust: { isTrusted: () => false, trust: () => {} },
    credentialVault: {
      get: async () => null,
      save: async (...credential) => saved.push(credential),
    },
    parentWindow: () => null,
    toolbarFile: path.join(__dirname, '..', 'renderer', 'campus-browser.html'),
    toolbarPreload: path.join(__dirname, '..', 'lib', 'browser', 'toolbar', 'campus-toolbar-contract.js'),
    campusPreload: path.join(__dirname, '..', 'campus-preload.js'),
    partition: CAMPUS_PARTITION,
    ensureCampusReady: async () => true,
    onError: (message) => errors.push(message),
  });

  await browser.open(LOGIN_URL, 11080, 'campus');
  browser.window.hide();
  const owner = browser.activeTab();
  const ownerContents = owner.view.webContents;
  ownerContents.send('campus-credential-fill', {
    origin: 'https://sso.example.invalid',
    username: 'synthetic-user',
    password: 'synthetic-campus-password',
  });
  await waitFor(
    () => ownerContents.executeJavaScript(
      "document.getElementById('password')?.value === 'synthetic-campus-password'",
    ),
    'ordinary password autofill',
  );
  await ownerContents.executeJavaScript("document.getElementById('login').requestSubmit()");

  await waitFor(
    () => BrowserWindow.getAllWindows().some((window) => window !== browser.window),
    'managed native MFA popup',
  );
  const popupWindow = BrowserWindow.getAllWindows().find((window) => window !== browser.window);
  const popupContents = popupWindow.webContents;
  assert.equal(browser.tabs.length, 1, 'an authentication popup is not flattened into a tab');
  assert.equal(popupContents.session, ownerContents.session,
    'cross-origin SSO tabs must share one persistent Electron Session');
  assert.equal(browser.managedCredentialPopups.size, 1);
  const popup = [...browser.managedCredentialPopups][0];
  assert.equal(popup.pendingCredential, null, 'the popup must not receive the staged password');
  await waitFor(
    () => owner.pendingCredential?.challengeObserved === true,
    'popup challenge observation',
  );
  assert.equal(prompts.length, 0, 'the waiting opener cannot prompt during popup MFA');

  const popupState = await popupContents.executeJavaScript(`({
    otp: document.getElementById('otp').value,
    cookie: document.getElementById('cookie').textContent,
  })`);
  assert.equal(popupState.otp, '', 'the campus password must not enter the popup OTP field');
  assert.match(popupState.cookie, /synthetic_sso=ready/,
    'the cross-origin popup must retain the shared SameSite session cookie');

  await popupContents.executeJavaScript(`(() => {
    document.getElementById('otp').value = 'synthetic-otp';
    document.getElementById('challenge').requestSubmit();
  })()`);
  await waitFor(() => popupWindow.isDestroyed(), 'MFA popup self-close');
  assert.equal(browser.managedCredentialPopups.size, 0,
    'a closed authentication popup must release its flow ownership');
  assert.equal(browser.ownsWebContents(popupContents), false,
    'a closed authentication popup must lose privileged browser ownership');
  await waitFor(
    () => ownerContents.executeJavaScript("Boolean(document.getElementById('complete'))"),
    'opener completion message',
  );
  await waitFor(() => prompts.length === 1, 'post-challenge credential prompt');
  assert.deepEqual(saved, [[
    'https://sso.example.invalid', 'synthetic-user', 'synthetic-campus-password',
  ]]);
  assert.equal(owner.pendingCredential, null);
  assert.deepEqual(errors, []);
  process.stdout.write('campus popup MFA assertions: PASS\n');
}

async function main() {
  let failed = false;
  try { await run(); }
  catch (error) {
    failed = true;
    process.stderr.write(`${error.stack || error}\n`);
  }
  try { await cleanup(); }
  catch (error) {
    failed = true;
    process.stderr.write(`MFA runtime cleanup failed: ${error.message}\n`);
  }
  app.exit(failed ? 1 : 0);
}
void main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
