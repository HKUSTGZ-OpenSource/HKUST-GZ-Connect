'use strict';

const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog } = require('electron');

dialog.showErrorBox = (title, message) => {
  process.stderr.write(`school-onboarding-stage-error: ${title}: ${message}\n`);
};

require('../main');

async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function controlWindow() {
  return waitFor(() => BrowserWindow.getAllWindows().find((window) => (
    window.webContents.getURL().endsWith('/renderer/index.html') &&
    !window.webContents.isLoading()
  )), 'School onboarding control window did not start');
}

async function runOnboarding(control) {
  await waitFor(async () => control.webContents.executeJavaScript(`Boolean(
    window.schoolProfileSelectorFeature &&
    document.getElementById('schoolProfileSelect').options.length >= 2
  )`), 'School selector did not initialize');
  const initial = await control.webContents.executeJavaScript(`(async () => {
    const result = await window.api.listSchoolProfiles();
    return {
      result,
      selected: document.getElementById('schoolProfileSelect').value,
      title: document.title,
    };
  })()`);
  assert.equal(initial.result.ok, true);
  assert.equal(initial.result.profiles.length, 1);
  assert.equal(initial.result.profiles[0].profileId, 'hkustgz');
  assert.equal(initial.selected, 'hkustgz');
  assert.equal(initial.title, 'HKUST(GZ) Connect');
  assert.equal(JSON.stringify(initial.result).includes('profileKey'), false);
  control.setContentSize(420, 560);
  const compact = await control.webContents.executeJavaScript(`(() => {
    const picker = document.querySelector('.school-picker');
    picker.scrollIntoView({ block: 'start' });
    const bounds = picker.getBoundingClientRect();
    return {
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      pickerVisible: bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.height > 0,
    };
  })()`);
  assert.deepEqual(compact, { noHorizontalOverflow: true, pickerVisible: true });

  await control.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('schoolProfileSelect');
    select.value = '__other_school__';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('customSchoolName').value = 'Example University';
    document.getElementById('customGatewayOrigin').value = 'https://vpn.example.edu';
    document.querySelector('.gateway-trust-options').open = true;
    const fingerprint = document.getElementById('customGatewayLeafSha256');
    fingerprint.value = 'ab'.repeat(32);
    fingerprint.focus();
    if (document.activeElement !== fingerprint) throw new Error('Gateway trust field cannot receive focus');
    document.getElementById('probeCustomGateway').click();
  })()`);
  await waitFor(async () => control.webContents.executeJavaScript(`
    !document.getElementById('customGatewayConfirmation').hidden
  `), 'Gateway confirmation did not appear');
  const probed = await control.webContents.executeJavaScript(`(async () => ({
    profiles: await window.api.listSchoolProfiles(),
    summary: document.getElementById('customGatewaySummary').textContent,
    warning: document.querySelector('.gateway-warning').textContent,
    error: document.getElementById('schoolProfileError').textContent,
  }))()`);
  assert.equal(probed.profiles.profiles.length, 1,
    'probe must not create a Profile before explicit confirmation');
  assert.match(probed.summary, /https:\/\/vpn\.example\.edu/u);
  assert.match(probed.summary, /M7\.6\.8R2/u);
  assert.match(probed.summary, /(?:ab){32}/u);
  assert.ok(probed.warning.length > 20);
  assert.equal(probed.error, '');
  const confirmationVisible = await control.webContents.executeJavaScript(`(() => {
    const button = document.getElementById('confirmCustomGateway');
    button.scrollIntoView({ block: 'center' });
    const bounds = button.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= window.innerHeight &&
      bounds.left >= 0 && bounds.right <= window.innerWidth;
  })()`);
  assert.equal(confirmationVisible, true, 'confirmation must remain reachable at minimum size');
  for (const [width, height] of [[420, 560], [840, 900], [1180, 900]]) {
    control.setContentSize(width, height);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const layout = await control.webContents.executeJavaScript(`(() => {
      const summary = document.getElementById('customGatewaySummary');
      const button = document.getElementById('confirmCustomGateway');
      button.scrollIntoView({ block: 'center' });
      button.focus();
      return { overflow: document.documentElement.scrollWidth - window.innerWidth,
        summaryOverflow: summary.scrollWidth - summary.clientWidth, focused: document.activeElement === button };
    })()`);
    assert.ok(layout.overflow <= 1 && layout.summaryOverflow <= 1 && layout.focused,
      `Gateway trust confirmation is inaccessible at ${width}x${height}`);
  }
  process.stdout.write('school onboarding explicit confirmation: PASS\n');
  await control.webContents.executeJavaScript(`
    document.getElementById('confirmCustomGateway').click()
  `);
}

async function verifyCustomBranding(control) {
  const view = await waitFor(async () => {
    const result = await control.webContents.executeJavaScript(`(async () => {
      const profiles = await window.api.listSchoolProfiles();
      const select = document.getElementById('schoolProfileSelect');
      if (!profiles.ok || !select.options.length) return null;
      return {
        profiles,
        selected: select.value,
        title: document.title,
        titlebar: document.getElementById('titlebarText').textContent,
        brand: document.getElementById('brandTitle').textContent,
        school: document.getElementById('connectSchoolName').textContent,
        gateway: document.getElementById('settingsGateway').textContent,
        reviewedLogoHidden: document.getElementById('brandLogo').hidden,
        fallbackHidden: document.getElementById('brandFallback').hidden,
        dashboardTrustVisible: !document.getElementById('profileTrustBadge').hidden,
        settingsTrustVisible: !document.getElementById('settingsTrustBadge').hidden,
      };
    })()`);
    return result?.profiles?.profiles?.some((profile) => profile.active && profile.unverified)
      ? result : null;
  }, 'Custom Profile branding did not initialize');
  const active = view.profiles.profiles.find((profile) => profile.active);
  assert.match(active.profileId, /^custom-[a-f0-9]{32}$/u);
  assert.equal(active.schoolName, 'Example University');
  assert.equal(view.selected, active.profileId);
  assert.equal(view.title, 'HKUST(GZ) Connect');
  assert.equal(view.titlebar, view.title);
  assert.equal(view.brand, view.title);
  assert.equal(view.school, 'Example University');
  assert.equal(view.gateway, 'https://vpn.example.edu');
  assert.equal(view.reviewedLogoHidden, true);
  assert.equal(view.fallbackHidden, false);
  assert.equal(view.dashboardTrustVisible, true);
  assert.equal(view.settingsTrustVisible, true);
  assert.equal(JSON.stringify(view.profiles).includes('profileKey'), false);
  process.stdout.write('school onboarding custom branding: PASS\n');
  app.quit();
}

async function run() {
  await app.whenReady();
  const control = await controlWindow();
  if (process.env.HKUSTGZ_ONBOARDING_STAGE === 'verify') {
    await verifyCustomBranding(control);
    return;
  }
  await runOnboarding(control);
}

const hardTimeout = setTimeout(() => {
  process.stderr.write('school onboarding stage timed out\n');
  app.exit(1);
}, 25_000);

run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
}).finally(() => clearTimeout(hardTimeout));
