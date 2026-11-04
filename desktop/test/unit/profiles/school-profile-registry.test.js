'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SchoolProfileRegistry,
} = require('../../../lib/profiles/registry/school-profile-registry');

const desktopRoot = path.resolve(__dirname, '..', '..', '..');
const sourceProfile = JSON.parse(fs.readFileSync(
  path.join(desktopRoot, 'assets', 'profiles', 'hkustgz', 'school-profile.json'),
  'utf8',
));
const sourceEngineConfig = fs.readFileSync(
  path.join(desktopRoot, 'assets', 'profiles', 'hkustgz', 'engine-config.json'),
);
const sourceLogo = fs.readFileSync(path.join(desktopRoot, 'assets', 'logo.svg'));
const sourceResources = fs.readFileSync(path.join(
  desktopRoot,
  'assets',
  'profiles',
  'hkustgz',
  'builtin-resources.json',
));
const sourceServiceDesk = fs.readFileSync(path.join(
  desktopRoot,
  'assets',
  'profiles',
  'hkustgz',
  'builtin-service-desk.json',
));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('reviewed HKUST profile and both engine configs permit private gateway peers consistently', () => {
  assert.equal(sourceProfile.policy.reviewedPrivateGatewayAllowed, true);
  assert.equal(JSON.parse(sourceEngineConfig).gateway_connector.reviewed_private_gateway_allowed, true);
  const cli = fs.readFileSync(path.join(desktopRoot, '..', 'independent', 'config', 'hkustgz.json'));
  assert.deepEqual(cli, sourceEngineConfig);
  assert.equal(sourceProfile.profileRevision, 1, 'existing persisted identity remains valid');
  new SchoolProfileRegistry({ packageRoot: desktopRoot }).load();
});

