'use strict';

// Manual Electron performance and lifecycle gate for the real campus browser.
//
// Run from desktop/ with:
//   ./node_modules/.bin/electron e2e/browser-performance.electron.js
//
// The harness is intentionally not part of `node --test`: it creates dozens of
// real WebContentsView instances and measures wall-clock UI latency, so it
// belongs in a dedicated, machine-aware release gate. All page loads use a
// Chromium-blocked port and settle on CampusBrowser's local error page without
// reaching the network.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const {
  CampusBrowser,
  MAX_TABS,
  SLOW_LOADING_HINT_MS,
} = require('../lib/browser/session/campus-browser');
const { createCampusBrowserWindowOwner } = require('../lib/browser/session/campus-browser-manager');
const { CAMPUS_PARTITION } = require('../lib/routing/policy/campus-route');
const {
  PERFORMANCE_REPORT_SCHEMA,
  writePerformanceReport,
} = require('../scripts/performance-report');
const { scheduleTemporaryProfileCleanup } = require('../scripts/temp-profile-cleanup');

// Expected ERR_UNSAFE_PORT navigations otherwise produce hundreds of Chromium
// diagnostic lines and can bury the actual benchmark report.
app.commandLine.appendSwitch('disable-logging');

const TAB_COUNT = 20;
const SWITCH_SAMPLES = 100;
const SWITCH_WARMUPS = 20;
const PRODUCT_P95_TARGET_MS = 100;
const DEFAULT_DISASTER_P95_GATE_MS = 250;
const DEFAULT_SOAK_CYCLES = 30;
const HARD_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 10;
const WAIT_TIMEOUT_MS = 15_000;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-browser-performance-'));
scheduleTemporaryProfileCleanup(profile, 'hkustgz-browser-performance');
app.setPath('userData', profile);

