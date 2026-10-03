'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { MultiSchoolStartupRuntime } = require('../../../../lib/app/startup/multi-school-startup-runtime');

const PROFILE = require('../../../../assets/profiles/hkustgz/school-profile.json');
const desktopRoot = path.resolve(__dirname, '..', '..', '..', '..');

function authority() {
  return {
    profile: { profileId: 'hkustgz', profileRevision: 1 },
    globalSettings: {
      activeProfileKey: `profile-${'11'.repeat(16)}`,
      activeAccountKey: `account-${'22'.repeat(16)}`,
    },
  };
}

test('Profile Workspace startup recovers provisioning before anchoring and enumeration', () => {
  const calls = [];
  class Provisioning {
    recover() { calls.push('recover'); return { ok: true, status: 'provisioned' }; }
  }
  class Directory {
    constructor(options) { calls.push(['directory', options.userData]); }
    anchorReviewedCurrent(value) { calls.push(['anchor', value]); }
    listViews() { calls.push('list'); return [{ profileId: 'hkustgz' }, { profileId: 'custom-a' }]; }
  }
  const runtime = new MultiSchoolStartupRuntime({
    userData: '/tmp/multi-school-startup',
    packageRoot: '/repo/desktop',
    isPackaged: false,
    resourcesPath: '/unused',
    desktopDir: '/repo/desktop',
    ProvisioningRuntimeClass: Provisioning,
    CandidateDirectoryClass: Directory,
  });
  const result = runtime.initialize({
    mode: 'profile-workspace',
    authority: authority(),
    withProfileDocument: (callback) => callback(PROFILE),
  });
  assert.deepEqual(result, {
    ready: true, mode: 'profile-workspace', provisioningStatus: 'provisioned', profileCount: 2,
  });
  assert.deepEqual(calls.map((value) => Array.isArray(value) ? value[0] : value), [
    'recover', 'directory', 'anchor', 'list',
  ]);
  assert.equal(runtime.initialize({}).profileCount, 2, 'startup ownership is idempotent');
});

test('legacy first-run lists the packaged HKUST profile without constructing persistent stores', () => {
  class Forbidden { constructor() { throw new Error('must not construct'); } }
  class Registry {
    load() { return this; }
    listViews(options) {
      assert.equal(options.compatibility, 'reviewed');
      return [{ profileId: 'hkustgz' }];
    }
  }
  const runtime = new MultiSchoolStartupRuntime({
    ProvisioningRuntimeClass: Forbidden,
    CandidateDirectoryClass: Forbidden,
    PackagedRegistryClass: Registry,
  });
  assert.deepEqual(runtime.initialize({ mode: 'legacy-flat' }), {
    ready: true, mode: 'legacy-flat', provisioningStatus: 'not_applicable', profileCount: 1,
  });
  assert.deepEqual(runtime.listViews({ locale: 'zh' }), [{ profileId: 'hkustgz' }]);
});

test('real first-run registry exposes the reviewed HKUST option on every desktop platform', () => {
  const runtime = new MultiSchoolStartupRuntime({
    userData: path.resolve('/tmp/hkustgz-first-run'),
    packageRoot: desktopRoot,
    desktopDir: desktopRoot,
    resourcesPath: '/unused',
    isPackaged: false,
  });
  assert.equal(runtime.initialize({ mode: 'legacy-flat' }).profileCount, 1);
  const views = runtime.listViews({ locale: 'zh' });
  assert.equal(views.length, 1);
  assert.equal(views[0].profileId, 'hkustgz');
  assert.equal(views[0].schoolName, '香港科技大学(广州)');
  assert.equal(views[0].unverified, false);
});

test('startup rejects asynchronous wrong or custom authority before ordinary services', () => {
  const options = {
    ProvisioningRuntimeClass: class { recover() { return { status: 'none' }; } },
    CandidateDirectoryClass: class {},
  };
  assert.throws(() => new MultiSchoolStartupRuntime(options).initialize({
    mode: 'profile-workspace', authority: authority(),
    withProfileDocument: async () => PROFILE,
  }), /synchronous/u);
  assert.throws(() => new MultiSchoolStartupRuntime(options).initialize({
    mode: 'profile-workspace', authority: { ...authority(), profile: { profileId: 'other', profileRevision: 1 } },
    withProfileDocument: (callback) => callback(PROFILE),
  }), /does not match/u);
});

test('production startup orders provisioning recovery before logs tray and network', () => {
  const main = fs.readFileSync(path.join(desktopRoot, 'main.js'), 'utf8');
  assert.match(main, /initializeMultiSchoolStartup: \(\) => initializeMultiSchoolStartup\(persistenceRuntime, activeSchoolProfile\)/u);
  assert.match(main, /app\.whenReady\(\)\.then\(\(\) => desktopStartup\.run\(\)\)/u);
  const owner = fs.readFileSync(require.resolve('../../../../lib/app/startup/multi-school-startup-runtime'), 'utf8');
  const source = owner.slice(owner.indexOf('async #initialize()'));
  const persistence = source.indexOf('e.persistenceRuntime.initialize()');
  const multiSchool = source.indexOf('e.initializeMultiSchoolStartup(');
  const log = source.indexOf('e.initializeLogWriter()');
  const tray = source.indexOf('e.desktopShell.createTray()');
  const network = source.indexOf('e.networkStartupCoordinator.start()');
  assert.ok(persistence >= 0 && multiSchool > persistence && log > multiSchool &&
    tray > log && network > tray);
});
