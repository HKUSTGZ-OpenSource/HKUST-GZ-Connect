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
  'customGatewayLeafSha256',
  'gatewayTrustNotice', 'gatewayCertificateDetails', 'gatewayObservedFingerprint',
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
  let expirySchedules = 0;
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
    setTimeoutFn: (callback) => { expirySchedules += 1; expiryCallback = callback; return { unref() {} }; },
    clearTimeoutFn: () => { expiryCallback = null; },
  });
  return {
    api, calls, document, elements, feature,
    expirySchedules: () => expirySchedules,
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

test('locale redraw preserves Other school draft and its credential gate', async () => {
  const f = fixture();
  f.feature.start();
  await new Promise((resolve) => setImmediate(resolve));
  const select = f.elements.get('schoolProfileSelect');
  select.value = OTHER_PROFILE;
  select.listeners.get('change')();
  const draft = {
    customSchoolName: 'Example University',
    customGatewayOrigin: 'https://vpn.example.edu',
    customGatewayLeafSha256: 'ab'.repeat(32),
  };
  for (const [id, value] of Object.entries(draft)) f.elements.get(id).value = value;
  const callsBefore = f.calls.length;
  for (const locale of ['zh-CN', 'zh-CN', 'en']) {
    f.feature.setTranslator((key) => `${locale}:${key}`);
    f.feature.setActiveProfile(view('hkustgz', { active: true }));
    assert.equal(select.value, OTHER_PROFILE);
    assert.equal(select.children.at(-1).textContent, `${locale}:school.other`);
    assert.equal(f.elements.get('customSchoolPanel').hidden, false);
    for (const [id, value] of Object.entries(draft)) assert.equal(f.elements.get(id).value, value);
    assert.equal(f.feature.credentialProfileId(), null);
    for (const id of ['lgUser', 'lgPass', 'lgBtn']) assert.equal(f.elements.get(id).disabled, true);
    assert.equal(f.calls.length, callsBefore);
  }
});

test('locale redraw preserves confirmation, back and original expiry', async () => {
  const f = fixture();
  f.feature.start();
  await new Promise((resolve) => setImmediate(resolve));
  const select = f.elements.get('schoolProfileSelect');
  select.value = OTHER_PROFILE;
  select.listeners.get('change')();
  f.elements.get('customGatewayOrigin').value = 'https://vpn.example.edu';
  for (const finish of ['back', 'expire']) {
    await f.feature.probe();
    f.feature.setTranslator((key, vars = {}) => `${key}:${vars.origin || ''}`);
    f.feature.setActiveProfile(view('hkustgz', { active: true }));
    assert.equal(select.value, OTHER_PROFILE);
    assert.equal(f.elements.get('customSchoolPanel').hidden, true);
    assert.equal(f.elements.get('customGatewayConfirmation').hidden, false);
    assert.match(f.elements.get('customGatewaySummary').textContent, /https:\/\/vpn\.example\.edu/u);
    assert.equal(f.feature.credentialProfileId(), null);
    assert.equal(f.calls.some(([name]) => name === 'confirm' || name === 'switch'), false);
    if (finish === 'back') await f.elements.get('backCustomGateway').listeners.get('click')();
    else f.expire();
    assert.equal(select.value, OTHER_PROFILE);
    assert.equal(f.elements.get('customSchoolPanel').hidden, false);
    assert.equal(f.elements.get('customGatewayConfirmation').hidden, true);
    assert.equal(f.elements.get('customGatewayOrigin').value, 'https://vpn.example.edu');
    assert.equal(f.elements.get('lgBtn').disabled, true);
  }
  assert.match(f.elements.get('schoolProfileError').textContent, /PROFILE_CONFIRMATION_STALE/u);
});

test('a different active school still replaces the Other school selection', async () => {
  const f = fixture();
  await f.feature.refresh();
  f.elements.get('schoolProfileSelect').value = OTHER_PROFILE;
  const nextId = `custom-${'a'.repeat(32)}`;
  assert.equal(f.feature.setActiveProfile(view(nextId, { active: true, custom: true })), true);
  assert.equal(f.elements.get('schoolProfileSelect').value, nextId);
  assert.equal(f.elements.get('customSchoolPanel').hidden, true);
  assert.equal(f.feature.credentialProfileId(), nextId);
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

  f.feature.setTranslator((key) => key);
  assert.equal(select.value, OTHER_PROFILE);
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

test('Gateway trust is explicit input and visible in confirmation without creating a Profile', async () => {
  const leafSha256 = 'ab'.repeat(32);
  const f = fixture({ probeResult: { ok: true, confirmation: {
    confirmationHandle: `confirmation-${'b'.repeat(32)}`, normalizedOrigin: 'https://8.8.8.8:4455',
    reportedVersion: 'M7.6.8R2', expiresAt: 1_800_000_010_000, unverified: true, leafSha256,
  } } });
  await f.feature.refresh();
  f.elements.get('schoolProfileSelect').value = OTHER_PROFILE;
  f.elements.get('customGatewayOrigin').value = 'http://entry.example.edu/start.php';
  f.elements.get('customGatewayLeafSha256').value = 'AB:'.repeat(31) + 'AB';
  await f.feature.probe();
  assert.equal(f.calls.find(([name]) => name === 'probe')[1].leafSha256, leafSha256);
  assert.equal(f.elements.get('gatewayObservedFingerprint').textContent, leafSha256);
  assert.equal(f.elements.get('gatewayCertificateDetails').hidden, false);
  assert.equal(f.calls.some(([name]) => name === 'confirm'), false);
});

test('automatically observed fingerprint needs one clearly labelled first-trust action', async () => {
  const f = fixture({ probeResult: { ok: true, confirmation: {
    confirmationHandle: `confirmation-${'b'.repeat(32)}`, normalizedOrigin: 'https://vpn.example.edu',
    reportedVersion: 'M7.6.8R2', expiresAt: 1_800_000_010_000, unverified: true,
    requiresTrust: true, leafSha256: 'ab'.repeat(32),
  } } });
  await f.feature.refresh();
  f.elements.get('customGatewayOrigin').value = 'https://vpn.example.edu';
  await f.feature.probe();
  assert.equal('leafSha256' in f.calls.find(([name]) => name === 'probe')[1], false);
  assert.equal(f.elements.get('confirmCustomGateway').textContent, 'school.trustConfirm');
  assert.equal(f.elements.get('gatewayTrustNotice').textContent, 'school.firstTrustWarning');
  assert.equal(f.calls.some(([name]) => name === 'confirm'), false);
  await f.feature.confirm();
  assert.equal(f.calls.find(([name]) => name === 'confirm')[1].trustCertificate, true);
});

test('malformed certificate fingerprint fails locally before a native probe', async () => {
  const f = fixture();
  await f.feature.refresh();
  f.elements.get('customGatewayOrigin').value = 'https://vpn.example.edu';
  f.elements.get('customGatewayLeafSha256').value = 'bad fingerprint';
  await f.feature.probe();
  assert.equal(f.calls.some(([name]) => name === 'probe'), false);
  assert.equal(f.elements.get('schoolProfileError').textContent, 'school.error.fingerprintInvalid');
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
  await f.feature.refresh(OTHER_PROFILE);
  f.feature.setTranslator((key) => key);
  assert.equal(f.elements.get('schoolProfileSelect').value, 'hkustgz');
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


function localizedProfiles(locale, customActive = false) {
  return [
    { ...view('hkustgz', { active: !customActive }),
      schoolName: locale === 'zh' ? '香港科技大学(广州)' : 'HKUST Guangzhou University',
      shortName: locale === 'zh' ? '港科广' : 'HKUST(GZ)' },
    view(`custom-${'a'.repeat(32)}`, { active: customActive, custom: true }),
  ];
}

function listResult(locale, customActive = false) {
  return { ok: true, customGatewayEnabled: true, profiles: localizedProfiles(locale, customActive) };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('active Profile presentation replaces cached names without discarding a pending selection', async () => {
  const f = fixture({ profiles: localizedProfiles('en') });
  await f.feature.refresh();
  const select = f.elements.get('schoolProfileSelect');
  for (const selected of ['hkustgz', `custom-${'a'.repeat(32)}`, OTHER_PROFILE]) {
    select.value = selected;
    for (const locale of ['zh', 'en']) {
      const [current] = localizedProfiles(locale);
      assert.equal(f.feature.setActiveProfile(current), true);
      assert.equal(select.value, selected);
      assert.equal(f.elements.get('connectSchoolName').textContent, current.schoolName);
      assert.ok(select.children[0].textContent.startsWith(current.schoolName));
      assert.ok(f.elements.get('brandSub').textContent.startsWith(current.schoolName));
      assert.equal(f.feature.credentialProfileId(), selected === 'hkustgz' ? 'hkustgz' : null);
    }
  }
});

test('locale list refresh updates inactive built-in names and preserves custom labels', async () => {
  const f = fixture({ profiles: localizedProfiles('zh', true) });
  await f.feature.refresh();
  let calls = 0, nextLocale = 'en';
  f.api.listSchoolProfiles = async () => { calls += 1; return listResult(nextLocale, true); };
  for (const locale of ['en', 'zh']) {
    nextLocale = locale;
    await f.feature.setTranslator(key => `${locale}:${key}`, locale);
    const options = f.elements.get('schoolProfileSelect').children;
    assert.equal(options[0].textContent, localizedProfiles(locale)[0].schoolName);
    assert.ok(options[1].textContent.startsWith('Example University'));
    assert.equal(f.elements.get('connectSchoolName').textContent, 'Example University');
    assert.equal(f.feature.credentialProfileId(), `custom-${'a'.repeat(32)}`);
    const before = calls;
    await f.feature.setTranslator(key => `${locale}:${key}`, locale);
    assert.equal(calls, before, 'same effective locale must not re-list schools');
  }
  assert.equal(calls, 2);
  assert.equal(f.calls.length, 0, 'language changes cannot probe, confirm, switch or delete');
});

test('locale completion preserves current Other draft, confirmation and original expiry', async () => {
  const f = fixture();
  f.feature.start();
  await new Promise(resolve => setImmediate(resolve));
  const select = f.elements.get('schoolProfileSelect');
  const pending = deferred();
  let lists = 0;
  f.api.listSchoolProfiles = () => { lists += 1; return pending.promise; };
  const refresh = f.feature.setTranslator(key => `en:${key}`, 'en');
  assert.equal(lists, 1);
  select.value = OTHER_PROFILE;
  select.listeners.get('change')();
  f.elements.get('customSchoolName').value = 'Draft University';
  f.elements.get('customGatewayOrigin').value = 'https://vpn.example.edu';
  await f.feature.probe();
  const calls = f.calls.length;
  const schedules = f.expirySchedules();
  pending.resolve(listResult('en'));
  await refresh;
  assert.equal(select.value, OTHER_PROFILE);
  assert.equal(f.elements.get('customSchoolName').value, 'Draft University');
  assert.equal(f.elements.get('customGatewayOrigin').value, 'https://vpn.example.edu');
  assert.equal(f.elements.get('customGatewayConfirmation').hidden, false);
  assert.equal(f.elements.get('customSchoolPanel').hidden, true);
  assert.equal(f.feature.credentialProfileId(), null);
  assert.equal(f.calls.length, calls);
  assert.equal(f.expirySchedules(), schedules, 'locale refresh must not restart confirmation expiry');
  f.expire();
  assert.equal(f.elements.get('customGatewayConfirmation').hidden, true);
  assert.equal(f.elements.get('customSchoolPanel').hidden, false);
  assert.match(f.elements.get('schoolProfileError').textContent, /PROFILE_CONFIRMATION_STALE/);
});

test('locale completion retains an in-progress probe and its status', async () => {
  const f = fixture();
  await f.feature.refresh();
  f.elements.get('schoolProfileSelect').value = OTHER_PROFILE;
  f.elements.get('customGatewayOrigin').value = 'https://vpn.example.edu';
  const probe = deferred();
  f.api.probeCustomGateway = () => probe.promise;
  const probing = f.feature.probe();
  const before = f.elements.get('schoolProfileStatus').textContent;
  let lists = 0;
  f.api.listSchoolProfiles = async () => { lists += 1; return listResult('en'); };
  await f.feature.setTranslator(key => `en:${key}`, 'en');
  assert.equal(lists, 1);
  assert.equal(f.elements.get('schoolProfileStatus').textContent, before);
  assert.equal(f.elements.get('schoolProfileSelect').disabled, true);
  assert.equal(f.elements.get('lgBtn').disabled, true);
  assert.equal(f.feature.credentialProfileId(), null);
  probe.resolve({ ok: false, code: 'GATEWAY_PROBE_FAILED' });
  await probing;
  assert.equal(f.elements.get('schoolProfileSelect').disabled, false);
});

test('older locale list successes and failures cannot replace the newest presentation', async () => {
  for (const rejectOld of [false, true]) {
    const f = fixture({ profiles: localizedProfiles('zh') });
    await f.feature.refresh();
    const first = deferred(), last = deferred();
    const queue = [first, last];
    f.api.listSchoolProfiles = () => queue.shift().promise;
    const old = f.feature.setTranslator(key => `en:${key}`, 'en');
    const current = f.feature.setTranslator(key => `zh:${key}`, 'zh');
    assert.equal(queue.length, 0, 'both actual language changes must request a list');
    last.resolve(listResult('zh'));
    await current;
    if (rejectOld) first.reject(new Error('synthetic stale list failure'));
    else first.resolve(listResult('en'));
    await old;
    assert.equal(f.elements.get('connectSchoolName').textContent, localizedProfiles('zh')[0].schoolName);
    assert.equal(f.elements.get('schoolProfileError').textContent, '');
    assert.equal(f.feature.credentialProfileId(), 'hkustgz');
  }
});

test('actual active Profile change retires an older pending candidate list', async () => {
  const f = fixture({ profiles: localizedProfiles('zh') });
  await f.feature.refresh();
  const pending = deferred();
  f.api.listSchoolProfiles = () => pending.promise;
  const loading = f.feature.refresh();
  const custom = localizedProfiles('en', true)[1];
  f.feature.setActiveProfile(custom);
  pending.resolve(listResult('zh'));
  await loading;
  assert.equal(f.elements.get('connectSchoolName').textContent, custom.schoolName);
  assert.equal(f.elements.get('schoolProfileSelect').value, custom.profileId);
  assert.equal(f.feature.credentialProfileId(), custom.profileId);
});

test('first active state does not cancel the pending initial candidate list', async () => {
  const f = fixture();
  const pending = deferred();
  f.api.listSchoolProfiles = () => pending.promise;
  f.feature.start();
  f.feature.setActiveProfile(localizedProfiles('zh')[0]);
  pending.resolve(listResult('zh'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.elements.get('schoolProfileSelect').children.length, 3);
  assert.equal(f.elements.get('connectSchoolName').textContent, localizedProfiles('zh')[0].schoolName);
  assert.equal(f.feature.credentialProfileId(), 'hkustgz');
});

test('current locale list rejection is handled and closes credential admission', async () => {
  const f = fixture();
  await f.feature.refresh();
  f.api.listSchoolProfiles = async () => { throw new Error('synthetic list failure'); };
  await f.feature.setTranslator(key => `en:${key}`, 'en');
  assert.match(f.elements.get('schoolProfileError').textContent, /PROFILE_LIST_FAILED/);
  assert.equal(f.feature.credentialProfileId(), null);
  for (const id of ['lgUser', 'lgPass', 'lgBtn']) assert.equal(f.elements.get(id).disabled, true);
});

test('successful locale refresh retains an existing operation error', async () => {
  const f = fixture({ probeResult: { ok: false, code: 'GATEWAY_PROBE_FAILED' } });
  await f.feature.refresh();
  f.elements.get('schoolProfileSelect').value = OTHER_PROFILE;
  f.elements.get('customGatewayOrigin').value = 'https://vpn.example.edu';
  await f.feature.probe();
  const error = f.elements.get('schoolProfileError').textContent;
  assert.match(error, /GATEWAY_PROBE_FAILED/);
  let lists = 0;
  f.api.listSchoolProfiles = async () => { lists += 1; return listResult('en'); };
  await f.feature.setTranslator(key => `en:${key}`, 'en');
  assert.equal(lists, 1);
  assert.equal(f.elements.get('schoolProfileError').textContent, error);
  assert.equal(f.elements.get('schoolProfileSelect').value, OTHER_PROFILE);
  assert.equal(f.elements.get('customSchoolPanel').hidden, false);
  assert.equal(f.feature.credentialProfileId(), null);
});
