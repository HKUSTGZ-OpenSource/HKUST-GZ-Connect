'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  OTHER_PROFILE,
  createSchoolProfileSelector,
  profileView,
} = require('../../../renderer/school-profile-selector');

const IDS = [
  'schoolProfileSelect', 'switchSchoolProfile', 'schoolProfileStatus',
  'customSchoolPanel', 'customSchoolName', 'customGatewayOrigin',
  'probeCustomGateway', 'cancelCustomGateway', 'customGatewayConfirmation',
  'customGatewaySummary', 'confirmCustomGateway', 'backCustomGateway',
  'schoolProfileError', 'brandLogo', 'brandFallback', 'brandTitle', 'brandSub',
  'titlebarText', 'connectSchoolName', 'gatewaySchoolName', 'gwName', 'settingsGateway',
  'schoolPicker', 'lgUser', 'lgPass', 'lgBtn', 'profileTrustBadge', 'settingsTrustBadge',
  'deleteSchoolProfile',
];

function element() {
  return {
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    children: [],
    listeners: new Map(),
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    replaceChildren(...children) { this.children = children; },
  };
}

function view(profileId, { active = false, custom = false } = {}) {
  return {
    schemaVersion: 1,
    profileId,
    profileRevision: 1,
    evidenceClass: custom ? 'custom-local' : 'builtin-reviewed',
    schoolName: custom ? 'Example University' : 'HKUST(GZ)',
    shortName: custom ? 'Example' : 'HKUST(GZ)',
    bundledAssetKey: custom ? null : 'hkustgz-logo',
    normalizedGatewayOrigin: custom
      ? 'https://vpn.example.edu'
      : 'https://remote.hkust-gz.edu.cn',
    sanitizedCompatibility: custom ? 'candidate' : 'reviewed',
    unverified: custom,
    active,
    profileKey: 'must-not-cross',
  };
}

function fixture(overrides = {}) {
  const elements = new Map(IDS.map((id) => [id, element()]));
  const calls = [];
  let expiryCallback = null;
  const profiles = overrides.profiles || [
    view('hkustgz', { active: true }),
    view(`custom-${'a'.repeat(32)}`, { custom: true }),
  ];
  const api = {
    listSchoolProfiles: async () => ({
      ok: true,
      profiles,
      customGatewayEnabled: overrides.customGatewayEnabled !== false,
    }),
    probeCustomGateway: async (request) => {
      calls.push(['probe', request]);
      return overrides.probeResult || {
        ok: true,
        confirmation: {
          confirmationHandle: `confirmation-${'b'.repeat(32)}`,
          normalizedOrigin: 'https://vpn.example.edu',
          reportedVersion: 'M7.6.8R2',
          expiresAt: 1_800_000_010_000,
          unverified: true,
        },
      };
    },
    confirmCustomGateway: async (request) => {
      calls.push(['confirm', request]);
      return overrides.confirmResult || { ok: true, profileId: `custom-${'c'.repeat(32)}` };
    },
    cancelCustomGateway: async () => { calls.push(['cancel']); return { ok: true }; },
    switchSchoolProfile: async (request) => {
      calls.push(['switch', request]);
      return overrides.switchResult || { ok: true, relaunching: true };
    },
    deleteSchoolProfile: async (request) => {
      calls.push(['delete', request]);
      return overrides.deleteResult || { ok: true };
    },
  };
  const document = {
    title: '',
    getElementById: (id) => elements.get(id),
    createElement: () => element(),
  };
  const feature = createSchoolProfileSelector({
    api,
    document,
    translate: (key, vars = {}) => `${key}${vars.origin ? `:${vars.origin}:${vars.version}` : ''}`,
    now: () => 1_800_000_000_000,
    setTimeoutFn: (callback) => { expiryCallback = callback; return { unref() {} }; },
    clearTimeoutFn: () => { expiryCallback = null; },
  });
  return {
    api, calls, document, elements, feature,
    expire() { assert.equal(typeof expiryCallback, 'function'); expiryCallback(); },
  };
}

test('Profile view projection drops persistent keys and executable markup', () => {
  const projected = profileView(view('hkustgz', { active: true }));
  assert.equal(projected.profileId, 'hkustgz');
  assert.equal(Object.hasOwn(projected, 'profileKey'), false);
  assert.equal(profileView({ ...view('hkustgz'), schoolName: '<img>' }), null);
  assert.equal(profileView({ ...view('hkustgz'), normalizedGatewayOrigin: 'http://vpn.test' }), null);
});

