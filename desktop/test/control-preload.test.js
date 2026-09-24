'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadPreload() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const invocations = [];
  const listeners = new Map();
  let exposed = null;
  const ipcRenderer = {
    invoke(channel, payload) {
      invocations.push({ channel, payload, argumentCount: arguments.length });
      return Promise.resolve({ channel, payload });
    },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
  };
  vm.runInNewContext(source, {
    require(request) {
      assert.equal(request, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, 'api');
            exposed = value;
          },
        },
        ipcRenderer,
      };
    },
  }, { filename: 'preload.js' });
  return { api: exposed, invocations, listeners };
}

test('control preload exposes narrow routing-rule IPC methods', async () => {
  const { api, invocations } = loadPreload();
  assert.equal(typeof api.invoke, 'undefined', 'must not expose raw ipcRenderer.invoke');
  assert.equal(typeof api.send, 'undefined', 'must not expose raw ipcRenderer.send');

  const rule = {
    host: 'login.microsoftonline.com',
    includeSubdomains: false,
    route: 'direct',
    previous: { host: 'old.example', includeSubdomains: true },
  };
  const identity = { host: rule.host, includeSubdomains: false };
  await api.listRoutingRules();
  await api.saveRoutingRule(rule);
  await api.deleteRoutingRule(identity);

  assert.deepEqual(invocations.map(({ channel }) => channel), [
    'list-routing-rules',
    'save-routing-rule',
    'delete-routing-rule',
  ]);
  assert.equal(invocations[0].argumentCount, 1, 'list has no renderer-controlled payload');
  assert.equal(invocations[1].payload, rule, 'save forwards only the explicit rule value');
  assert.equal(invocations[2].payload, identity, 'delete forwards only the stable identity');
});

test('raw account identity is available only through an explicit login-flow IPC', async () => {
  const { api, invocations } = loadPreload();
  await api.getLoginAccount();
  assert.deepEqual(invocations, [{
    channel: 'get-login-account', payload: undefined, argumentCount: 1,
  }]);
});

test('memory-only VPN credential ownership is never exposed to Renderer', () => {
  const { api } = loadPreload();
  for (const forbidden of [
    'stageOneShotCredential', 'takeOneShotCredential', 'clearOneShotCredential',
    'getOneShotCredential',
  ]) {
    assert.equal(typeof api[forbidden], 'undefined');
  }
});

test('browser-data clearing is a value-free workspace operation', async () => {
  const { api, invocations } = loadPreload();
  await api.clearBrowserData();
  assert.deepEqual(invocations, [{
    channel: 'clear-browser-data', payload: undefined, argumentCount: 1,
  }]);
});

test('campus data uses value-free snapshot and refresh operations', async () => {
  const { api, invocations } = loadPreload();
  await api.getCampusData();
  await api.refreshCampusData();
  await api.refreshCampusSchedule();
  assert.deepEqual(invocations.map(({ channel, argumentCount }) => ({ channel, argumentCount })), [
    { channel: 'get-campus-data', argumentCount: 1 },
    { channel: 'refresh-campus-data', argumentCount: 1 },
    { channel: 'refresh-campus-schedule', argumentCount: 1 },
  ]);
  for (const forbidden of ['getPortalCookie', 'getPortalPassword', 'getPortalToken']) {
    assert.equal(typeof api[forbidden], 'undefined');
  }
});

test('control preload exposes narrow certificate-pin IPC methods', async () => {
  const { api, invocations } = loadPreload();
  const identity = { origin: 'https://legacy-campus.example:4433' };
  await api.listCertificatePins();
  await api.deleteCertificatePin(identity);

  assert.deepEqual(invocations.map(({ channel }) => channel), [
    'list-certificate-pins',
    'delete-certificate-pin',
  ]);
  assert.equal(invocations[0].argumentCount, 1, 'list has no renderer-controlled payload');
  assert.equal(invocations[1].payload, identity);
});

