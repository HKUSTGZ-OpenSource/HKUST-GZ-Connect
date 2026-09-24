'use strict';

// Real two-process Electron restart contract for persisted domain routing.
//
// Run from desktop/ with:
//   node e2e/routing-restart.electron.js
//
// The Node parent creates one temporary userData directory, launches stage 1
// in a fresh Electron process to save rules, then launches stage 2 in another
// Electron process to reload them and exercise the real CampusBrowser/PAC. The
// parent owns hard deadlines and removes userData after both children exit.

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STAGE = process.env.HKUSTGZ_ROUTING_RESTART_STAGE || '';
const PROFILE_ENV = 'HKUSTGZ_ROUTING_RESTART_PROFILE';
const PROFILE_PREFIX = 'hkustgz-routing-restart';
const STAGE_TIMEOUT_MS = 12_000;
const PARENT_TIMEOUT_MS = 28_000;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const WAIT_TIMEOUT_MS = 8_000;
const PROXY_PORT = 46180;
const EXACT_HOST = 'exact.routing-restart.invalid';
const SUBDOMAIN_ROOT = 'sub.routing-restart.invalid';
const EXACT_URL = `http://${EXACT_HOST}:1/first`;
const CHILD_URL = `http://child.${SUBDOMAIN_ROOT}:1/second`;
const UNKNOWN_URL = 'http://unknown.routing-restart.invalid:1/fallback';

function validateProfile(rawProfile) {
  const profile = path.resolve(String(rawProfile || ''));
  if (path.dirname(profile) !== path.resolve(os.tmpdir()) ||
      !path.basename(profile).startsWith(`${PROFILE_PREFIX}-`)) {
    throw new Error('routing restart profile is outside the temporary boundary');
  }
  return profile;
}

function runElectronStage(electronExecutable, profile, stage) {
  return new Promise((resolve, reject) => {
    execFile(electronExecutable, [__filename], {
      env: {
        ...process.env,
        HKUSTGZ_ROUTING_RESTART_STAGE: stage,
        [PROFILE_ENV]: profile,
      },
      timeout: STAGE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_CHILD_OUTPUT_BYTES,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || '').slice(-4096).replaceAll(profile, '<temp-profile>');
        reject(new Error(`routing restart ${stage} failed${detail ? `: ${detail}` : ''}`));
        return;
      }
      if (!String(stdout).includes(`routing restart ${stage}: PASS`)) {
        reject(new Error(`routing restart ${stage} did not emit its completion marker`));
        return;
      }
      resolve();
    });
  });
}

