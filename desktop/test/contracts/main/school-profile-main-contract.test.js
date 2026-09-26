'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createT } = require('../../../lib/platform/i18n/i18n');

const desktopRoot = path.join(__dirname, '..', '..', '..');
const main = fs.readFileSync(path.join(desktopRoot, 'main.js'), 'utf8');

function section(startText, endText) {
  const start = main.indexOf(startText);
  const end = main.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `missing source section: ${startText}`);
  return main.slice(start, end);
}

test('composition root resolves one active Profile before credential recovery', () => {
  const sidecarCleanup = main.indexOf('fs.unlinkSync(legacyRuntimeStoragePaths.proxyHelperCredential)');
  const profile = main.indexOf('const activeSchoolProfile = createPreReadySchoolProfileController(');
  const recovery = main.indexOf('recoverCredentialSettingsTransaction(');
  assert.ok(sidecarCleanup >= 0 && profile > sidecarCleanup && recovery > profile);
  assert.match(
    main,
    /const GATEWAY_HOST = syntheticEngineE2e \? '127\.0\.0\.1' : activeSchoolProfile\.gatewayHost/u,
  );
  assert.doesNotMatch(main, /: 'remote\.hkust-gz\.edu\.cn'/u);
});

test('profile drives resources, routes and a Main-resolved official portal home', () => {
  assert.match(main, /resourceLibraryRuntime\.resolveRoutes\(activeSchoolProfile\.mergeResourceLibrary\(\s*settings\.customResources, settings\.hiddenBuiltinResourceIds,/u);
  assert.match(main,
    /serverCampusResources = activeSchoolProfile\.mergeResourceLibrary\(\[\], \[\]\)/u,
    'reviewed per-site routes must feed the shared browser and external PAC policy');
  assert.match(main, /defaultRouteDomains: activeSchoolProfile\.defaultRouteDomains/u);
  assert.match(main, /directPartnerDomains: \(\) => activeSchoolProfile\.directPartnerDomains/u);
  assert.match(main, /homeUrl: officialPortalHomeUrl\(activeSchoolProfile\.createPresentation/u);
  assert.doesNotMatch(main, /homeUrl: activeSchoolProfile\.browserHomeUrl/u);
  assert.match(main, /getWorkspaceResources: \(\) => safeCampusResourceLibrary\(\)/u);
  assert.match(main, /healthTargets: activeSchoolProfile\.healthTargets/u);
  assert.match(main, /gatewayPort: GATEWAY_PORT/u);
});

test('reviewed profile and config binding is validated before credential decryption', () => {
  const connect = section('async function connectOnce(', '\nfunction ensureEngineStopped(');
  const profileConfig = connect.indexOf('engineConfigBinding = activeSchoolProfile.verifyEngineLaunchBinding();');
  const credential = connect.indexOf('const credentialOwner = openVpnCredential(');
  const spawn = connect.indexOf('const started = engineSupervisor.start(');
  assert.ok(profileConfig >= 0 && credential > profileConfig && spawn > credential);
  assert.match(main, /engineConfigBinding = activeSchoolProfile\.verifyEngineLaunchBinding\(\)/u);
  assert.match(connect,
    /profileId: activeSchoolProfile\.activeContextBinding\(\)\.profileId,[\s\S]*memoryBroker: oneShotVpnCredential/u);
  assert.match(connect, /--profile-binding-v1-stdin/u);
  const bindingWrite = connect.indexOf('${engineConfigBinding.stdinFrame}\\n${username}\\n${pw}');
  assert.ok(bindingWrite > profileConfig && bindingWrite > credential && bindingWrite > spawn);
  assert.doesNotMatch(connect, /error\.engineConfigMissing'\s*,\s*\{\s*path/u);
  const privatePath = '/Users/private-person/Applications/config.json';
  assert.equal(createT('zh')('error.engineConfigMissing', { path: privatePath }).includes(privatePath), false);
  assert.equal(createT('en')('error.engineMissing', { path: privatePath }).includes(privatePath), false);
});

test('get-state exposes only bounded profile/account/workspace compatibility views', () => {
  const snapshot = section('const controlStateSnapshot = createControlStateSnapshot(', '\nfor (const [channel, handler]');
  assert.match(snapshot, /activeSchoolProfile\.createPresentation/u);
  for (const forbidden of [
    'engineConfigRef', 'reviewedDnsFallback', 'healthTargets', 'accountKey', 'workspaceKey',
  ]) assert.doesNotMatch(snapshot, new RegExp(forbidden, 'u'));
});