function digest(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function writeFile(root, relative, data) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

function fixture(t, {
  mutateProfile = null,
  mutateManifest = null,
  mutateResources = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-profile-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = clone(sourceProfile);
  mutateProfile?.(profile);
  const profileData = Buffer.from(`${JSON.stringify(profile, null, 2)}\n`);
  const resources = JSON.parse(sourceResources.toString('utf8'));
  mutateResources?.(resources);
  const resourceData = mutateResources
    ? Buffer.from(`${JSON.stringify(resources, null, 2)}\n`)
    : sourceResources;
  writeFile(root, 'assets/profiles/hkustgz/school-profile.json', profileData);
  writeFile(root, 'assets/profiles/hkustgz/engine-config.json', sourceEngineConfig);
  writeFile(root, 'assets/logo.svg', sourceLogo);
  writeFile(root, 'assets/profiles/hkustgz/builtin-resources.json', resourceData);
  writeFile(root, 'assets/profiles/hkustgz/builtin-service-desk.json', sourceServiceDesk);
  const manifest = {
    schemaVersion: 1,
    profiles: [{
      profileId: 'hkustgz',
      default: true,
      document: {
        path: 'assets/profiles/hkustgz/school-profile.json',
        sha256: digest(profileData),
      },
      assets: [
        {
          key: 'hkustgz-engine-config',
          kind: 'engine-config',
          path: 'assets/profiles/hkustgz/engine-config.json',
          sha256: digest(sourceEngineConfig),
        },
        {
          key: 'hkustgz-logo',
          kind: 'branding',
          path: 'assets/logo.svg',
          sha256: digest(sourceLogo),
        },
        {
          key: 'hkustgz-builtin-resources',
          kind: 'builtin-resources',
          path: 'assets/profiles/hkustgz/builtin-resources.json',
          sha256: digest(resourceData),
        },
        {
          key: 'hkustgz-service-desk',
          kind: 'service-desk',
          path: 'assets/profiles/hkustgz/builtin-service-desk.json',
          sha256: digest(sourceServiceDesk),
        },
      ],
    }],
  };
  mutateManifest?.(manifest);
  writeFile(root, 'assets/profiles/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifest, profile };
}

function appendReviewedProfile(target, { makeDefault = false } = {}) {
  const profile = clone(sourceProfile);
  profile.profileId = 'example-university';
  profile.branding.localizedSchoolName = { zh: '示例大学', en: 'Example University' };
  profile.branding.shortName = 'Example';
  profile.branding.bundledAssetKey = 'example-logo';
  profile.gateway.origin = 'https://vpn.example.edu';
  profile.gateway.engineConfigRef = 'example-university-engine-config';
  profile.browser.homeUrl = 'https://www.example.edu/';
  profile.browser.campusDomains = ['example.edu'];
  profile.browser.directPartnerDomains = [];
  profile.browser.builtinResourcesRef = 'example-university-builtin-resources';
  delete profile.browser.serviceDeskRef;
  profile.browser.officialPortalResourceId = 'example-service-1';
  profile.browser.healthTargets = [
    { host: 'www.example.edu', port: 443 },
    { host: 'library.example.edu', port: 443 },
  ];
  profile.policy.reviewedDnsFallback = [];
  const profileData = Buffer.from(`${JSON.stringify(profile, null, 2)}\n`);
  const config = JSON.parse(sourceEngineConfig.toString('utf8'));
  config.base_url = 'https://vpn.example.edu';
  config.dns_fallback = [];
  const configData = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  const resources = JSON.parse(sourceResources.toString('utf8'));
  resources.resources = resources.resources.slice(0, 2).map((resource, index) => ({
    ...resource,
    id: `example-service-${index + 1}`,
    localizedName: { zh: `示例服务 ${index + 1}`, en: `Example Service ${index + 1}` },
    localizedDescription: { zh: '示例审核服务', en: 'Example reviewed service' },
    name: `示例服务 ${index + 1}`,
    description: '示例审核服务',
    url: `https://service-${index + 1}.example.edu/`,
    route: 'campus',
  }));
  const resourceData = Buffer.from(`${JSON.stringify(resources, null, 2)}\n`);
  writeFile(target.root, 'assets/profiles/example-university/school-profile.json', profileData);
  writeFile(target.root, 'assets/profiles/example-university/engine-config.json', configData);
  writeFile(target.root, 'assets/profiles/example-university/builtin-resources.json', resourceData);
  if (makeDefault) target.manifest.profiles[0].default = false;
  target.manifest.profiles.push({
    profileId: profile.profileId,
    default: makeDefault,
    document: {
      path: 'assets/profiles/example-university/school-profile.json',
      sha256: digest(profileData),
    },
    assets: [
      {
        key: 'example-university-engine-config',
        kind: 'engine-config',
        path: 'assets/profiles/example-university/engine-config.json',
        sha256: digest(configData),
      },
      {
        key: 'example-logo',
        kind: 'branding',
        path: 'assets/logo.svg',
        sha256: digest(sourceLogo),
      },
      {
        key: 'example-university-builtin-resources',
        kind: 'builtin-resources',
        path: 'assets/profiles/example-university/builtin-resources.json',
        sha256: digest(resourceData),
      },
    ],
  });
  writeFile(target.root, 'assets/profiles/manifest.json',
    `${JSON.stringify(target.manifest, null, 2)}\n`);
}

test('loads the reviewed HKUST packaged registry and bounded views', () => {
  const registry = new SchoolProfileRegistry({ packageRoot: desktopRoot }).load();
  const profile = registry.getDefaultProfile();
  assert.equal(profile.profileId, 'hkustgz');
  assert.equal(profile.evidenceClass, 'builtin-reviewed');
  assert.equal(profile.gateway.origin.origin, 'https://remote.hkust-gz.edu.cn');
  assert.equal(profile.gateway.protocolFamily, 'easyconnect-password-modern-l3-v1');
  assert.equal(profile.gateway.engineConfigRef, 'hkustgz-engine-config');
  assert.deepEqual(profile.browser.campusDomains, ['hkust-gz.edu.cn', 'hkust.edu.hk']);
  assert.deepEqual(profile.browser.healthTargets, [
    { host: 'www.hkust-gz.edu.cn', port: 443 },
    { host: 'library.hkust-gz.edu.cn', port: 443 },
  ]);
  assert.equal(profile.browser.builtinResourcesRef, 'hkustgz-builtin-resources');
  assert.equal(profile.browser.homeUrl, 'https://myportal.hkust-gz.edu.cn/');
  assert.equal(profile.browser.officialPortalResourceId, 'official-portal');
  assert.equal(registry.getBuiltinResources('hkustgz').length, 45);
  const serviceDesk = registry.getServiceDesk('hkustgz');
  assert.equal(serviceDesk.applications.length >= 12, true);
  assert.equal(serviceDesk.serviceItems.length >= 12, true);
  assert.equal(serviceDesk.applications.every(
    ({ url }) => registry.getBuiltinResources('hkustgz').some((resource) => resource.url === url),
  ), true, 'service desk must only reference reviewed official URLs');
  assert.equal(registry.getBuiltinResources('hkustgz').find(
    ({ id }) => id === profile.browser.officialPortalResourceId,
  )?.url, 'https://myportal.hkust-gz.edu.cn/');
  assert.deepEqual(registry.listViews({ locale: 'en', compatibility: 'reviewed' }), [
    {
      schemaVersion: 1,
      profileId: 'hkustgz',
      profileRevision: 1,
      evidenceClass: 'builtin-reviewed',
      schoolName: 'The Hong Kong University of Science and Technology (Guangzhou)',
      shortName: 'HKUST(GZ)',
      bundledAssetKey: 'hkustgz-logo',
      normalizedGatewayOrigin: 'https://remote.hkust-gz.edu.cn',
      sanitizedCompatibility: 'reviewed',
      unverified: false,
      officialPortalResourceId: 'official-portal',
    },
  ]);
});

test('reviewed Profile official portal must reference one packaged resource', (t) => {
  const target = fixture(t, {
    mutateProfile: (profile) => { profile.browser.officialPortalResourceId = 'missing-portal'; },
  });
  assert.throws(() => new SchoolProfileRegistry({ packageRoot: target.root }).load(),
    /official portal resource/u);
});

test('manifest assets are exact, hashed, read-only copies and match current sources', () => {
  const registry = new SchoolProfileRegistry({ packageRoot: desktopRoot }).load();
  assert.deepEqual(registry.resolveAsset('hkustgz', 'hkustgz-engine-config', 'engine-config'), {
    key: 'hkustgz-engine-config',
    kind: 'engine-config',
    path: 'assets/profiles/hkustgz/engine-config.json',
    sha256: 'ce049050e839305efbc9549d405e62c34ce98ceb425e3b027f21f2a55e8683d3',
  });
  const first = registry.readAsset('hkustgz', 'hkustgz-engine-config', 'engine-config');
  assert.deepEqual(first, fs.readFileSync(path.join(desktopRoot, '..', 'independent', 'config', 'hkustgz.json')));
  first.fill(0);
  assert.deepEqual(
    registry.readAsset('hkustgz', 'hkustgz-engine-config', 'engine-config'),
    sourceEngineConfig,
  );
  assert.throws(() => registry.readAsset('hkustgz', 'not-declared'), /not present/u);
  assert.throws(
    () => registry.resolveAsset('hkustgz', 'hkustgz-logo', 'engine-config'),
    /not present/u,
  );
});

test('package root and read-only filesystem operations are injectable', () => {
  let lstatCalls = 0;
  const fsImpl = Object.create(fs);
  fsImpl.lstatSync = (...args) => {
    lstatCalls += 1;
    return fs.lstatSync(...args);
  };
  const registry = new SchoolProfileRegistry({ packageRoot: desktopRoot, fsImpl }).load();
  assert.equal(registry.getDefaultProfile().profileId, 'hkustgz');
  assert.ok(lstatCalls > 0);
});

test('profile document contains deployment policy but no user authority', () => {
  const keys = [];
  const collectKeys = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      keys.push(key.toLowerCase());
      collectKeys(nested);
    }
  };
  collectKeys(sourceProfile);
  for (const forbidden of ['username', 'password', 'cookie', 'pin', 'userRule', 'accountKey']) {
    assert.equal(keys.includes(forbidden.toLowerCase()), false, forbidden);
  }
  assert.deepEqual(sourceProfile.browser.directPartnerDomains, [
    'outlook.office.com',
    'microsoftonline.com',
    'microsoftonline-p.com',
    'msauth.net',
    'msftauth.net',
    'cloud.microsoft',
    'office.com',
    'office.net',
    'sharepoint.com',
    'teams.microsoft.com',
    'sso.hkust-gz.edu.cn',
    'gzcas.hkust-gz.edu.cn',
    'hkust-gz.instructure.com',
    'instructure.com',
    'instructuremedia.com',
  ]);
  assert.deepEqual(sourceProfile.policy.reviewedDnsFallback, ['10.90.63.2', '10.90.63.3']);
});

test('unknown protocol families and undeclared profile references fail closed', (t) => {
  const unknownFamily = fixture(t, {
    mutateProfile: (profile) => { profile.gateway.protocolFamily = 'unknown-family'; },
  });
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: unknownFamily.root }).load(),
    /protocol family is unsupported/u,
  );

  const unknownReference = fixture(t, {
    mutateProfile: (profile) => { profile.gateway.engineConfigRef = 'unknown-config'; },
  });
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: unknownReference.root }).load(),
    /reference is not declared/u,
  );

  const unknownBranding = fixture(t, {
    mutateProfile: (profile) => { profile.branding.bundledAssetKey = 'unknown-logo'; },
  });
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: unknownBranding.root }).load(),
    /branding reference is not declared/u,
  );

  const unknownResources = fixture(t, {
    mutateProfile: (profile) => { profile.browser.builtinResourcesRef = 'unknown-resources'; },
  });
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: unknownResources.root }).load(),
    /resource reference is not declared/u,
  );
});