test('control preload exposes only bounded school onboarding operations', async () => {
  const { api, invocations } = loadPreload();
  const probe = { origin: 'https://vpn.example.edu', schoolLabel: 'Example University' };
  const confirmation = { confirmationHandle: 'confirmation-123' };
  await api.listSchoolProfiles();
  await api.probeCustomGateway(probe);
  await api.confirmCustomGateway(confirmation);
  await api.cancelCustomGateway();
  await api.deleteSchoolProfile({ profileId: 'custom-example' });
  await api.switchSchoolProfile({ profileId: 'custom-example' });
  assert.deepEqual(invocations.map(({ channel }) => channel), [
    'list-school-profiles',
    'probe-custom-gateway',
    'confirm-custom-gateway',
    'cancel-custom-gateway',
    'delete-school-profile',
    'switch-school-profile',
  ]);
  assert.equal(invocations[0].argumentCount, 1);
  assert.equal(invocations[1].payload, probe);
  assert.equal(invocations[2].payload, confirmation);
  assert.equal(invocations[3].argumentCount, 1);
  assert.deepEqual(invocations[4].payload, { profileId: 'custom-example' });
  assert.deepEqual(invocations[5].payload, { profileId: 'custom-example' });
  assert.equal(typeof api.getProfileKey, 'undefined');
  assert.equal(typeof api.getGatewayCookie, 'undefined');
});

test('Integration Center preload exposes only list prepare confirm and cancel schemas', async () => {
  const { api, invocations } = loadPreload();
  await api.listIntegrations();
  await api.prepareIntegration({ adapterId: 'clash_mihomo_yaml', action: 'copy' });
  await api.confirmIntegration({ confirmationHandle: 'export-123' });
  await api.cancelIntegration();
  assert.deepEqual(invocations.map(({ channel }) => channel), [
    'list-integrations', 'prepare-integration', 'confirm-integration', 'cancel-integration',
  ]);
  assert.equal(invocations[0].argumentCount, 1);
  assert.deepEqual(invocations[1].payload, { adapterId: 'clash_mihomo_yaml', action: 'copy' });
  assert.deepEqual(invocations[2].payload, { confirmationHandle: 'export-123' });
  assert.equal(invocations[3].argumentCount, 1);
  for (const forbidden of ['getIntegrationPayload', 'getProxyPassword', 'getIntegrationTarget']) {
    assert.equal(typeof api[forbidden], 'undefined');
  }
  for (const retired of ['copyClashNode', 'sshConfig']) {
    assert.equal(typeof api[retired], 'undefined');
  }
  const ownedPreview = { confirmationHandle: 'export-456' };
  await api.cancelIntegration(ownedPreview);
  assert.equal(invocations[4].channel, 'cancel-integration');
  assert.equal(invocations[4].argumentCount, 2);
  assert.equal(invocations[4].payload, ownedPreview);
  await api.cancelIntegration(null);
  assert.equal(invocations[5].payload, null, 'malformed payload must reach validation, not become global cancel');
});

test('routing manager open event is value-free and removable', () => {
  const { api, listeners } = loadPreload();
  let opened = 0;
  const unsubscribe = api.onOpenRoutingRules(() => { opened += 1; });
  const listener = listeners.get('open-routing-rules');
  assert.equal(typeof listener, 'function');
  listener({ ignored: true }, { untrusted: true });
  assert.equal(opened, 1, 'renderer callback receives no main-process payload');
  unsubscribe();
  assert.equal(listeners.has('open-routing-rules'), false);
});

test('interactive auth preload exposes only response, resend, cancel and sanitized events', async () => {
  const { api, invocations, listeners } = loadPreload();
  assert.equal(typeof api.getAuthCookie, 'undefined');
  assert.equal(typeof api.getAuthTransaction, 'undefined');
  await api.respondAuthChallenge('synthetic-response');
  await api.resendAuthChallenge();
  await api.cancelAuthChallenge();
  assert.deepEqual(invocations.slice(-3).map(({ channel }) => channel), [
    'respond-auth-challenge',
    'resend-auth-challenge',
    'cancel-auth-challenge',
  ]);
  assert.equal(invocations.at(-3).payload.response, 'synthetic-response');
  assert.equal(invocations.at(-2).argumentCount, 1);
  assert.equal(invocations.at(-1).argumentCount, 1);

  let received;
  const unsubscribe = api.onAuthChallenge((challenge) => { received = challenge; });
  listeners.get('auth-challenge')({}, { kind: 'otp' });
  assert.deepEqual(received, { kind: 'otp' });
  unsubscribe();
  assert.equal(listeners.has('auth-challenge'), false);
});