async function runParent() {
  if (process.versions.electron) {
    throw new Error('routing restart parent must run under Node.js');
  }
  const electronExecutable = require('electron');
  if (typeof electronExecutable !== 'string' || !path.isAbsolute(electronExecutable)) {
    throw new Error('Electron executable is unavailable');
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `${PROFILE_PREFIX}-`));
  fs.chmodSync(profile, 0o700);
  let parentTimer = null;
  try {
    await Promise.race([
      (async () => {
        await runElectronStage(electronExecutable, profile, 'stage1');
        await runElectronStage(electronExecutable, profile, 'stage2');
      })(),
      new Promise((_resolve, reject) => {
        parentTimer = setTimeout(
          () => reject(new Error(`routing restart exceeded ${PARENT_TIMEOUT_MS}ms hard timeout`)),
          PARENT_TIMEOUT_MS,
        );
      }),
    ]);
    process.stdout.write('routing restart: PASS\n');
  } finally {
    clearTimeout(parentTimer);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

function electronDependencies() {
  const electron = require('electron');
  const { CampusBrowser } = require('../lib/browser/session/campus-browser');
  const { CAMPUS_PARTITION, ROUTE_CAMPUS, ROUTE_DIRECT } = require('../lib/routing/policy/campus-route');
  const { DomainRoutePolicyStore } = require('../lib/routing/policy/domain-route-policy');
  const { pacDataUrl } = require('../lib/browser/session/browser-session-manager');
  return {
    ...electron,
    CampusBrowser,
    CAMPUS_PARTITION,
    ROUTE_CAMPUS,
    ROUTE_DIRECT,
    DomainRoutePolicyStore,
    pacDataUrl,
  };
}

function createRoutingPolicy(Store, pacDataUrl, filePath, pacSources) {
  const store = new Store({ filePath });
  return {
    store,
    policy: {
      list: () => store.list(),
      resolve: (url, inheritedRoute) => store.resolve(url, inheritedRoute),
      upsert: (payload) => store.upsert(payload),
      proxyConfig: (port) => {
        const source = store.buildPac(port, { campusPrivateIpv4: true });
        pacSources.push(source);
        return {
          mode: 'pac_script',
          pacScript: pacDataUrl(source),
          proxyBypassRules: '<-loopback>',
        };
      },
    },
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(condition, description) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function withTimeout(promise, description) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)),
        WAIT_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

function assertPersistedResolution(store, routes) {
  assert.equal(store.resolve(EXACT_URL).route, routes.ROUTE_DIRECT);
  assert.equal(store.resolve(EXACT_URL).source, 'user-exact');
  assert.equal(store.resolve(CHILD_URL).route, routes.ROUTE_DIRECT);
  assert.equal(store.resolve(CHILD_URL).source, 'user-subdomain');
  assert.equal(store.resolve(UNKNOWN_URL).route, routes.ROUTE_CAMPUS);
}

function createBrowser(dependencies, routingPolicy, errors) {
  return new dependencies.CampusBrowser({
    BrowserWindow: dependencies.BrowserWindow,
    WebContentsView: dependencies.WebContentsView,
    session: dependencies.session,
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 1 }),
    },
    certificateTrust: { isTrusted: () => false, trust: () => {} },
    credentialVault: null,
    parentWindow: () => null,
    toolbarFile: path.join(__dirname, '..', 'renderer', 'campus-browser.html'),
    toolbarPreload: path.join(__dirname, '..', 'lib', 'browser', 'toolbar', 'campus-toolbar-contract.js'),
    campusPreload: path.join(__dirname, '..', 'campus-preload.js'),
    routingPolicy,
    ensureCampusReady: async () => {
      throw new Error('offline direct-route fixture attempted to start the campus tunnel');
    },
    onError: (message) => errors.push(String(message)),
  });
}

async function waitForLocalError(tab, expectedUrl) {
  await waitFor(() => (
    tab && !tab.view.webContents.isDestroyed() &&
    tab.failedUrl === expectedUrl &&
    tab.loading === false &&
    tab.view.webContents.getURL().startsWith('data:text/html')
  ), `local blocked-port error page for ${expectedUrl}`);
}

function assertSingleSession(browser, dependencies) {
  const manager = browser.browserSessionManager;
  const campus = manager.sessionForRoute(dependencies.ROUTE_CAMPUS);
  const direct = manager.sessionForRoute(dependencies.ROUTE_DIRECT);
  assert.ok(campus);
  assert.equal(campus, direct);
  assert.equal(new Set(manager.sessions.values()).size, 1);
  for (const tab of browser.tabs) assert.equal(tab.view.webContents.session, campus);
  return campus;
}

async function closeBrowser(browser) {
  if (!browser) return;
  browser.close();
  await waitFor(() => browser.window === null && browser.tabs.length === 0,
    'campus browser window and tabs to close');
}

