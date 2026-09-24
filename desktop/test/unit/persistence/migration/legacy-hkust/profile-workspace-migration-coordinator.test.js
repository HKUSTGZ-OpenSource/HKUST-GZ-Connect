'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DESTINATION_RECEIPT_IDS,
  LEGACY_SOURCE_IDS,
  REQUIRED_ABSENT_LEGACY_SOURCE_IDS,
  createPreparedMigrationJournal,
} = require('../../../../../lib/persistence/migration/legacy-hkust/profile-workspace-migration-journal');
const {
  ProfileWorkspaceMigrationCoordinator,
} = require('../../../../../lib/persistence/migration/legacy-hkust/profile-workspace-migration-coordinator');
const {
  ProfileWorkspaceMigrationJournalStore,
} = require('../../../../../lib/persistence/migration/legacy-hkust/profile-workspace-migration-store');
const {
  collectLegacyFlatSourceReceipts,
} = require('../../../../../lib/persistence/migration/legacy-hkust/legacy-flat-source-receipts');
const {
  retireLegacyFlatSources,
} = require('../../../../../lib/persistence/migration/legacy-hkust/legacy-flat-source-retirement');
const {
  destinationPathMap,
  materializeDestinationFiles,
  verifyDestinationFiles,
} = require('../../../../../lib/persistence/paths/profile-workspace-destination-files');
const { createLegacyFlatSourcePaths } = require('../../../../../lib/persistence/paths/profile-workspace-layout');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } = require('../../../../../lib/platform/storage/windows-private-file');
const {
  LEGACY_COPY_SOURCE_IDS,
  createHkustMigrationDestinationPlan,
} = require('../../../../../lib/persistence/migration/legacy-hkust/hkust-migration-destination-plan');
const { normalizeSettings } = require('../../../../../lib/persistence/settings/settings-store');

function receipt(seed) {
  return Object.freeze({
    present: true,
    bytes: seed,
    sha256: seed.toString(16).padStart(64, '0'),
  });
}

function receipts(ids, start) {
  return Object.freeze(Object.fromEntries(ids.map((id, index) => [id, receipt(start + index)])));
}

function legacyReceipts(start) {
  return Object.freeze(Object.fromEntries(LEGACY_SOURCE_IDS.map((id, index) => [
    id,
    REQUIRED_ABSENT_LEGACY_SOURCE_IDS.includes(id)
      ? Object.freeze({ present: false, bytes: 0, sha256: null })
      : receipt(start + index),
  ])));
}

class MemoryJournalStore {
  constructor() {
    this.current = null;
    this.prepareCalls = 0;
    this.commitCalls = 0;
    this.clearCalls = 0;
  }

  read() { return this.current; }

  prepare(document) {
    if (this.current) throw new Error('already prepared');
    this.prepareCalls++;
    this.current = document;
    return { prepared: true, durabilityUnconfirmed: false };
  }

  commit(document) {
    if (!this.current || this.current.state !== 'prepared') throw new Error('not prepared');
    this.commitCalls++;
    this.current = document;
    return { committed: true, durabilityUnconfirmed: false };
  }

  clearCommitted() {
    if (!this.current || this.current.state !== 'committed') throw new Error('not committed');
    this.clearCalls++;
    this.current = null;
    return true;
  }
}

