'use strict';

// Isolated source Main/IPC/Renderer acceptance for school-name language changes.
// Local acceptance additionally installs an external outbound guard. The fixture
// substitutes network inventory, update checks and Gateway probes before loading
// Main. Only fresh synthetic userData is used. No credential is saved,
// no Engine is started and the Gateway probe is the existing fixed Node fixture.
// HKUSTGZ_LOCALE_E2E_ACTIVE=hkustgz|custom runs one independent process/mode.
// HKUSTGZ_LOCALE_E2E_OUTPUT is a fresh external output directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');

app.commandLine.appendSwitch('force-prefers-reduced-motion');
const desktop = path.resolve(__dirname, '..');
const activeMode = process.env.HKUSTGZ_LOCALE_E2E_ACTIVE || 'hkustgz';
assert.ok(['hkustgz', 'custom'].includes(activeMode));
assert.equal(app.isPackaged, false, 'This is a source fixture, never an installed app');
assert.equal(app.isReady(), false, 'Install synthetic effects before Main startup');
const output = process.env.HKUSTGZ_LOCALE_E2E_OUTPUT
  ? path.resolve(process.env.HKUSTGZ_LOCALE_E2E_OUTPUT) : null;
if (output) {
  const relative = path.relative(desktop, output);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    'Keep screenshots/receipts outside the checkout');
  fs.mkdirSync(output, { recursive: true });
}
const source = relative => require(path.join(desktop, relative));
const report = { kind: 'actual-main-school-locale', activeMode, platform: process.platform,
  electron: process.versions.electron, passed: false, rows: [], rawSnapshotCalls: 0,
  scope: 'Actual P3/Main/preload/IPC/Renderer; synthetic profile/probe/network only. No credentials, Gateway login, installed data, package or native-close acceptance.' };
let phase = 'fixture setup', control;
const deadline = setTimeout(() => {
  report.failure = `deadline during ${phase}`;
  finish(1);
}, 60_000);
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true; clearTimeout(deadline);
  try {
    if (output) fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report));
  } catch { code = 1; process.stderr.write('school locale fixture receipt write failed\n'); }
  finally { app.exit(code); }
}
dialog.showErrorBox = () => { report.failure = 'Main startup error'; finish(1); };

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-school-locale-'));
fs.chmodSync(userData, 0o700);
report.temporaryProfile = userData;
report.temporaryProfileRetained = true;
app.setPath('userData', userData);
process.env.HKUSTGZ_USER_DATA_DIR = userData;
process.env.HKUSTGZ_SYNTHETIC_NETWORK_E2E = '1';
process.env.HKUSTGZ_SYNTHETIC_GATEWAY_PROBE_E2E = '1';
const { createPrivateStorageEffects, ensureOwnerOnly } = source('lib/platform/storage/private-file');
const { ProfileWorkspaceStartupRuntime } = source('lib/persistence/runtime/profile-workspace-startup-runtime');
const { ProfileCandidateDirectory } = source('lib/profiles/registry/profile-candidate-directory');
const { CustomGatewayConfirmationOwner } = source('lib/profiles/onboarding/custom-gateway-onboarding');
const { CustomProfileProvisioningRuntime } = source('lib/profiles/provisioning/custom-profile-provisioning-runtime');
const { PROTOCOL_FAMILY } = source('lib/profiles/schema/school-profile-schema');
const { saveSettings } = source('lib/persistence/settings/settings-store');
const effects = createPrivateStorageEffects({ fileSystem: fs, platform: process.platform });
function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
  assert.equal(ensureOwnerOnly(file), true, 'Synthetic metadata must retain native private permissions');
}
saveSettings(path.join(userData, 'settings.json'), { autoConnect: false, startAtLogin: false, language: 'en' });
const reviewed = new ProfileWorkspaceStartupRuntime({ userData, safeStorage: {},
  profile: JSON.parse(fs.readFileSync(path.join(desktop, 'assets/profiles/hkustgz/school-profile.json'), 'utf8')),
}).initialize();
assert.equal(reviewed.mode, 'profile-workspace');
const candidates = new ProfileCandidateDirectory({ userData, packageRoot: desktop, desktopDir: desktop,
  resourcesPath: '/unused', isPackaged: false, profileStorageEffects: effects });
candidates.anchorReviewedCurrent({ profileId: 'hkustgz',
  profileKey: reviewed.authority.globalSettings.activeProfileKey,
  accountKey: reviewed.authority.globalSettings.activeAccountKey });
const CUSTOM_LABEL = 'Locale Fixture University';
let seed = 1;
const confirmationOwner = new CustomGatewayConfirmationOwner({ randomBytes: length => Buffer.alloc(length, seed++),
  now: Date.now, ttlMs: 10_000 });
