'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  confirmationRequest,
  probeRequest,
  registerSchoolProfileOnboardingIpc,
} = require('../../../lib/ipc/school-profile-onboarding-ipc');

function fixture() {
  const handlers = new Map();
  const calls = [];
  const onboarding = {
    list: (value) => { calls.push(['list', value]); return []; },
    probe: (value) => { calls.push(['probe', value]); return { ok: true }; },
    confirm: (value) => { calls.push(['confirm', value]); return { ok: true }; },
    cancel: () => { calls.push(['cancel']); return true; },
  };
  registerSchoolProfileOnboardingIpc({
    register: (channel, handler) => handlers.set(channel, handler),
    onboarding,
    getLocale: () => 'zh',
    isCustomGatewayEnabled: () => true,
    deleteProfile: (value) => { calls.push(['delete', value]); return { ok: true }; },
  });
  return { calls, handlers };
}

test('first-use trust consent is an exact boolean and cannot carry a replacement fingerprint', () => {
  assert.deepEqual(confirmationRequest({ confirmationHandle: 'confirmation-123', trustCertificate: true }),
    { confirmationHandle: 'confirmation-123', trustCertificate: true });
  for (const trustCertificate of ['true', 1, {}, []]) {
    assert.throws(() => confirmationRequest({ confirmationHandle: 'confirmation-123', trustCertificate }));
  }
  assert.throws(() => confirmationRequest({ confirmationHandle: 'confirmation-123',
    trustCertificate: true, leafSha256: 'ab'.repeat(32) }));
});

test('onboarding IPC exposes five exact channels with bounded schemas', async () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()], [
    'list-school-profiles',
    'probe-custom-gateway',
    'confirm-custom-gateway',
    'cancel-custom-gateway',
    'delete-school-profile',
  ]);
  assert.deepEqual(await f.handlers.get('list-school-profiles')({}), {
    ok: true,
    profiles: [],
    customGatewayEnabled: true,
  });
  await f.handlers.get('probe-custom-gateway')({}, {
    origin: ' https://vpn.example.edu ',
    schoolLabel: ' Example University ',
  });
  await f.handlers.get('confirm-custom-gateway')({}, {
    confirmationHandle: ' confirmation-123 ',
  });
  assert.deepEqual(await f.handlers.get('cancel-custom-gateway')({}), {
    ok: true,
    cancelled: true,
  });
  assert.deepEqual(await f.handlers.get('delete-school-profile')({}, {
    profileId: 'custom-profile-1',
  }), { ok: true });
  assert.deepEqual(f.calls, [
    ['list', { locale: 'zh' }],
    ['probe', { origin: 'https://vpn.example.edu', schoolLabel: 'Example University' }],
    ['confirm', { confirmationHandle: 'confirmation-123' }],
    ['cancel'],
    ['delete', { profileId: 'custom-profile-1' }],
  ]);
});

test('onboarding IPC rejects unknown credential-like fields before Main', () => {
  assert.throws(() => probeRequest({
    origin: 'https://vpn.example.edu',
    password: 'forbidden',
  }), /未知字段/u);
  assert.throws(() => probeRequest({ origin: 'x'.repeat(2049) }), /Gateway/u);
  assert.throws(() => confirmationRequest({
    confirmationHandle: 'confirmation-1',
    token: 'forbidden',
  }), /未知字段/u);
});

test('profile list failures collapse without exposing Main error text', () => {
  const handlers = new Map();
  registerSchoolProfileOnboardingIpc({
    register: (channel, handler) => handlers.set(channel, handler),
    onboarding: {
      list: () => { throw new Error('/private/user/path'); },
      probe: () => {},
      confirm: () => {},
      cancel: () => false,
    },
    getLocale: () => 'en',
    isCustomGatewayEnabled: () => false,
    deleteProfile: () => ({ ok: false }),
  });
  assert.deepEqual(handlers.get('list-school-profiles')({}), {
    ok: false,
    code: 'PROFILE_LIST_FAILED',
    profiles: [],
    customGatewayEnabled: false,
  });
});

test('disabled packaged onboarding rejects probe and confirmation before the coordinator', async () => {
  const f = fixture();
  const disabled = new Map();
  registerSchoolProfileOnboardingIpc({
    register: (channel, handler) => disabled.set(channel, handler),
    onboarding: {
      list: () => [],
      probe: () => { throw new Error('must not run'); },
      confirm: () => { throw new Error('must not run'); },
      cancel: () => false,
    },
    getLocale: () => 'zh',
    isCustomGatewayEnabled: () => false,
    deleteProfile: () => ({ ok: false }),
  });
  assert.deepEqual(disabled.get('probe-custom-gateway')({}, {
    origin: 'https://vpn.example.edu', schoolLabel: '',
  }), { ok: false, code: 'PROFILE_ONBOARDING_DISABLED' });
  assert.deepEqual(disabled.get('confirm-custom-gateway')({}, {
    confirmationHandle: 'confirmation-123',
  }), { ok: false, code: 'PROFILE_ONBOARDING_DISABLED' });
  assert.ok(f.handlers.has('probe-custom-gateway'));
});
