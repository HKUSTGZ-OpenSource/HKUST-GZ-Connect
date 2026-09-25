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
  archiveEntryPath,
  assertMacDylibDependenciesAllowed,
  assertMacSystemOnlyDylibs,
  assertCustomResourceManager,
  assertExactNativeResources,
  assertLinuxElfArchitecture,
  assertNoTestOnlyEngineMarker,
  assertNoTestOnlyNativeResources,
  assertNoTestOnlyPackageEntries,
  parseMachODylibDependencies,
  resolveResourcesDirectory,
} = require('../../../build/verify-package');

test('ASAR entry paths use the packaging host separator at every nesting level', () => {
  const entry = 'assets/profiles/hkustgz/school-profile.json';
  assert.equal(archiveEntryPath(entry, path.posix), entry);
  assert.equal(
    archiveEntryPath(entry, path.win32),
    'assets\\profiles\\hkustgz\\school-profile.json',
  );
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