async function runStage1(dependencies, profile) {
  const ruleFile = path.join(profile, 'routing-rules.json');
  const { store } = createRoutingPolicy(
    dependencies.DomainRoutePolicyStore,
    dependencies.pacDataUrl,
    ruleFile,
    [],
  );
  store.upsert({
    host: EXACT_HOST,
    includeSubdomains: false,
    route: dependencies.ROUTE_DIRECT,
  }, 100);
  store.upsert({
    host: SUBDOMAIN_ROOT,
    includeSubdomains: true,
    route: dependencies.ROUTE_DIRECT,
  }, 200);
  assertPersistedResolution(store, dependencies);
  if (process.platform === 'win32') {
    const { verifyWindowsFileOwnerOnly } = require('../lib/platform/storage/windows-private-file');
    assert.equal(verifyWindowsFileOwnerOnly(ruleFile), true);
  } else {
    assert.equal(fs.statSync(ruleFile).mode & 0o077, 0);
  }
  process.stdout.write('routing restart stage1: PASS\n');
}

async function runStage2(dependencies, profile) {
  const ruleFile = path.join(profile, 'routing-rules.json');
  const pacSources = [];
  const { store, policy } = createRoutingPolicy(
    dependencies.DomainRoutePolicyStore,
    dependencies.pacDataUrl,
    ruleFile,
    pacSources,
  );
  assert.deepEqual(store.list().map(({ host, includeSubdomains, route }) => ({
    host, includeSubdomains, route,
  })), [
    { host: SUBDOMAIN_ROOT, includeSubdomains: true, route: dependencies.ROUTE_DIRECT },
    { host: EXACT_HOST, includeSubdomains: false, route: dependencies.ROUTE_DIRECT },
  ]);
  assertPersistedResolution(store, dependencies);

  const errors = [];
  const browser = createBrowser(dependencies, policy, errors);
  try {
    await withTimeout(browser.open(CHILD_URL, PROXY_PORT), 'stage2 browser open');
    browser.window.hide();
    await waitForLocalError(browser.activeTab(), CHILD_URL);
    const browserSession = assertSingleSession(browser, dependencies);
    assert.equal(pacSources.length, 1);
    assert.match(pacSources[0], new RegExp(EXACT_HOST.replaceAll('.', '\\.')));
    assert.match(pacSources[0], new RegExp(SUBDOMAIN_ROOT.replaceAll('.', '\\.')));
    assert.equal(await withTimeout(browserSession.resolveProxy(EXACT_URL), 'exact PAC'), 'DIRECT');
    assert.equal(await withTimeout(browserSession.resolveProxy(CHILD_URL), 'subdomain PAC'), 'DIRECT');
    assert.match(
      await withTimeout(browserSession.resolveProxy(UNKNOWN_URL), 'default PAC'),
      /SOCKS5 127\.0\.0\.1:46180/,
    );
    assert.deepEqual(errors, []);
    await withTimeout(browser.suspendRoutingPolicy(), 'final fail-closed PAC');
  } finally {
    await closeBrowser(browser).catch(() => {});
  }
  process.stdout.write('routing restart stage2: PASS\n');
}

async function runElectronStageMain(stage) {
  const dependencies = electronDependencies();
  const profile = validateProfile(process.env[PROFILE_ENV]);
  dependencies.app.setPath('userData', profile);
  dependencies.app.commandLine.appendSwitch('disable-logging');
  dependencies.app.on('window-all-closed', (event) => event.preventDefault());
  await dependencies.app.whenReady();
  if (stage === 'stage1') await runStage1(dependencies, profile);
  else if (stage === 'stage2') await runStage2(dependencies, profile);
  else throw new Error('routing restart stage is invalid');
  dependencies.app.exit(0);
}

if (STAGE) {
  if (!process.versions.electron) {
    process.stderr.write('routing restart stages require Electron\n');
    process.exitCode = 1;
  } else {
    runElectronStageMain(STAGE).catch((error) => {
      process.stderr.write(`${error.stack || error}\n`);
      require('electron').app.exit(1);
    });
  }
} else {
  runParent().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  PARENT_TIMEOUT_MS,
  PROFILE_PREFIX,
  STAGE_TIMEOUT_MS,
  validateProfile,
};
