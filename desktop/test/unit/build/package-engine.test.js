'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertEnginePresent,
  assertProxyCommandPresent,
  assertGatewayProbePresent,
  requiredEngineName,
  requiredGatewayProbeName,
  requiredProxyCommandName,
} = require('../../../build/afterPack');
const {
  TEST_ONLY_ENGINE_MARKER,
  REQUIRED_CONNECTION_OVERVIEW_ENTRIES,
  archiveEntryPath,
  assertPrivateEngineProfileBinding,
  assertMacDylibDependenciesAllowed,
  assertMacSystemOnlyDylibs,
  assertCustomResourceManager,
  assertExactNativeResources,
  assertLinuxElfArchitecture,
  assertNoTestOnlyEngineMarker,
  assertNoTestOnlyNativeResources,
  assertNoTestOnlyPackageEntries,
  assertRequiredPackageEntries,
  assertConnectionOverviewPackageEntries,
  assertConnectionOverviewNativeFeature,
  parseMachODylibDependencies,
  resolveResourcesDirectory,
} = require('../../../build/verify-package');

test('package verifier requires both native Connection Overview assets and rejects the legacy script', () => {
  const verifierSource = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'build', 'verify-package.js'), 'utf8');
  assert.match(verifierSource, /assertConnectionOverviewPackageEntries\(entries\)/u);
  assert.deepEqual(REQUIRED_CONNECTION_OVERVIEW_ENTRIES, [
    '/renderer/features/connection-overview/index.mjs',
    '/renderer/features/connection-overview/view.css',
  ]);
  assert.doesNotThrow(() => assertConnectionOverviewPackageEntries(new Set(REQUIRED_CONNECTION_OVERVIEW_ENTRIES)));
  for (const missing of REQUIRED_CONNECTION_OVERVIEW_ENTRIES) {
    const entries = new Set(REQUIRED_CONNECTION_OVERVIEW_ENTRIES.filter(entry => entry !== missing));
    entries.add('/renderer/connection-overview.js');
    assert.throws(() => assertConnectionOverviewPackageEntries(entries), /missing required packaged file:/u, missing);
  }
  assert.throws(() => assertConnectionOverviewPackageEntries(new Set([
    ...REQUIRED_CONNECTION_OVERVIEW_ENTRIES,
    '/renderer/connection-overview.js',
  ])), /legacy Renderer connection-overview script entered the package/u);
});

test('package verifier checks Connection Overview native host registration and app mount', () => {
  const rendererRoot = path.join(__dirname, '..', '..', '..', 'renderer');
  const verifierSource = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'build', 'verify-package.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(rendererRoot, 'app.js'), 'utf8');
  const hostSource = fs.readFileSync(path.join(rendererRoot, 'features', 'feature-host', 'index.mjs'), 'utf8');
  assert.match(verifierSource, /assertConnectionOverviewNativeFeature\(packagedRenderer,\s*packagedFeatureHost\)/u);
  assert.doesNotThrow(() => assertConnectionOverviewNativeFeature(appSource, hostSource));

  const rejectedSources = [
    [appSource.replace("import { createRendererFeatures } from './features/feature-host/index.mjs';", ''), hostSource],
    [appSource.replace("rendererFeatures.mount('connection-overview',", "rendererFeatures.mount('other-feature',"), hostSource],
    [appSource, hostSource.replace("import { create as createConnectionOverview } from '../connection-overview/index.mjs';", '')],
    [appSource, hostSource.replace("Object.freeze({ id: 'connection-overview', create: createConnectionOverview })", "Object.freeze({ id: 'other-feature', create: createConnectionOverview })")],
    [appSource, hostSource.replace("Object.freeze({ id: 'connection-overview', create: createConnectionOverview })", "Object.freeze({ id: 'connection-overview', create: createOtherFeature })")],
  ];
  for (const [app, host] of rejectedSources) {
    assert.throws(() => assertConnectionOverviewNativeFeature(app, host), /native Connection Overview feature/u);
  }
});

test('package verifier requires the update notice ESM entry in the ASAR', () => {
  const verifierSource = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'build', 'verify-package.js'), 'utf8');
  assert.match(verifierSource,
    /const requiredEntries = \[[\s\S]*?'\/renderer\/features\/update-notices\/index\.mjs'/u);
  assert.match(verifierSource, /assertRequiredPackageEntries\(entries, requiredEntries\)/u);
  const required = ['/renderer/features/update-notices/index.mjs'];
  assert.doesNotThrow(() => assertRequiredPackageEntries(new Set(required), required));
  assert.throws(() => assertRequiredPackageEntries(new Set(), required),
    /missing required packaged file: \/renderer\/features\/update-notices\/index\.mjs/u);
});