function positiveIntegerFromEnvironment(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function positiveNumberFromEnvironment(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function percentile(samples, fraction) {
  assert.ok(samples.length > 0, 'percentile requires at least one sample');
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function roundMilliseconds(value) {
  return Math.round(value * 100) / 100;
}

function offlineUrl(namespace, index) {
  // Port 1 is on Chromium's restricted-port list. It fails before DNS or a
  // proxy connection, giving the real error-page path deterministic input.
  return `http://campus-browser-perf.example.invalid:1/${namespace}/${index}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForMain(condition, description, timeout = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForToolbar(browser, expression, description, timeout = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await browser.window.webContents.executeJavaScript(expression)) return;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function installSlowTimerTracker() {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const live = new Set();
  let scheduled = 0;
  let peak = 0;

  function trackedSetTimeout(callback, milliseconds, ...args) {
    if (milliseconds !== SLOW_LOADING_HINT_MS) {
      return originalSetTimeout(callback, milliseconds, ...args);
    }
    let timer = null;
    timer = originalSetTimeout((...callbackArgs) => {
      live.delete(timer);
      callback(...callbackArgs);
    }, milliseconds, ...args);
    live.add(timer);
    scheduled += 1;
    peak = Math.max(peak, live.size);
    return timer;
  }

  function trackedClearTimeout(timer) {
    live.delete(timer);
    return originalClearTimeout(timer);
  }

  global.setTimeout = trackedSetTimeout;
  global.clearTimeout = trackedClearTimeout;

  return {
    live,
    get scheduled() { return scheduled; },
    get peak() { return peak; },
    restore() {
      if (global.setTimeout === trackedSetTimeout) global.setTimeout = originalSetTimeout;
      if (global.clearTimeout === trackedClearTimeout) global.clearTimeout = originalClearTimeout;
    },
  };
}

function createViewTracker() {
  const live = new Set();
  let created = 0;
  let destroyed = 0;

  function TrackedWebContentsView(options) {
    const view = new WebContentsView(options);
    created += 1;
    live.add(view);
    view.webContents.once('destroyed', () => {
      destroyed += 1;
      live.delete(view);
    });
    return view;
  }
  Object.setPrototypeOf(TrackedWebContentsView, WebContentsView);
  TrackedWebContentsView.prototype = WebContentsView.prototype;

  return {
    WebContentsView: TrackedWebContentsView,
    live,
    get created() { return created; },
    get destroyed() { return destroyed; },
  };
}

function toolbarSwitchRoundTrip(browser, tabId) {
  // The duration starts in the sandboxed toolbar immediately before its typed
  // IPC command and ends only after the returned state has rendered the new
  // active tab. This includes IPC, CampusBrowser.switchTab/layout, the 20-tab
  // state projection, and renderer DOM replacement—not just a direct method
  // call in the main process.
  return browser.window.webContents.executeJavaScript(`(() => new Promise((resolve, reject) => {
    const target = ${JSON.stringify(String(tabId))};
    const startedAt = performance.now();
    let timeout = null;
    const active = () => document.querySelector('.tab.active')?.dataset.tabId === target;
    const observer = new MutationObserver(() => {
      if (!active()) return;
      observer.disconnect();
      clearTimeout(timeout);
      resolve(performance.now() - startedAt);
    });
    observer.observe(document.getElementById('tabs'), {
      attributes: true,
      attributeFilter: ['aria-selected', 'class'],
      childList: true,
      subtree: true,
    });
    timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error('toolbar switch timed out for tab ' + target));
    }, 2000);
    if (window.campusToolbar?.command('switch-tab', target) !== true) {
      observer.disconnect();
      clearTimeout(timeout);
      reject(new Error('sandbox toolbar rejected switch-tab ' + target));
      return;
    }
    if (active()) {
      observer.disconnect();
      clearTimeout(timeout);
      resolve(performance.now() - startedAt);
    }
  }))()`);
}

function nextDifferentTabId(tabIds, iteration, currentId) {
  let candidate = tabIds[(iteration * 7 + 3) % tabIds.length];
  if (candidate === currentId) {
    candidate = tabIds[(tabIds.indexOf(candidate) + 1) % tabIds.length];
  }
  return candidate;
}

async function settleOnErrorPage(tab, expectedUrl) {
  await waitForMain(
    () => !tab.view.webContents.isDestroyed() &&
      tab.failedUrl === expectedUrl &&
      tab.loading === false &&
      tab.slowTimer === null &&
      tab.view.webContents.getURL().startsWith('data:text/html'),
    `offline tab ${tab.id} to settle on its local error page`,
  );
}

async function createBaselineTabs(browser) {
  const urls = Array.from({ length: TAB_COUNT }, (_value, index) => offlineUrl('baseline', index));
  await browser.open(urls[0], 11080, 'campus');
  browser.window.hide();
  for (const url of urls.slice(1)) {
    assert.ok(browser.createTab(url, 'campus'), `failed to create baseline tab for ${url}`);
  }
  assert.equal(browser.tabs.length, TAB_COUNT);
  await Promise.all(browser.tabs.map((tab, index) => settleOnErrorPage(tab, urls[index])));
  await waitForToolbar(
    browser,
    `document.querySelectorAll('#tabs [data-tab-id]').length === ${TAB_COUNT}`,
    'all baseline tabs to render in the sandbox toolbar',
  );
}

function assertSandboxAndSingleSession(browser) {
  const toolbarPreferences = browser.window.webContents.getLastWebPreferences();
  assert.equal(toolbarPreferences.sandbox, true, 'toolbar renderer must be sandboxed');
  assert.equal(toolbarPreferences.nodeIntegration, false, 'toolbar must not expose Node.js');
  assert.equal(toolbarPreferences.contextIsolation, true, 'toolbar must retain context isolation');
  assert.equal(browser.window.webContents.session, session.defaultSession);

  const expectedSession = session.fromPartition(CAMPUS_PARTITION);
  const routeSessions = new Set(browser.sessions.values());
  assert.equal(routeSessions.size, 1, 'campus/direct routes must share one browser session');
  assert.equal(browser.campusSession, expectedSession);
  for (const tab of browser.tabs) {
    assert.equal(tab.view.webContents.session, expectedSession, `tab ${tab.id} split SSO session`);
    const preferences = tab.view.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true, `tab ${tab.id} renderer must be sandboxed`);
    assert.equal(preferences.nodeIntegration, false, `tab ${tab.id} must not expose Node.js`);
    assert.equal(preferences.contextIsolation, true, `tab ${tab.id} needs context isolation`);
  }
}

async function measureTabSwitches(browser) {
  const tabIds = browser.tabs.map((tab) => tab.id);
  for (let index = 0; index < SWITCH_WARMUPS; index += 1) {
    const target = nextDifferentTabId(tabIds, index, browser.activeTabId);
    await toolbarSwitchRoundTrip(browser, target);
    assert.equal(browser.activeTabId, target);
  }

  const samples = [];
  for (let index = 0; index < SWITCH_SAMPLES; index += 1) {
    const target = nextDifferentTabId(tabIds, index + SWITCH_WARMUPS, browser.activeTabId);
    samples.push(await toolbarSwitchRoundTrip(browser, target));
    assert.equal(browser.activeTabId, target, 'toolbar and main process active tab diverged');
  }

  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const maximum = Math.max(...samples);
  const configuredGate = positiveNumberFromEnvironment(
    'HKUSTGZ_BROWSER_DISASTER_GATE_MS',
    positiveNumberFromEnvironment('HKUSTGZ_BROWSER_P95_GATE_MS', DEFAULT_DISASTER_P95_GATE_MS),
  );
  const result = {
    samples: samples.length,
    p50Ms: roundMilliseconds(p50),
    p95Ms: roundMilliseconds(p95),
    maxMs: roundMilliseconds(maximum),
    productTargetMs: PRODUCT_P95_TARGET_MS,
    productTargetMet: p95 < PRODUCT_P95_TARGET_MS,
    productTargetEnforced: false,
    disasterGuardMs: configuredGate,
    disasterGuardMet: p95 < configuredGate,
  };
  assert.ok(
    p95 < configuredGate,
    `tab-switch p95 ${result.p95Ms}ms exceeded ${configuredGate}ms gate`,
  );
  return result;
}

async function runSoak(browser, viewTracker, slowTimers, cycles) {
  const baselineTabIds = browser.tabs.map((tab) => tab.id);
  const createdBefore = viewTracker.created;
  const destroyedBefore = viewTracker.destroyed;
  const slowTimersBefore = slowTimers.scheduled;

  for (let index = 0; index < cycles; index += 1) {
    const url = offlineUrl('soak', index);
    const tab = browser.createTab(url, 'campus');
    assert.ok(tab, `soak cycle ${index + 1} could not create a tab`);
    await settleOnErrorPage(tab, url);
    // Electron clears WebContentsView.webContents after destruction. Keep the
    // real WebContents handle so the close assertion observes the object that
    // was actually attached, rather than reading the now-empty view property.
    const contents = tab.view.webContents;
    assert.equal(browser.closeTab(tab.id), true, `soak cycle ${index + 1} could not close its tab`);
    await waitForMain(
      () => contents.isDestroyed() && viewTracker.live.size === TAB_COUNT,
      `soak cycle ${index + 1} view destruction`,
    );

    if ((index + 1) % 25 === 0 || index + 1 === cycles) {
      assert.deepEqual(
        browser.tabs.map((candidate) => candidate.id),
        baselineTabIds,
        `soak cycle ${index + 1} changed the baseline tabs`,
      );
      assert.equal(viewTracker.live.size, TAB_COUNT, `soak cycle ${index + 1} leaked a view`);
      assert.equal(slowTimers.live.size, 0, `soak cycle ${index + 1} leaked a slow timer`);
      for (const baselineTab of browser.tabs) {
        assert.equal(
          baselineTab.pendingCredentialTimer,
          null,
          `soak cycle ${index + 1} leaked a credential timer on tab ${baselineTab.id}`,
        );
      }
    }
  }

  assert.equal(viewTracker.created - createdBefore, cycles, 'unexpected number of created views');
  assert.equal(viewTracker.destroyed - destroyedBefore, cycles, 'not every soak view was destroyed');
  assert.ok(
    slowTimers.scheduled > slowTimersBefore,
    'soak did not exercise the real slow-load timer lifecycle',
  );
  return {
    cycles,
    createdViews: viewTracker.created - createdBefore,
    destroyedViews: viewTracker.destroyed - destroyedBefore,
    finalTabs: browser.tabs.length,
    finalLiveViews: viewTracker.live.size,
    finalLiveSlowTimers: slowTimers.live.size,
    finalLiveCredentialTimers: browser.tabs.filter((tab) => tab.pendingCredentialTimer).length,
  };
}

async function run() {
  assert.ok(TAB_COUNT < MAX_TABS, 'soak needs one free slot above its baseline tabs');
  await app.whenReady();

  const cycles = positiveIntegerFromEnvironment('HKUSTGZ_BROWSER_SOAK_CYCLES', DEFAULT_SOAK_CYCLES);
  const slowTimers = installSlowTimerTracker();
  const viewTracker = createViewTracker();
  const errors = [];
  const browser = new CampusBrowser({
    BrowserWindow,
    createWindowOwner: createCampusBrowserWindowOwner,
    WebContentsView: viewTracker.WebContentsView,
    session,
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
    partition: CAMPUS_PARTITION,
    onError: (message) => errors.push(message),
  });

  let switchMetrics = null;
  let soakMetrics = null;
  try {
    await createBaselineTabs(browser);
    assertSandboxAndSingleSession(browser);
    assert.equal(viewTracker.live.size, TAB_COUNT);
    assert.equal(slowTimers.live.size, 0, 'baseline tabs left slow-load timers alive');

    switchMetrics = await measureTabSwitches(browser);
    soakMetrics = await runSoak(browser, viewTracker, slowTimers, cycles);
    assert.deepEqual(errors, [], `unexpected CampusBrowser errors: ${errors.join('; ')}`);
  } finally {
    browser.close();
    await waitForMain(
      () => browser.window === null && browser.tabs.length === 0 && viewTracker.live.size === 0,
      'final CampusBrowser window, tabs, and views to close',
    ).catch((error) => {
      process.stderr.write(`cleanup warning: ${error.message}\n`);
    });
    slowTimers.restore();
  }

  assert.equal(browser.window, null, 'CampusBrowser retained its closed window');
  assert.equal(browser.tabs.length, 0, 'CampusBrowser retained tabs after close');
  assert.equal(viewTracker.live.size, 0, 'CampusBrowser retained WebContentsView instances');
  assert.equal(viewTracker.created, viewTracker.destroyed, 'created/destroyed view totals diverged');
  assert.equal(slowTimers.live.size, 0, 'CampusBrowser retained slow-load timers');

  const report = {
    schema: PERFORMANCE_REPORT_SCHEMA,
    kind: 'campus_browser_20_tab',
    scope: {
      network: 'none',
      inputs: 'synthetic_chromium_blocked_port',
      gatewayPerformanceMeasured: false,
    },
    tabConfiguration: {
      count: TAB_COUNT,
      toolbarSandboxed: true,
      uniqueSessions: 1,
      offlineErrorPages: TAB_COUNT,
    },
    switch: switchMetrics,
    soak: soakMetrics,
    lifecycleTotals: {
      createdViews: viewTracker.created,
      destroyedViews: viewTracker.destroyed,
      finalTabs: browser.tabs.length,
      finalLiveViews: viewTracker.live.size,
      slowTimersScheduled: slowTimers.scheduled,
      peakLiveSlowTimers: slowTimers.peak,
      finalLiveSlowTimers: slowTimers.live.size,
    },
    interpretation: {
      enforcedThresholdClass: 'offline_disaster_guard',
      productTargetIsNotReleaseGate: true,
      realDeviceAndGatewayBaselineRequired: true,
    },
  };
  writePerformanceReport(report);
}

const hardTimeout = setTimeout(() => {
  process.stderr.write(`browser performance exceeded ${HARD_TIMEOUT_MS}ms hard timeout\n`);
  app.exit(1);
}, HARD_TIMEOUT_MS);
hardTimeout.unref?.();

run().then(
  () => {
    clearTimeout(hardTimeout);
    app.quit();
  },
  (error) => {
    clearTimeout(hardTimeout);
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  },
);

app.once('quit', () => {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
});