const activeContext = { profileId: 'hkustgz', profileRevision: 1,
  accountHandle: `account-${'a'.repeat(36)}`, activeContextEpoch: 7 };
const issued = confirmationOwner.issue({ activeContext, schoolLabel: CUSTOM_LABEL, probeResult: {
  schema_version: 1, normalized_origin: 'https://locale-custom.example.edu', https_identity_valid: true,
  compatibility: 'recognized_candidate', candidate_family: PROTOCOL_FAMILY, reported_version: 'M7.6.8R2', http_status: 200,
} });
let provisionSeed = 80;
const custom = new CustomProfileProvisioningRuntime({ userData, profileStorageEffects: effects,
  randomBytes: length => Buffer.alloc(length, ++provisionSeed), now: Date.now,
}).begin(confirmationOwner.consume({ confirmationHandle: issued.confirmationHandle, activeContext }));
const chosen = activeMode === 'custom' ? custom.context : {
  profileKey: reviewed.authority.globalSettings.activeProfileKey,
  accountKey: reviewed.authority.globalSettings.activeAccountKey,
};
writePrivateJson(path.join(userData, 'global/settings.json'), {
  ...reviewed.authority.globalSettings, activeProfileKey: chosen.profileKey, activeAccountKey: chosen.accountKey,
  language: 'en', startAtLogin: false, closeAction: 'minimize',
});
const ACTIVE = activeMode === 'custom' ? custom.profileId : 'hkustgz';
const INACTIVE = activeMode === 'custom' ? 'hkustgz' : custom.profileId;
const OTHER = '__other_school__';
const DRAFT = { name: 'Unsubmitted locale draft', gateway: 'https://locale-draft.example.edu' };

const { NetworkEnvironmentService } = source('lib/network-environment/runtime/network-environment-service');
const originalRaw = NetworkEnvironmentService.prototype.rawSnapshot;
const syntheticNetwork = Object.freeze({ platform: process.platform, status: 'ready', interfaces: Object.freeze([]),
  defaultRoute: null, systemRoute: null, systemProxy: Object.freeze({ state: 'none', type: 'none', endpoint: null, owner: Object.freeze({}) }) });
NetworkEnvironmentService.prototype.rawSnapshot = async function () {
  report.rawSnapshotCalls++; this.cached = syntheticNetwork; this.cachedAt = this.now(); return syntheticNetwork;
};
const updates = source('lib/platform/update/update-check');
const OriginalUpdater = updates.UpdateNotificationRuntime;
updates.UpdateNotificationRuntime = class extends OriginalUpdater {
  constructor(ports) { super({ ...ports, check: async () => null }); }
};
require(path.join(desktop, 'main'));
updates.UpdateNotificationRuntime = OriginalUpdater;
app.once('quit', () => {
  NetworkEnvironmentService.prototype.rawSnapshot = originalRaw;
  // A parent supervisor should verify process closure before retiring this
  // fixture's directory on Windows; a failed in-process cleanup is not a pass.
});