test('ASAR entry paths use the packaging host separator at every nesting level', () => {
  const entry = 'assets/profiles/hkustgz/school-profile.json';
  assert.equal(archiveEntryPath(entry, path.posix), entry);
  assert.equal(
    archiveEntryPath(entry, path.win32),
    'assets\\profiles\\hkustgz\\school-profile.json',
  );
});

test('profile binding verifier follows the packaged attempt owner and its Main injection', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
  const owner = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-process'), 'utf8');
  assert.doesNotThrow(() => assertPrivateEngineProfileBinding(main, entry => {
    assert.equal(entry, 'lib/connection/engine/engine-process.js'); return owner;
  }));
});

test('delegated binding rejects missing owner injection, argv digest, frame and ordering', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
  const owner = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-process'), 'utf8');
  const changes = [
    [main.replace("require('./lib/connection/engine/engine-process')", "require('./unreviewed-owner')"), owner],
    [main.replace('verifyEngineLaunchBinding: () => activeSchoolProfile.verifyEngineLaunchBinding()', 'verifyEngineLaunchBinding: () => null'), owner],
    [main, owner.replace('class EngineAttemptCoordinator', 'class UnreviewedOwner')],
    [main, owner.replace("'--profile-binding-v1-stdin'", "'--config-sha256'")],
    [main, owner.replace('${engineConfigBinding.stdinFrame}', '${unboundFrame}')],
    [main, owner.replace('engineConfigBinding = this.profile.verifyEngineLaunchBinding();', 'engineConfigBinding = unverifiedBinding;')],
    [main, owner.replace('const credentialOwner = this.openCredential(', 'const anotherOwner = this.openCredential(')],
    [main, owner.replace('const started = this.engineSupervisor.start(', 'const started = unreviewedStart(')],
  ];
  for (const [root, implementation] of changes) {
    assert.throws(() => assertPrivateEngineProfileBinding(root, () => implementation), /profile binding/u);
  }
  assert.throws(() => assertPrivateEngineProfileBinding(main, () => { throw new Error('missing owner'); }), /profile binding/u);
});

test('legacy inline binding keeps its original required flag and forbidden digest guard', () => {
  assert.doesNotThrow(() => assertPrivateEngineProfileBinding("'--profile-binding-v1-stdin'", () => assert.fail('no delegated owner')));
  for (const main of ['', "'--profile-binding-v1-stdin' '--config-sha256'"]) {
    assert.throws(() => assertPrivateEngineProfileBinding(main, () => ''), /profile binding/u);
  }
});

test('packaging maps each target to its required engine name', () => {
  assert.equal(requiredEngineName('darwin', 'arm64'), 'ec-engine-darwin-arm64');
  assert.equal(requiredEngineName('darwin', 3), 'ec-engine-darwin-arm64');
  assert.equal(requiredEngineName('win32', 'x64'), 'ec-engine-windows-amd64.exe');
  assert.equal(requiredEngineName('linux', 'x64'), 'ec-engine-linux-amd64');
  assert.equal(requiredProxyCommandName('darwin', 'arm64'), 'ec-proxy-command-darwin-arm64');
  assert.equal(requiredProxyCommandName('win32', 'x64'), 'ec-proxy-command-windows-amd64.exe');
  assert.equal(requiredProxyCommandName('linux', 'x64'), 'ec-proxy-command-linux-amd64');
  assert.equal(requiredGatewayProbeName('darwin', 'arm64'), 'ec-gateway-probe-darwin-arm64');
  assert.equal(requiredGatewayProbeName('win32', 'x64'), 'ec-gateway-probe-windows-amd64.exe');
});

test('the synthetic auth fixture is never a packaged native resource', () => {
  const packageDocument = require('../../../package.json');
  const filters = packageDocument.build.extraResources
    .flatMap((resource) => resource.filter || []);
  assert.equal(filters.some((entry) => String(entry).includes('ec-auth-fixture')), false);
});

test('Electron synthetic MFA fixtures are excluded from application files', () => {
  const packageDocument = require('../../../package.json');
  assert.equal(packageDocument.build.files.some((entry) => String(entry).startsWith('e2e/')), false);
  assert.equal(packageDocument.build.files.some((entry) => String(entry).startsWith('test/')), false);
});