function scenario(overrides = {}) {
  const store = overrides.store || new MemoryJournalStore();
  let legacy = overrides.legacy ?? true;
  let destination = overrides.destination ?? false;
  let sourceReceipts = overrides.sourceReceipts || legacyReceipts(1);
  let destinationReceipts = overrides.destinationReceipts || receipts(DESTINATION_RECEIPT_IDS, 101);
  let entropy = 1;
  const calls = { build: 0, verify: 0, retire: 0 };
  const coordinator = new ProfileWorkspaceMigrationCoordinator({
    userData: path.resolve('/tmp/campus-connect-migration'),
    journalStore: store,
    legacyAuthorityExists: () => legacy,
    destinationAuthorityExists: () => destination,
    collectSourceReceipts: () => sourceReceipts,
    prepareJournal: (observed) => createPreparedMigrationJournal({
      profileId: 'hkustgz',
      profileRevision: 1,
      profileCredentialBindingRevision: 1,
      gatewayOrigin: 'https://remote.hkust-gz.edu.cn',
      protocolFamily: 'easyconnect-password-modern-l3-v1',
      sourceReceipts: observed,
      randomBytes: () => Buffer.alloc(16, entropy++),
      now: () => 1_700_000_000_000,
    }),
    buildDestination: (context) => {
      calls.build++;
      if (overrides.buildDestination) return overrides.buildDestination(context, calls);
      destination = true;
      return destinationReceipts;
    },
    verifyDestination: (context) => {
      calls.verify++;
      if (overrides.verifyDestination) return overrides.verifyDestination(context, calls);
      if (!destination) throw new Error('destination unavailable');
      return destinationReceipts;
    },
    retireLegacy: (context) => {
      calls.retire++;
      if (overrides.retireLegacy) return overrides.retireLegacy(context, calls, () => {
        legacy = false;
      });
      legacy = false;
      return true;
    },
    now: () => 1_700_000_000_100,
  });
  return {
    coordinator,
    store,
    calls,
    setLegacy: (value) => { legacy = value; },
    setDestination: (value) => { destination = value; },
    setSourceReceipts: (value) => { sourceReceipts = value; },
    setDestinationReceipts: (value) => { destinationReceipts = value; },
  };
}

test('one synchronous run commits destination authority then retires legacy state', () => {
  const value = scenario();
  assert.deepEqual(value.coordinator.run(), {
    ok: true,
    status: 'migrated',
    authority: 'destination',
  });
  assert.equal(value.store.current, null);
  assert.deepEqual(value.calls, { build: 1, verify: 1, retire: 1 });
  assert.equal(value.store.prepareCalls, 1);
  assert.equal(value.store.commitCalls, 1);
  assert.equal(value.store.clearCalls, 1);
  assert.deepEqual(value.coordinator.run(), {
    ok: true,
    status: 'already_migrated',
    authority: 'destination',
  });
});

test('crash after prepare resumes idempotently from the same keys and source receipts', () => {
  let fail = true;
  const value = scenario({
    buildDestination(context) {
      if (fail) {
        fail = false;
        throw new Error('synthetic crash after prepare');
      }
      value.setDestination(true);
      return receipts(DESTINATION_RECEIPT_IDS, 101);
    },
  });
  assert.throws(() => value.coordinator.run(), /synthetic crash/u);
  assert.equal(value.store.current.state, 'prepared');
  const identity = value.store.current.identity;
  assert.deepEqual(value.coordinator.run(), {
    ok: true, status: 'migrated', authority: 'destination',
  });
  assert.equal(value.store.prepareCalls, 1);
  assert.deepEqual(identity.profileKey, `profile-${'02'.repeat(16)}`);
});

test('prepared migration blocks if any legacy source receipt changed', () => {
  const value = scenario({
    buildDestination() { throw new Error('first crash'); },
  });
  assert.throws(() => value.coordinator.run(), /first crash/u);
  value.setSourceReceipts(legacyReceipts(20));
  assert.deepEqual(value.coordinator.run(), {
    ok: false,
    status: 'blocked',
    authority: 'legacy',
    code: 'LEGACY_SOURCE_CHANGED',
  });
  assert.equal(value.calls.build, 1);
  assert.equal(value.store.current.state, 'prepared');
});

test('crash after journal commit resumes destination verification and idempotent retirement', () => {
  let fail = true;
  const value = scenario({
    retireLegacy(_context, _calls, retire) {
      if (fail) {
        fail = false;
        throw new Error('synthetic crash before retirement');
      }
      retire();
      return true;
    },
  });
  assert.throws(() => value.coordinator.run(), /synthetic crash/u);
  assert.equal(value.store.current.state, 'committed');
  assert.deepEqual(value.coordinator.run(), {
    ok: true, status: 'migrated', authority: 'destination',
  });
  assert.equal(value.calls.build, 1);
  assert.equal(value.calls.retire, 2);
});