const evaluate = expression => control.webContents.executeJavaScript(expression);
async function waitFor(predicate, label) {
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Fixture did not settle: ${label}`);
}
async function expectedViews() {
  const value = await evaluate(`(async () => ({ state: await window.api.getState(), list: await window.api.listSchoolProfiles() }))()`);
  assert.equal(value.list.ok, true); assert.equal(value.list.profiles.length, 2);
  assert.equal(value.state.schoolProfile.profileId, ACTIVE);
  assert.equal(value.state.hasPassword, false); assert.equal(value.state.loggedIn, false); assert.equal(value.state.connected, false);
  assert.equal(value.list.profiles.find(item => item.profileId === custom.profileId).schoolName, CUSTOM_LABEL);
  assert.equal(value.list.profiles.find(item => item.active).profileId, ACTIVE);
  return { locale: value.state.locale, language: value.state.settings.language,
    profiles: value.list.profiles.map(({ profileId, schoolName }) => ({ profileId, schoolName })) };
}
async function checkView(expected, selected, step) {
  const activeName = expected.profiles.find(item => item.profileId === ACTIVE).schoolName;
  report.expected = { ...expected, selected, step };
  await waitFor(async () => evaluate(`(() => {
    const expected = ${JSON.stringify(expected)}, select = document.getElementById('schoolProfileSelect');
    return document.documentElement.lang === (expected.locale === 'zh' ? 'zh-CN' : 'en') &&
      select.value === ${JSON.stringify(selected)} && expected.profiles.every(item =>
        [...select.options].some(option => option.value === item.profileId && option.textContent.startsWith(item.schoolName))) &&
      document.getElementById('connectSchoolName').textContent === ${JSON.stringify(activeName)} &&
      document.getElementById('brandSub').textContent.startsWith(${JSON.stringify(activeName + ' · ')});
  })()`), `${step} names and selection`);
  const observed = await evaluate(`(() => ({
    language: document.documentElement.lang, selected: document.getElementById('schoolProfileSelect').value,
    brand: document.getElementById('brandSub').textContent,
    options: [...document.getElementById('schoolProfileSelect').options].map(node => ({ value: node.value, text: node.textContent })),
    draftName: document.getElementById('customSchoolName').value, draftGateway: document.getElementById('customGatewayOrigin').value,
    editing: !document.getElementById('customSchoolPanel').hidden, confirming: !document.getElementById('customGatewayConfirmation').hidden,
    credentialProfile: window.schoolProfileSelectorFeature.credentialProfileId(),
    loginDisabled: ['lgUser','lgPass','lgBtn'].every(id => document.getElementById(id).disabled),
    summary: document.getElementById('customGatewaySummary').textContent,
    fingerprint: document.getElementById('gatewayObservedFingerprint').textContent,
  }))()`);
  assert.equal(observed.credentialProfile, selected === ACTIVE ? ACTIVE : null);
  if (selected !== ACTIVE) assert.equal(observed.loginDisabled, true);
  if (selected === OTHER) {
    assert.equal(observed.draftName, DRAFT.name); assert.equal(observed.draftGateway, DRAFT.gateway);
    assert.equal(observed.confirming, step === 'confirmation'); assert.equal(observed.editing, step !== 'confirmation');
    if (step === 'confirmation') { assert.ok(observed.summary.includes(DRAFT.gateway)); assert.equal(observed.fingerprint, 'ab'.repeat(32)); }
  }
  report.rows.push({ step, requested: expected.language, effectiveLocale: expected.locale,
    activeName, selected, options: observed.options, credentialGate: observed.credentialProfile,
    editing: observed.editing, confirming: observed.confirming });
}
async function layout(step, language) {
  if (language === 'auto' || step === 'inactive') return;
  const target = step === 'confirmation' ? 'confirmCustomGateway' : step === 'draft' ? 'customSchoolName' : 'schoolProfileSelect';
  for (const [width, height, zoom] of [[440, 560, 1], [840, 900, 1.25], [1180, 900, 1]]) {
    control.setContentSize(width, height); control.webContents.setZoomFactor(zoom);
    await waitFor(async () => {
      const native = control.getContentSize();
      const viewport = await evaluate('[innerWidth,innerHeight]');
      return native[0] === width && native[1] === height &&
        Math.abs(viewport[0] * zoom - width) <= 1 && Math.abs(viewport[1] * zoom - height) <= 1;
    }, 'native resize and zoom');
    let nextFocus;
    await evaluate(`document.getElementById('${target}').scrollIntoView({block:'center'}); document.getElementById('${target}').focus();`);
    for (const modifiers of [[], ['shift']]) {
      control.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers});
      control.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers});
      await waitFor(() => evaluate(`document.activeElement.id ${modifiers.length ? '===' : '!=='} '${target}'`),
        modifiers.length ? 'Shift Tab return' : 'Tab departure');
      if (!modifiers.length) nextFocus = await evaluate('document.activeElement.id');
    }
    const actual = await evaluate(`(() => {
      const target = document.getElementById('${target}'), picker = document.getElementById('schoolPicker');
      const bounds = target.getBoundingClientRect(), style = getComputedStyle(target);
      return { viewport: [innerWidth, innerHeight], overflow: document.documentElement.scrollWidth-innerWidth,
        pickerOverflow: picker.scrollWidth-picker.clientWidth, focused: document.activeElement.id,
        visibleFocus: target.matches(':focus-visible') && (style.outlineStyle !== 'none' || style.boxShadow !== 'none'),
        targetReachable: bounds.left >= 0 && bounds.right <= innerWidth+1 && bounds.top >= 0 && bounds.bottom <= innerHeight+1,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
    })()`);
    assert.ok(actual.overflow <= 1 && actual.pickerOverflow <= 1, 'School picker must not overflow');
    assert.equal(actual.focused, target); assert.equal(actual.visibleFocus, true);
    assert.equal(actual.targetReachable, true); assert.equal(actual.reducedMotion, true);
    const label = `${step}-${language}-${width}-${zoom}`;
    report.layouts ??= []; report.layouts.push({ label, width, height, zoom, nativeSize: control.getContentSize(), nextFocus, ...actual });
    if (output) fs.writeFileSync(path.join(output, label+'.png'), (await control.webContents.capturePage()).toPNG(), {flag:'wx'});
  }
  control.webContents.setZoomFactor(1); control.setContentSize(840,900);
}
async function changeLanguage(language, selected, step) {
  phase = `${step}/${language}`;
  const focus = step === 'confirmation' ? 'confirmCustomGateway' : step === 'draft' ? 'customGatewayOrigin' : 'schoolProfileSelect';
  await evaluate(`document.getElementById('${focus}').focus()`);
  const saved = await evaluate(`window.api.save({ language: ${JSON.stringify(language)} })`);
  assert.equal(saved.ok, true, 'Language save must use real IPC successfully');
  const expected = await expectedViews(); assert.equal(expected.language, language);
  const before = await evaluate('window.schoolLocaleFixtureRefreshes');
  await evaluate("document.dispatchEvent(new Event('visibilitychange'))");
  await waitFor(() => evaluate(`window.schoolLocaleFixtureRefreshes > ${before}`), 'real state refresh event');
  await checkView(expected, selected, step);
  assert.equal(await evaluate('document.activeElement.id'), focus, 'Locale redraw must preserve focus');
  await layout(step, language);
}
async function select(value) {
  await evaluate(`(() => { const select = document.getElementById('schoolProfileSelect'); select.value=${JSON.stringify(value)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
}
async function run() {
  await app.whenReady(); phase = 'control window';
  await waitFor(() => {
    control = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/renderer/index.html') && !window.webContents.isLoading());
    return Boolean(control);
  }, phase);
  control.webContents.setBackgroundThrottling(false); control.show(); control.focus(); control.webContents.focus();
  await waitFor(() => evaluate("!document.hidden && !!window.schoolProfileSelectorFeature && document.getElementById('schoolProfileSelect').options.length === 3"), 'school list');
  await evaluate("window.schoolLocaleFixtureRefreshes=0; document.addEventListener('app-state-refreshed',()=>{window.schoolLocaleFixtureRefreshes++;});");
  for (const language of ['zh','en','auto']) await changeLanguage(language, ACTIVE, 'active');
  await select(INACTIVE);
  for (const language of ['zh','en','auto']) await changeLanguage(language, INACTIVE, 'inactive');
  await select(OTHER);
  await evaluate(`document.getElementById('customSchoolName').value=${JSON.stringify(DRAFT.name)}; document.getElementById('customGatewayOrigin').value=${JSON.stringify(DRAFT.gateway)};`);
  for (const language of ['zh','en','auto']) await changeLanguage(language, OTHER, 'draft');
  phase = 'synthetic Gateway confirmation';
  await evaluate("document.getElementById('probeCustomGateway').click()");
  await waitFor(() => evaluate("!document.getElementById('customGatewayConfirmation').hidden"), phase);
  for (const language of ['zh','en','auto']) await changeLanguage(language, OTHER, 'confirmation');
  await evaluate("document.getElementById('confirmCustomGateway').focus(); document.getElementById('backCustomGateway').addEventListener('click', event => { document.documentElement.dataset.localeBackTrusted=String(event.isTrusted); }, {once:true});");
  for (const type of ['keyDown', 'keyUp']) control.webContents.sendInputEvent({type,keyCode:'Tab'});
  await waitFor(() => evaluate("document.activeElement.id === 'backCustomGateway'"), 'keyboard Back focus');
  control.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
  control.webContents.sendInputEvent({type:'char',keyCode:String.fromCharCode(13)});
  control.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
  await waitFor(() => evaluate("document.documentElement.dataset.localeBackTrusted === 'true'"), 'trusted keyboard Back activation');
  report.keyboardBackTrusted = true;
  await waitFor(() => evaluate("!document.getElementById('customSchoolPanel').hidden"), 'back to retained draft');
  await checkView(await expectedViews(), OTHER, 'draft');
  assert.ok(report.rawSnapshotCalls > 0);
  assert.equal((await evaluate('window.api.listSchoolProfiles()')).profiles.length, 2, 'Probe/locale changes must not create or switch a school');
  if (output) fs.writeFileSync(path.join(output, 'final.png'), (await control.webContents.capturePage()).toPNG(), { flag: 'wx' });
  await evaluate('window.api.cancelCustomGateway()');
  report.passed = true; phase = 'complete'; finish(0);
}
run().catch(async error => {
  report.failure = error.message; report.phase = phase;
  if (control && !control.isDestroyed()) {
    try {
      report.failureSnapshot = await evaluate(`({
        locale: document.documentElement.lang,
        selected: document.getElementById('schoolProfileSelect').value,
        options: [...document.getElementById('schoolProfileSelect').options].map(node => ({value:node.value,text:node.textContent})),
        school: document.getElementById('connectSchoolName').textContent,
        brand: document.getElementById('brandSub').textContent,
        error: document.getElementById('schoolProfileError').textContent
      })`);
      if (output) fs.writeFileSync(path.join(output, 'failure.png'), (await control.webContents.capturePage()).toPNG());
    } catch { report.failureSnapshotUnavailable = true; }
  }
  finish(1);
});