test('document and asset hash changes fail closed', (t) => {
  const documentFixture = fixture(t);
  fs.appendFileSync(
    path.join(documentFixture.root, 'assets', 'profiles', 'hkustgz', 'school-profile.json'),
    ' ',
  );
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: documentFixture.root }).load(),
    /document hash mismatch/u,
  );

  const assetFixture = fixture(t);
  fs.appendFileSync(path.join(assetFixture.root, 'assets', 'logo.svg'), ' ');
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: assetFixture.root }).load(),
    /asset hash mismatch/u,
  );
});

test('resource asset is the only content source and invalid reviewed entries fail closed', (t) => {
  const changed = fixture(t, {
    mutateResources: (document) => { document.resources[0].name = 'n'.repeat(41); },
  });
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: changed.root }).load(),
    /resource name/u,
  );
});

test('manifest permits exactly one default reviewed profile and known asset kinds', (t) => {
  const noDefault = fixture(t, {
    mutateManifest: (manifest) => { manifest.profiles[0].default = false; },
  });
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: noDefault.root }).load(),
    /exactly one default reviewed profile/u,
  );

  const secondProfile = fixture(t, {
    mutateManifest: (manifest) => { manifest.profiles.push(clone(manifest.profiles[0])); },
  });
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: secondProfile.root }).load(),
    /duplicate profile IDs|supports only/u,
  );

  const unknownKind = fixture(t, {
    mutateManifest: (manifest) => { manifest.profiles[0].assets[0].kind = 'executable'; },
  });
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: unknownKind.root }).load(),
    /kind is unsupported/u,
  );
});