test('package verifier rejects fake gateways, test PKI and private-key formats', (t) => {
  for (const entry of [
    '/fixtures/gateway.json',
    '/synthetic/auth.js',
    '/assets/test-ca.pem',
    '/assets/private-key.bin',
    '/lib/fake_gateway.js',
  ]) {
    assert.throws(
      () => assertNoTestOnlyPackageEntries(['/main.js', entry]),
      /test-only or private-key/u,
    );
  }
  assert.doesNotThrow(() => assertNoTestOnlyPackageEntries([
    '/main.js', '/lib/connection/auth/auth-challenge-coordinator.js',
    '/assets/profiles/hkustgz/builtin-resources.json',
  ]));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-native-resources-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'ec-engine-darwin-arm64'), 'binary');
  assert.doesNotThrow(() => assertNoTestOnlyNativeResources(directory));
  fs.writeFileSync(path.join(directory, 'test-ca.pem'), 'not-a-real-certificate');
  assert.throws(() => assertNoTestOnlyNativeResources(directory), /unsafe native resource/u);
});

test('package verifier rejects the feature-gated lifecycle Engine marker across read chunks', (t) => {
  assert.equal(TEST_ONLY_ENGINE_MARKER, 'HKUSTGZ_TEST_ONLY_ENGINE_LIFECYCLE_V1');
  const verifierSource = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'build', 'verify-package.js'), 'utf8');
  assert.match(verifierSource, /assertNoTestOnlyEngineMarker\(engine\)/u);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-test-engine-marker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clean = path.join(directory, 'clean-engine');
  const marked = path.join(directory, 'marked-engine');
  const boundaryMarked = path.join(directory, 'boundary-marked-engine');
  fs.writeFileSync(clean, `production:${TEST_ONLY_ENGINE_MARKER.slice(0, -1)}`);
  fs.writeFileSync(marked, `prefix${TEST_ONLY_ENGINE_MARKER}suffix`);
  fs.writeFileSync(boundaryMarked, Buffer.concat([
    Buffer.alloc((64 * 1024) - 7, 0x78),
    Buffer.from(TEST_ONLY_ENGINE_MARKER, 'ascii'),
  ]));

  assert.doesNotThrow(() => assertNoTestOnlyEngineMarker(clean));
  assert.throws(() => assertNoTestOnlyEngineMarker(marked), /test-only lifecycle Engine/u);
  assert.throws(() => assertNoTestOnlyEngineMarker(boundaryMarked), /test-only lifecycle Engine/u);
});

test('package verifier accepts only the exact target engine, helper and configuration', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-exact-native-resources-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const expected = [
    'ec-engine-darwin-arm64',
    'ec-proxy-command-darwin-arm64',
    'ec-gateway-probe-darwin-arm64',
    'hkustgz.json',
  ];
  for (const name of expected) fs.writeFileSync(path.join(directory, name), 'fixture');

  assert.deepEqual(assertExactNativeResources(directory, expected), [...expected].sort());

  fs.writeFileSync(path.join(directory, 'ec-engine-darwin-amd64'), 'wrong architecture');
  assert.throws(
    () => assertExactNativeResources(directory, expected),
    /native resource set is not exact:.*unexpected=ec-engine-darwin-amd64/u,
  );
  fs.unlinkSync(path.join(directory, 'ec-engine-darwin-amd64'));
  fs.unlinkSync(path.join(directory, 'hkustgz.json'));
  assert.throws(
    () => assertExactNativeResources(directory, expected),
    /native resource set is not exact:.*missing=hkustgz\.json/u,
  );
  fs.writeFileSync(path.join(directory, 'hkustgz.json'), '');
  assert.throws(
    () => assertExactNativeResources(directory, expected),
    /empty native resource entered the package: hkustgz\.json/u,
  );

  if (process.platform !== 'win32') {
    const linkedDirectory = `${directory}-link`;
    fs.symlinkSync(directory, linkedDirectory, 'dir');
    t.after(() => fs.unlinkSync(linkedDirectory));
    assert.throws(
      () => assertExactNativeResources(linkedDirectory, expected),
      /missing packaged engine directory/u,
    );
  }
});

test('package verification accepts x86_64 ELF executables and rejects another architecture', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-linux-elf-'));
  const executable = path.join(directory, 'ec-engine-linux-amd64');
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  header.writeUInt16LE(0x3e, 18);
  fs.writeFileSync(executable, header);

  assert.doesNotThrow(() => assertLinuxElfArchitecture(executable, 'amd64'));
  assert.throws(
    () => assertLinuxElfArchitecture(executable, 'arm64'),
    /not a arm64 Linux ELF executable/,
  );
});