test('committed migration blocks when destination receipts no longer match', () => {
  let fail = true;
  const value = scenario({
    retireLegacy() {
      if (fail) {
        fail = false;
        throw new Error('keep committed journal');
      }
      return true;
    },
  });
  assert.throws(() => value.coordinator.run(), /keep committed/u);
  value.setDestinationReceipts(receipts(DESTINATION_RECEIPT_IDS, 300));
  assert.deepEqual(value.coordinator.run(), {
    ok: false,
    status: 'blocked',
    authority: 'destination',
    code: 'DESTINATION_CHANGED',
  });
});

test('missing journal with both authorities is ambiguous and never chooses either', () => {
  const value = scenario({ legacy: true, destination: true });
  assert.deepEqual(value.coordinator.run(), {
    ok: false,
    status: 'blocked',
    authority: 'none',
    code: 'AMBIGUOUS_AUTHORITY',
  });
  assert.deepEqual(value.calls, { build: 0, verify: 0, retire: 0 });
});

test('missing journal and no authority is not a migration and performs no writes', () => {
  const value = scenario({ legacy: false, destination: false });
  assert.deepEqual(value.coordinator.run(), {
    ok: false,
    status: 'not_applicable',
    authority: 'none',
  });
  assert.equal(value.store.prepareCalls, 0);
});

test('reentrant run fails closed and 100 completed rechecks stay idempotent', () => {
  let value;
  value = scenario({
    buildDestination() {
      assert.deepEqual(value.coordinator.run(), {
        ok: false,
        status: 'blocked',
        authority: 'none',
        code: 'MIGRATION_ALREADY_RUNNING',
      });
      value.setDestination(true);
      return receipts(DESTINATION_RECEIPT_IDS, 101);
    },
  });
  assert.equal(value.coordinator.run().ok, true);
  for (let index = 0; index < 100; index++) {
    assert.equal(value.coordinator.run().status, 'already_migrated');
  }
  assert.deepEqual(value.calls, { build: 1, verify: 1, retire: 1 });
});

test('coordinator and owner-only filesystem journal store complete one real contract round', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-migration-coordinator-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const store = new ProfileWorkspaceMigrationJournalStore({
    filePath: path.join(userData, 'global', 'profile-account-workspace-migration.json'),
  });
  let legacy = true;
  let destination = false;
  let entropy = 1;
  const sources = legacyReceipts(1);
  const destinations = receipts(DESTINATION_RECEIPT_IDS, 101);
  const coordinator = new ProfileWorkspaceMigrationCoordinator({
    userData,
    journalStore: store,
    legacyAuthorityExists: () => legacy,
    destinationAuthorityExists: () => destination,
    collectSourceReceipts: () => sources,
    prepareJournal: (sourceReceipts) => createPreparedMigrationJournal({
      profileId: 'hkustgz',
      profileRevision: 1,
      profileCredentialBindingRevision: 1,
      gatewayOrigin: 'https://remote.hkust-gz.edu.cn',
      protocolFamily: 'easyconnect-password-modern-l3-v1',
      sourceReceipts,
      randomBytes: () => Buffer.alloc(16, entropy++),
      now: () => 1_700_000_000_000,
    }),
    buildDestination: ({ layout }) => {
      assert.equal(layout.root, userData);
      destination = true;
      return destinations;
    },
    verifyDestination: () => destinations,
    retireLegacy: () => { legacy = false; return true; },
    now: () => 1_700_000_000_100,
  });
  assert.equal(coordinator.run().status, 'migrated');
  assert.equal(store.read(), null);
  assert.equal(coordinator.run().status, 'already_migrated');
});