test('registry accepts multiple reviewed schools without a compiled HKUST default', (t) => {
  const target = fixture(t);
  appendReviewedProfile(target, { makeDefault: true });
  const registry = new SchoolProfileRegistry({ packageRoot: target.root }).load();
  assert.equal(registry.getDefaultProfile().profileId, 'example-university');
  assert.deepEqual(registry.listViews({ locale: 'en', compatibility: 'reviewed' })
    .map(({ profileId }) => profileId), ['hkustgz', 'example-university']);
  assert.equal(registry.getBuiltinResources('example-university').length, 2);
  assert.equal(registry.resolveAsset(
    'example-university', 'example-university-engine-config', 'engine-config',
  ).sha256, target.manifest.profiles[1].assets[0].sha256);
});

test('package-relative paths cannot escape the package root', (t) => {
  const traversal = fixture(t, {
    mutateManifest: (manifest) => {
      manifest.profiles[0].assets[0].path = '../outside.json';
    },
  });
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: traversal.root }).load(),
    /safe package-relative path/u,
  );
});

test('symlinked and non-regular packaged assets fail closed', { skip: process.platform === 'win32' }, (t) => {
  const linked = fixture(t);
  const logo = path.join(linked.root, 'assets', 'logo.svg');
  const outside = path.join(linked.root, 'outside-logo.svg');
  fs.writeFileSync(outside, sourceLogo);
  fs.unlinkSync(logo);
  fs.symlinkSync(outside, logo);
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: linked.root }).load(),
    /uses a symlink/u,
  );

  const directory = fixture(t);
  const config = path.join(directory.root, 'assets', 'profiles', 'hkustgz', 'engine-config.json');
  fs.unlinkSync(config);
  fs.mkdirSync(config);
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: directory.root }).load(),
    /invalid type/u,
  );
});

test('POSIX packaged assets must share the package owner and reject broad write access', {
  skip: process.platform === 'win32',
}, (t) => {
  const broad = fixture(t);
  const logo = path.join(broad.root, 'assets', 'logo.svg');
  fs.chmodSync(logo, 0o666);
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: broad.root }).load(),
    /group\/world writable/u,
  );

  const broadDirectory = fixture(t);
  fs.chmodSync(path.join(broadDirectory.root, 'assets', 'profiles'), 0o777);
  assert.throws(
    () => new SchoolProfileRegistry({ packageRoot: broadDirectory.root }).load(),
    /group\/world writable/u,
  );
});