test('macOS package verification rejects Homebrew and other host-only dylibs', () => {
  const dependencies = parseMachODylibDependencies(`fixture-engine:
\t/opt/homebrew/opt/xz/lib/liblzma.5.dylib (compatibility version 14.0.0, current version 14.3.0)
\t/usr/lib/libiconv.2.dylib (compatibility version 7.0.0, current version 7.0.0)
\t/System/Library/Frameworks/Security.framework/Versions/A/Security (compatibility version 1.0.0, current version 61439.120.27)
`);
  assert.deepEqual(dependencies, [
    '/opt/homebrew/opt/xz/lib/liblzma.5.dylib',
    '/usr/lib/libiconv.2.dylib',
    '/System/Library/Frameworks/Security.framework/Versions/A/Security',
  ]);
  assert.throws(
    () => assertMacDylibDependenciesAllowed(dependencies),
    /non-system dylib: \/opt\/homebrew\/opt\/xz\/lib\/liblzma\.5\.dylib/u,
  );
  assert.doesNotThrow(() => assertMacDylibDependenciesAllowed(dependencies.slice(1)));
  assert.throws(
    () => assertMacSystemOnlyDylibs('/definitely/missing/native-executable'),
    /otool diagnostics failed|ENOENT/u,
  );
  for (const dependency of dependencies.slice(1)) {
    assert.ok(
      dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/'),
    );
  }
  assert.equal(
    dependencies[0].startsWith('/usr/lib/') || dependencies[0].startsWith('/System/Library/'),
    false,
  );
});

test('packaging fails before signing when the SSH proxy helper is absent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-helper-'));
  assert.throws(
    () => assertProxyCommandPresent(directory, 'darwin', 'arm64'),
    /missing packaged SSH proxy helper:.*ec-proxy-command-darwin-arm64/,
  );
});

test('packaging fails before signing when the credential-free Gateway probe is absent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-gateway-probe-'));
  assert.throws(
    () => assertGatewayProbePresent(directory, 'darwin', 'arm64'),
    /missing packaged Gateway probe:.*ec-gateway-probe-darwin-arm64/u,
  );
});

test('packaging fails before signing when the native engine is absent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-engine-'));
  assert.throws(
    () => assertEnginePresent(directory, 'darwin', 'arm64'),
    /missing packaged engine:.*ec-engine-darwin-arm64/,
  );
});

test('packaging fails before signing when the native engine contains the lifecycle fixture', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-feature-engine-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, 'ec-engine-darwin-arm64'),
    `native-prefix:${TEST_ONLY_ENGINE_MARKER}:native-suffix`,
  );
  assert.throws(
    () => assertEnginePresent(directory, 'darwin', 'arm64'),
    /test-only lifecycle Engine entered the package/u,
  );
});

test('package verification accepts either a macOS app or its Resources directory', () => {
  const appPath = path.join(os.tmpdir(), 'hkustgzconnect.app');
  const resources = path.join(appPath, 'Contents', 'Resources');
  assert.equal(resolveResourcesDirectory(appPath), resources);
  assert.equal(resolveResourcesDirectory(resources), resources);
});

test('package verification rejects a build without the custom website manager', () => {
  assert.throws(
    () => assertCustomResourceManager({ html: '', renderer: '', preload: '', main: '' }),
    /custom resource manager is incomplete:.*manage button.*save handler/m,
  );

  const complete = {
    html: 'id="manageResources" id="addWebsiteDialog" id="groupDialog"',
    renderer: 'window.addWebsiteDialog.start( window.categoryGroupDialog.start(',
    preload: "createFavoriteResource: (resource) => ipcRenderer.invoke('create-favorite-resource', resource)",
    main: "ipcMain.handle('save-resource' app.on('certificate-error'",
  };
  assert.doesNotThrow(() => assertCustomResourceManager(complete));
  assert.doesNotThrow(() => assertCustomResourceManager({
    ...complete,
    main: "trustedHandle('save-resource' app.on('certificate-error'",
  }));
  assert.doesNotThrow(() => assertCustomResourceManager({
    ...complete,
    main: "registerControlDataIpc({ app.on('certificate-error'",
    controlDataIpc: 'registerCampusResourceIpc({ register',
    resourceIpc: "register('save-resource' register('create-favorite-resource' register('create-favorite-group'",
  }));
});