test('all P3 storage adapters complete one synthetic all-old to all-new filesystem migration', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-full-migration-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const legacyPaths = createLegacyFlatSourcePaths(userData);
  const legacySettingsBytes = Buffer.from(JSON.stringify(normalizeSettings({
    username: 'synthetic-user',
    port: 6180,
    autoReconnect: true,
    maxAttempts: 3,
    autoConnect: false,
    strictProxyAuth: true,
    routeDomains: ['hkust-gz.edu.cn'],
    customResources: [],
  })), 'utf8');
  fs.writeFileSync(legacyPaths.settings, legacySettingsBytes, { mode: 0o600 });
  fs.writeFileSync(legacyPaths.settingsBackup, legacySettingsBytes, { mode: 0o600 });
  const legacyCredential = Buffer.from('legacy-encrypted-password');
  fs.writeFileSync(legacyPaths.vpnCredential, legacyCredential, { mode: 0o600 });
  const legacyPayloads = {};
  for (const id of LEGACY_COPY_SOURCE_IDS) {
    legacyPayloads[id] = Buffer.from(`legacy-${id}`, 'utf8');
    fs.writeFileSync(legacyPaths[id], legacyPayloads[id], { mode: 0o600 });
  }
  if (process.platform === 'win32') {
    for (const file of Object.values(legacyPaths)) {
      if (!fs.existsSync(file)) continue;
      assert.equal(protectWindowsFileOwnerOnly(file), true);
      assert.equal(verifyWindowsFileOwnerOnly(file), true);
    }
  }
  const sourceReceipts = collectLegacyFlatSourceReceipts({ userData });
  const journalStore = new ProfileWorkspaceMigrationJournalStore({
    filePath: path.join(userData, 'global', 'profile-account-workspace-migration.json'),
  });
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0xa5),
    decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString('utf8'),
  };
  let entropy = 1;
  let destinationLayout = null;
  const coordinator = new ProfileWorkspaceMigrationCoordinator({
    userData,
    journalStore,
    legacyAuthorityExists: () => fs.existsSync(legacyPaths.settings),
    destinationAuthorityExists: (context) => {
      const layout = context?.layout || destinationLayout;
      return Boolean(layout && fs.existsSync(destinationPathMap(layout).globalSettings));
    },
    collectSourceReceipts: () => collectLegacyFlatSourceReceipts({ userData }),
    prepareJournal: (receiptsValue) => createPreparedMigrationJournal({
      profileId: 'hkustgz',
      profileRevision: 1,
      profileCredentialBindingRevision: 1,
      gatewayOrigin: 'https://remote.hkust-gz.edu.cn',
      protocolFamily: 'easyconnect-password-modern-l3-v1',
      sourceReceipts: receiptsValue,
      randomBytes: () => Buffer.alloc(16, entropy++),
      now: () => 1_700_000_000_000,
    }),
    buildDestination: ({ journal, layout }) => {
      destinationLayout = layout;
      const plan = createHkustMigrationDestinationPlan({
        journal,
        settingsBytes: legacySettingsBytes,
        legacyCredential,
        payloads: legacyPayloads,
        credentialOwner: {
          withStrings(callback) { return callback('synthetic-user', 'synthetic-password'); },
        },
        protectedStorage: safeStorage,
        platform: 'darwin',
        now: () => 1_700_000_000_050,
      });
      try {
        return materializeDestinationFiles({ layout, files: plan.files });
      } finally {
        for (const buffer of Object.values(plan.files)) buffer?.fill?.(0);
      }
    },
    verifyDestination: ({ layout }) => verifyDestinationFiles({ layout }),
    retireLegacy: () => retireLegacyFlatSources({
      userData,
      expectedReceipts: sourceReceipts,
    }),
    now: () => 1_700_000_000_100,
  });

  assert.deepEqual(coordinator.run(), {
    ok: true, status: 'migrated', authority: 'destination',
  });
  assert.equal(fs.existsSync(legacyPaths.settings), false);
  assert.equal(fs.existsSync(destinationPathMap(destinationLayout).vpnCredential), true);
  assert.equal(
    fs.existsSync(destinationPathMap(destinationLayout).legacyCredentialRollbackBlob),
    true,
  );
  assert.equal(journalStore.read(), null);
  assert.equal(coordinator.run().status, 'already_migrated');
});