test('selector lists active and candidate schools and switches only an inactive Profile', async () => {
  const f = fixture();
  f.feature.start();
  await new Promise((resolve) => setImmediate(resolve));
  const select = f.elements.get('schoolProfileSelect');
  assert.equal(select.children.length, 3);
  assert.equal(select.value, 'hkustgz');
  assert.equal(f.elements.get('switchSchoolProfile').disabled, true);
  assert.equal(f.elements.get('lgBtn').disabled, false);
  assert.equal(f.document.title, 'HKUST(GZ) Connect');
  assert.equal(f.elements.get('brandLogo').hidden, false);
  assert.deepEqual(f.elements.get('brandTitle').children.map((child) => child.textContent), [
    'HKUST', '(GZ)', ' Connect',
  ]);

  select.value = `custom-${'a'.repeat(32)}`;
  select.listeners.get('change')();
  assert.equal(f.elements.get('switchSchoolProfile').disabled, false);
  assert.equal(f.elements.get('lgUser').disabled, true);
  assert.equal(f.feature.credentialProfileId(), null);
  await f.feature.switchExisting();
  assert.deepEqual(f.calls.at(-1), ['switch', { profileId: `custom-${'a'.repeat(32)}` }]);
  assert.equal(f.elements.get('schoolProfileStatus').textContent, 'school.switching');
});

test('Other Gateway requires probe then explicit confirmation before creation and switch', async () => {
  const f = fixture();
  await f.feature.refresh();
  const select = f.elements.get('schoolProfileSelect');
  select.value = OTHER_PROFILE;
  select.listeners.get('change')?.();
  f.elements.get('customSchoolName').value = 'Example University';
  f.elements.get('customGatewayOrigin').value = 'https://vpn.example.edu';
  await f.feature.probe();
  assert.deepEqual(f.calls.find(([name]) => name === 'probe'), ['probe', {
    origin: 'https://vpn.example.edu',
    schoolLabel: 'Example University',
  }]);
  assert.equal(f.elements.get('customGatewayConfirmation').hidden, false);
  assert.match(f.elements.get('customGatewaySummary').textContent, /https:\/\/vpn\.example\.edu/u);
  assert.equal(f.calls.some(([name]) => name === 'confirm'), false);

  await f.feature.confirm();
  assert.equal(f.calls.some(([name]) => name === 'confirm'), true);
  assert.deepEqual(f.calls.at(-1), ['switch', { profileId: `custom-${'c'.repeat(32)}` }]);
  assert.equal(f.elements.get('schoolProfileStatus').textContent, 'school.switching');
});

test('expired confirmation is erased locally and cancelled in Main', async () => {
  const f = fixture();
  await f.feature.refresh();
  f.elements.get('schoolProfileSelect').value = OTHER_PROFILE;
  f.elements.get('customGatewayOrigin').value = 'https://vpn.example.edu';
  await f.feature.probe();
  f.expire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.elements.get('customGatewayConfirmation').hidden, true);
  assert.equal(f.calls.some(([name]) => name === 'cancel'), true);
  assert.equal(f.elements.get('schoolProfileError').textContent,
    'school.error.PROFILE_CONFIRMATION_STALE');
});

test('custom active Profile keeps product identity and continuously shows unreviewed status', async () => {
  const custom = view(`custom-${'d'.repeat(32)}`, { active: true, custom: true });
  const f = fixture({ profiles: [custom] });
  await f.feature.refresh();
  assert.equal(f.elements.get('brandLogo').hidden, true);
  assert.equal(f.elements.get('brandFallback').hidden, false);
  assert.equal(f.document.title, 'HKUST(GZ) Connect');
  assert.deepEqual(f.elements.get('brandTitle').children.map((child) => child.textContent), [
    'HKUST', '(GZ)', ' Connect',
  ]);
  assert.match(f.elements.get('brandSub').textContent, /school\.unverified/u);
  assert.equal(f.elements.get('profileTrustBadge').hidden, false);
  assert.equal(f.elements.get('settingsTrustBadge').hidden, false);
  assert.equal(f.elements.get('settingsGateway').textContent, 'https://vpn.example.edu');
  assert.equal(f.elements.get('connectSchoolName').textContent, 'Example University');
});

test('first-beta mode hides Other and the selector when only HKUST is available', async () => {
  const f = fixture({
    profiles: [view('hkustgz', { active: true })],
    customGatewayEnabled: false,
  });
  await f.feature.refresh();
  assert.equal(f.elements.get('schoolProfileSelect').children.length, 1);
  assert.equal(f.elements.get('schoolPicker').hidden, true);
  assert.equal(f.elements.get('customSchoolPanel').hidden, true);
  assert.equal(f.feature.credentialProfileId(), 'hkustgz');
});

test('inactive custom Profile requires two clicks before local deletion', async () => {
  const f = fixture();
  f.feature.start();
  await new Promise((resolve) => setImmediate(resolve));
  f.elements.get('schoolProfileSelect').value = `custom-${'a'.repeat(32)}`;
  f.elements.get('schoolProfileSelect').listeners.get('change')();
  assert.equal(f.elements.get('deleteSchoolProfile').hidden, false);
  await f.feature.deleteExisting();
  assert.equal(f.calls.some(([name]) => name === 'delete'), false);
  await f.feature.deleteExisting();
  assert.deepEqual(f.calls.find(([name]) => name === 'delete'), ['delete', {
    profileId: `custom-${'a'.repeat(32)}`,
  }]);
});
