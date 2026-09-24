'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');
const { classifyMacSignature } = require('./macos-signing');
const { parseBuiltinResourceDocument, parseServiceDeskDocument } = require('../lib/resources/schema/campus-resource-contract');
const {
  normalizeGatewayOrigin,
  validateSchoolProfileDocument,
} = require('../lib/profiles/schema/school-profile-schema');
const { normalizeManifest } = require('../lib/profiles/registry/school-profile-registry');

const FORBIDDEN_TEST_RESOURCE = /(?:^|\/)(?:e2e|tests?|fixtures?|synthetic|fake[-_]?gateway|test[-_]?ca|pki)(?:\/|[-_.])|(?:^|\/)private[-_]?key(?:$|[-_.\/])|\.(?:pem|key|p12|pfx)$/iu;
const TEST_ONLY_ENGINE_MARKER = 'HKUSTGZ_TEST_ONLY_ENGINE_LIFECYCLE_V1';
const TEST_ONLY_ENGINE_MARKER_BYTES = Buffer.from(TEST_ONLY_ENGINE_MARKER, 'ascii');
const MARKER_SCAN_CHUNK_BYTES = 64 * 1024;
const MAC_SYSTEM_DYLIB_PREFIXES = ['/usr/lib/', '/System/Library/'];
const MAX_PACKAGED_PROFILE_BYTES = 256 * 1024;
const MAX_PACKAGED_PROFILE_ASSET_BYTES = 4 * 1024 * 1024;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function archiveEntryPath(relativePath, pathImplementation = path) {
  if (typeof relativePath !== 'string' || !relativePath ||
      !pathImplementation || typeof pathImplementation.join !== 'function') {
    throw new TypeError('archive entry path is invalid');
  }
  return pathImplementation.join(...relativePath.split('/'));
}

function extractArchiveFile(archive, relativePath) {
  return asar.extractFile(archive, archiveEntryPath(relativePath));
}

function extractBoundedArchiveFile(archive, relativePath, maxBytes) {
  const data = extractArchiveFile(archive, relativePath);
  if (!Buffer.isBuffer(data) || data.length < 1 || data.length > maxBytes) {
    throw new Error(`packaged profile asset has an invalid size: ${relativePath}`);
  }
  return data;
}

function parsePackagedJson(data, name) {
  try { return JSON.parse(data.toString('utf8')); }
  catch { throw new Error(`packaged ${name} is not valid JSON`); }
}

function assertPackagedSchoolProfiles(archive, externalEngineDirectory) {
  const manifestData = extractBoundedArchiveFile(
    archive,
    'assets/profiles/manifest.json',
    MAX_PACKAGED_PROFILE_BYTES,
  );
  const manifest = normalizeManifest(parsePackagedJson(manifestData, 'profile manifest'));
  if (typeof externalEngineDirectory !== 'string' || !path.isAbsolute(externalEngineDirectory)) {
    throw new TypeError('packaged Engine config directory is invalid');
  }
  return Object.freeze(manifest.profiles.map((entry) => {
    const profileData = extractBoundedArchiveFile(
      archive,
      entry.document.path,
      MAX_PACKAGED_PROFILE_BYTES,
    );
    if (sha256(profileData) !== entry.document.sha256) {
      throw new Error(`packaged school profile document hash mismatch: ${entry.profileId}`);
    }
    const profileDocument = parsePackagedJson(profileData, 'school profile');
    const profile = validateSchoolProfileDocument(profileDocument);
    if (profile.profileId !== entry.profileId || profile.evidenceClass !== 'builtin-reviewed') {
      throw new Error(`packaged school profile identity mismatch: ${entry.profileId}`);
    }

    const assets = new Map();
    for (const asset of entry.assets) {
      const data = extractBoundedArchiveFile(archive, asset.path, MAX_PACKAGED_PROFILE_ASSET_BYTES);
      if (sha256(data) !== asset.sha256) {
        throw new Error(`packaged school profile asset hash mismatch: ${entry.profileId}/${asset.key}`);
      }
      assets.set(asset.key, { ...asset, data });
    }
    const engineAsset = assets.get(profile.gateway.engineConfigRef);
    const brandingAsset = assets.get(profile.branding.bundledAssetKey);
    const resourceAsset = assets.get(profile.browser.builtinResourcesRef);
    const serviceDeskAsset = assets.get(profile.browser.serviceDeskRef);
    if (assets.size !== 4 || engineAsset?.kind !== 'engine-config' ||
        brandingAsset?.kind !== 'branding' || resourceAsset?.kind !== 'builtin-resources' ||
        serviceDeskAsset?.kind !== 'service-desk') {
      throw new Error(`packaged school profile asset binding is incomplete: ${entry.profileId}`);
    }
    parseBuiltinResourceDocument(resourceAsset.data);
    parseServiceDeskDocument(serviceDeskAsset.data);

    const externalEngineConfig = path.join(externalEngineDirectory, `${profile.profileId}.json`);
    const externalConfigData = fs.readFileSync(externalEngineConfig);
    if (!externalConfigData.equals(engineAsset.data) ||
        sha256(externalConfigData) !== engineAsset.sha256) {
      throw new Error(`packaged external Engine config differs from its profile binding: ${entry.profileId}`);
    }
    const engineConfig = parsePackagedJson(externalConfigData, 'external Engine config');
    if (normalizeGatewayOrigin(engineConfig.base_url).origin !== profile.gateway.origin.origin) {
      throw new Error(`packaged Engine config Gateway differs from its school profile: ${entry.profileId}`);
    }
    return profile;
  }));
}

function assertPackagedSchoolProfile(archive, externalEngineConfig) {
  const profiles = assertPackagedSchoolProfiles(archive, path.dirname(externalEngineConfig));
  if (profiles.length !== 1 || path.basename(externalEngineConfig) !== `${profiles[0].profileId}.json`) {
    throw new Error('single-profile package verifier received a multi-profile package');
  }
  return profiles[0];
}

function resolveResourcesDirectory(input) {
  const resolved = path.resolve(input);
  return resolved.endsWith('.app') ? path.join(resolved, 'Contents', 'Resources') : resolved;
}

function resolveMacAppPath(input) {
  const resolved = path.resolve(input);
  if (resolved.endsWith('.app')) return resolved;
  if (path.basename(resolved) === 'Resources'
    && path.basename(path.dirname(resolved)) === 'Contents'
    && path.dirname(path.dirname(resolved)).endsWith('.app')) {
    return path.dirname(path.dirname(resolved));
  }
  return null;
}

function readMacSignature(appPath) {
  const result = spawnSync('codesign', ['-dvvv', appPath], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`codesign diagnostics failed for ${appPath}: ${String(result.stderr || '').trim()}`);
  }
  return classifyMacSignature(`${result.stdout || ''}\n${result.stderr || ''}`);
}

function assertLinuxElfArchitecture(executable, architectureName) {
  const descriptor = fs.openSync(executable, 'r');
  const header = Buffer.alloc(20);
  let bytesRead;
  try {
    bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const isElf = header.length >= 20
    && bytesRead === header.length
    && header[0] === 0x7f
    && header.subarray(1, 4).toString('ascii') === 'ELF'
    && header[4] === 2;
  const byteOrder = isElf ? header[5] : 0;
  const machine = byteOrder === 1
    ? header.readUInt16LE(18)
    : byteOrder === 2
      ? header.readUInt16BE(18)
      : -1;
  const expectedMachine = architectureName === 'arm64' ? 0xb7 : 0x3e;
  if (!isElf || machine !== expectedMachine) {
    throw new Error(
      `packaged binary is not a ${architectureName} Linux ELF executable: ${executable}`,
    );
  }
}

function parseMachODylibDependencies(output) {
  const lines = String(output || '').split(/\r?\n/u);
  return lines.slice(1).map((line) => line.trim()).filter(Boolean).map((line) => {
    const metadata = line.indexOf(' (compatibility version ');
    return metadata >= 0 ? line.slice(0, metadata) : line.split(/\s+/u)[0];
  }).filter(Boolean);
}

function assertMacDylibDependenciesAllowed(dependencies) {
  for (const dependency of dependencies) {
    if (!MAC_SYSTEM_DYLIB_PREFIXES.some((prefix) => dependency.startsWith(prefix))) {
      throw new Error(
        `packaged macOS native executable depends on a non-system dylib: ${dependency}`,
      );
    }
  }
}

function assertMacSystemOnlyDylibs(executable) {
  const result = spawnSync('otool', ['-L', executable], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `otool diagnostics failed for ${executable}: ${String(result.stderr || '').trim()}`,
    );
  }
  const dependencies = parseMachODylibDependencies(result.stdout);
  assertMacDylibDependenciesAllowed(dependencies);
  return dependencies;
}

function assertMacAppIcon(appPath) {
  const icon = path.join(appPath, 'Contents', 'Resources', 'icon.icns');
  if (!fs.existsSync(icon) || !fs.statSync(icon).isFile() || fs.statSync(icon).size === 0) {
    throw new Error(`missing packaged macOS icon: ${icon}`);
  }
  const verifier = path.join(__dirname, 'verify-macos-icon.swift');
  const result = spawnSync('xcrun', ['swift', verifier, icon], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `packaged macOS icon is incompatible: ${String(result.stderr || result.stdout || '').trim()}`,
    );
  }
  return String(result.stdout || '').trim();
}

function assertNoTestOnlyEngineMarker(executable) {
  const descriptor = fs.openSync(executable, 'r');
  let overlap = Buffer.alloc(0);
  try {
    while (true) {
      const chunk = Buffer.alloc(MARKER_SCAN_CHUNK_BYTES);
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const searchable = overlap.length
        ? Buffer.concat([overlap, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      if (searchable.indexOf(TEST_ONLY_ENGINE_MARKER_BYTES) !== -1) {
        throw new Error(`test-only lifecycle Engine entered the package: ${executable}`);
      }
      const overlapBytes = Math.min(TEST_ONLY_ENGINE_MARKER_BYTES.length - 1, searchable.length);
      overlap = Buffer.from(searchable.subarray(searchable.length - overlapBytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseArguments(argv) {
  const positional = [];
  let requireAppleSignature = false;
  for (const argument of argv) {
    if (argument === '--require-apple-signature') requireAppleSignature = true;
    else positional.push(argument);
  }
  return {
    resourcesArgument: positional[0],
    platform: positional[1] || process.platform,
    architecture: positional[2] || process.arch,
    requireAppleSignature,
  };
}

function assertCustomResourceManager({
  html,
  renderer,
  preload,
  main,
  controlDataIpc = '',
  resourceIpc = '',
}) {
  const missing = [];
  if (!String(html).includes('id="manageResources"')) missing.push('manage button');
  if (!String(html).includes('id="addWebsiteDialog"')) missing.push('add website dialog');
  if (!String(html).includes('id="groupDialog"')) missing.push('category dialog');
  if (!String(renderer).includes('window.addWebsiteDialog.start(')) {
    missing.push('renderer add-website feature');
  }
  if (!String(renderer).includes('window.categoryGroupDialog.start(')) {
    missing.push('renderer category dialog feature');
  }
  if (!String(preload).includes(
    "createFavoriteResource: (resource) => ipcRenderer.invoke('create-favorite-resource', resource)",
  )) missing.push('preload bridge');
  const directHandler = String(main).includes("ipcMain.handle('save-resource'")
    || String(main).includes("trustedHandle('save-resource'");
  const composedHandler = String(main).includes('registerControlDataIpc(')
    && String(controlDataIpc).includes('registerCampusResourceIpc(')
    && String(resourceIpc).includes("register('save-resource'")
    && String(resourceIpc).includes("register('create-favorite-resource'")
    && String(resourceIpc).includes("register('create-favorite-group'");
  if (!directHandler && !composedHandler) {
    missing.push('save handler');
  }
  if (!String(main).includes("app.on('certificate-error'")) missing.push('certificate handler');
  if (missing.length) {
    throw new Error(`custom resource manager is incomplete: ${missing.join(', ')}`);
  }
}

function assertNoTestOnlyPackageEntries(entries) {
  for (const rawEntry of entries) {
    const entry = String(rawEntry).replaceAll('\\', '/');
    if (FORBIDDEN_TEST_RESOURCE.test(entry)) {
      throw new Error(`test-only or private-key resource entered the package: ${entry}`);
    }
  }
}

function assertNoTestOnlyNativeResources(engineDirectory) {
  let directoryStat;
  try { directoryStat = fs.lstatSync(engineDirectory); } catch {}
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`missing packaged engine directory: ${engineDirectory}`);
  }
  const entries = fs.readdirSync(engineDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const normalized = `/${entry.name}`;
    if (!entry.isFile() || entry.isSymbolicLink() || FORBIDDEN_TEST_RESOURCE.test(normalized)) {
      throw new Error(`test-only or unsafe native resource entered the package: ${entry.name}`);
    }
  }
}

function assertExactNativeResources(engineDirectory, expectedNames) {
  if (!Array.isArray(expectedNames) || expectedNames.length === 0 ||
      expectedNames.some((name) => (
        typeof name !== 'string' || !name || path.basename(name) !== name || /[\0\r\n]/u.test(name)
      ))) {
    throw new TypeError('expected native resource names are invalid');
  }
  let directoryStat;
  try { directoryStat = fs.lstatSync(engineDirectory); } catch {}
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`missing packaged engine directory: ${engineDirectory}`);
  }

  const expected = [...new Set(expectedNames)].sort();
  const actual = [];
  for (const entry of fs.readdirSync(engineDirectory, { withFileTypes: true })) {
    const normalized = `/${entry.name}`;
    if (!entry.isFile() || entry.isSymbolicLink() || FORBIDDEN_TEST_RESOURCE.test(normalized)) {
      throw new Error(`test-only or unsafe native resource entered the package: ${entry.name}`);
    }
    const resource = path.join(engineDirectory, entry.name);
    if (fs.statSync(resource).size === 0) {
      throw new Error(`empty native resource entered the package: ${entry.name}`);
    }
    actual.push(entry.name);
  }
  actual.sort();

  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));
  if (missing.length || unexpected.length) {
    const details = [
      missing.length ? `missing=${missing.join(',')}` : '',
      unexpected.length ? `unexpected=${unexpected.join(',')}` : '',
    ].filter(Boolean).join(' ');
    throw new Error(`packaged native resource set is not exact: ${details}`);
  }
  return actual;
}

function verifyPackage({ resourcesArgument, platform = process.platform, architecture = process.arch, requireAppleSignature = false }) {
  if (!resourcesArgument) {
    throw new Error('usage: node build/verify-package.js <app-or-resources-dir> [platform] [arch] [--require-apple-signature]');
  }

  const resources = resolveResourcesDirectory(resourcesArgument);
  const archive = path.join(resources, 'app.asar');
  if (!fs.existsSync(archive)) throw new Error(`missing packaged application: ${archive}`);

  const entries = new Set(
    asar.listPackage(archive).map((entry) => entry.replaceAll('\\', '/')),
  );
  const requiredEntries = [
    '/main.js',
    '/preload.js',
    '/campus-preload.js',
    '/lib/browser/session/campus-browser.js',
    '/lib/browser/toolbar/campus-toolbar-contract.js',
    '/lib/browser/certificates/campus-certificate-trust.js',
    '/lib/browser/credentials/campus-credential-vault.js',
    '/lib/app/desktop-runtime-composition.js',
    '/lib/platform/i18n/i18n.js',
    '/lib/browser/auth/login-flow.js',
    '/lib/resources/presentation/resource-view.js',
    '/lib/connection/engine/engine-control-client.js',
    '/lib/connection/engine/engine-auth-control-client.js',
    '/lib/connection/engine/engine-connection-runtime.js',
    '/lib/connection/state/connection-recovery-presentation.js',
    '/lib/connection/engine/engine-control-suite.js',
    '/lib/platform/shell/desktop-shell.js',
    '/lib/platform/storage/windows-private-file.js',
    '/lib/browser/session/campus-browser-manager.js',
    '/lib/profiles/schema/school-profile-schema.js',
    '/lib/resources/schema/campus-resource-contract.js',
    '/lib/resources/schema/resource-activity-contract.js',
    '/lib/resources/runtime/resource-activity-store.js',
    '/lib/resources/runtime/resource-library-runtime.js',
    '/lib/profiles/registry/school-profile-registry.js',
    '/lib/profiles/runtime/school-profile-runtime.js',
    '/lib/profiles/runtime/school-profile-controller.js',
    '/lib/profiles/deletion/custom-profile-deletion-runtime.js',
    '/lib/integrations/atomic-export-file-transaction.js',
    '/lib/ipc/control-state-snapshot.js',
    '/lib/connection/telemetry/connection-telemetry-coordinator.js',
    '/lib/connection/engine/engine-protocol-session.js',
    '/lib/connection/auth/auth-challenge-coordinator.js',
    '/lib/ipc/control-data-ipc.js',
    '/lib/ipc/control-ipc-suite.js',
    '/lib/ipc/core-control-ipc.js',
    '/lib/ipc/settings-credential-ipc.js',
    '/lib/ipc/routing-rule-ipc.js',
    '/lib/ipc/certificate-pin-ipc.js',
    '/lib/ipc/campus-resource-ipc.js',
    '/lib/ipc/browser-data-ipc.js',
    '/lib/persistence/settings/settings-update.js',
    '/lib/connection/recovery/tunnel-health.js',
    '/lib/platform/update/update-check.js',
    '/renderer/app.js',
    '/renderer/features/auth-challenge/index.mjs',
    '/renderer/features/auth-challenge/controller.mjs',
    '/renderer/features/auth-challenge/lifecycle.mjs',
    '/renderer/routing-manager.js',
    '/renderer/certificate-manager.js',
    '/renderer/group-dialog.js',
    '/renderer/campus-service-workspace.js',
    '/renderer/notification-view.js',
    '/renderer/browser-data-settings.js',
    '/renderer/proxy-auth-migration.js',
    '/renderer/i18n.js',
    '/renderer/design-tokens.css',
    '/renderer/campus-browser.html',
    '/renderer/campus-browser.js',
    '/renderer/campus-browser.css',
    '/renderer/campus-workspace.html',
    '/renderer/campus-workspace.js',
    '/renderer/campus-workspace-model.js',
    '/renderer/campus-workspace.css',
    '/renderer/campus-category-stacks.js',
    '/renderer/connection-overview.js',
    '/renderer/notification-drawer.js',
    '/renderer/styles.css',
    '/lib/browser/workspace/campus-workspace-controller.js',
    '/lib/browser/workspace/campus-workspace-preload.js',
    '/assets/profiles/manifest.json',
    '/assets/profiles/hkustgz/school-profile.json',
    '/assets/profiles/hkustgz/engine-config.json',
    '/assets/profiles/hkustgz/builtin-resources.json',
    '/assets/profiles/hkustgz/builtin-service-desk.json',
  ];
  for (const entry of requiredEntries) {
    if (!entries.has(entry)) throw new Error(`missing required packaged file: ${entry}`);
  }
  if (entries.has('/assets/campus-resources.json')) {
    throw new Error('legacy duplicate campus resource asset entered the package');
  }
  for (const retiredEntry of [
    '/lib/integrations/clash-verge-managed-coordinator.js',
    '/lib/integrations/clash-verge-script.js',
    '/lib/integrations/integration-record-store.js',
    '/lib/integrations/managed-adapter-transaction.js',
    '/lib/integrations/managed-file-transaction.js',
    '/lib/integrations/managed-text-block.js',
    '/lib/integrations/openssh-managed-config.js',
    '/lib/integrations/openssh-managed-coordinator.js',
  ]) {
    if (entries.has(retiredEntry)) {
      throw new Error(`retired third-party installer entered the package: ${retiredEntry}`);
    }
  }
  assertNoTestOnlyPackageEntries(entries);

  const packagedIndex = extractArchiveFile(archive, 'renderer/index.html').toString('utf8');
  const packagedRenderer = extractArchiveFile(archive, 'renderer/app.js').toString('utf8');
  const packagedPreload = extractArchiveFile(archive, 'preload.js').toString('utf8');
  const packagedMain = extractArchiveFile(archive, 'main.js').toString('utf8');
  const packagedControlDataIpc = extractArchiveFile(archive, 'lib/ipc/control-data-ipc.js')
    .toString('utf8');
  const packagedResourceIpc = extractArchiveFile(archive, 'lib/ipc/campus-resource-ipc.js')
    .toString('utf8');
  const packagedCategoryStacks = extractArchiveFile(archive, 'renderer/campus-category-stacks.js')
    .toString('utf8');
  const packagedServiceWorkspace = extractArchiveFile(archive, 'renderer/campus-service-workspace.js')
    .toString('utf8');
  if (!packagedMain.includes("'--profile-binding-v1-stdin'") ||
      packagedMain.includes("'--config-sha256'")) {
    throw new Error('packaged Desktop does not enforce private Engine profile binding');
  }
  if (!packagedMain.includes('customGatewayProductAvailability()') ||
      /customGatewayOnboardingEnabled\s*=\s*!app\.isPackaged/u.test(packagedMain)) {
    throw new Error('packaged product does not expose safe Other-school onboarding');
  }
  for (const [name, source] of [
    ['Main', packagedMain], ['Preload', packagedPreload], ['Core IPC',
      extractArchiveFile(archive, 'lib/ipc/core-control-ipc.js').toString('utf8')],
  ]) {
    if (/copy-clash-node|ssh-config|legacyExternalProxyActions/u.test(source)) {
      throw new Error(`packaged ${name} exposes a retired external-tool control`);
    }
  }
  for (const [helper, source] of [
    ['login-flow', '../lib/browser/auth/login-flow.js'],
    ['resource-view', '../lib/resources/presentation/resource-view.js'],
  ]) {
    if (!packagedIndex.includes(source)) {
      throw new Error(`renderer does not load its shared helper: ${helper}`);
    }
  }
  for (const feature of [
    'routing-manager', 'certificate-manager', 'group-dialog',
    'proxy-auth-migration', 'notification-view', 'notification-drawer',
    'connection-overview', 'campus-category-stacks', 'campus-service-workspace',
    'browser-data-settings',
  ]) {
    const featureScript = packagedIndex.indexOf(`src="${feature}.js"`);
    const appScript = packagedIndex.indexOf('src="app.js"');
    if (featureScript < 0 || appScript < 0 || featureScript >= appScript) {
      throw new Error(`renderer does not load its feature before app: ${feature}`);
    }
  }
  for (const helper of ['evaluateLoginProgress', 'visibleResources', 'routeLabel']) {
    if (packagedRenderer.includes(`function ${helper}`)) {
      throw new Error(`renderer duplicates its shared helper: ${helper}`);
    }
  }
  if (!packagedRenderer.includes('window.loginFlow') ||
      !packagedRenderer.includes('window.campusCategoryStacks') ||
      !packagedCategoryStacks.includes('personalCategoryProjection') ||
      !packagedServiceWorkspace.includes('campusSearchPresenter')) {
    throw new Error('renderer does not consume the packaged shared helper APIs');
  }
  assertCustomResourceManager({
    html: packagedIndex,
    renderer: packagedRenderer,
    preload: packagedPreload,
    main: packagedMain,
    controlDataIpc: packagedControlDataIpc,
    resourceIpc: packagedResourceIpc,
  });

  const platformName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  const architectureName = architecture === 'arm64' ? 'arm64' : 'amd64';
  const extension = platformName === 'windows' ? '.exe' : '';
  const engineName = `ec-engine-${platformName}-${architectureName}${extension}`;
  const proxyCommandName = `ec-proxy-command-${platformName}-${architectureName}${extension}`;
  const gatewayProbeName = `ec-gateway-probe-${platformName}-${architectureName}${extension}`;
  const engine = path.join(resources, 'engine', engineName);
  const proxyCommand = path.join(resources, 'engine', proxyCommandName);
  const gatewayProbe = path.join(resources, 'engine', gatewayProbeName);
  const privateFileName = 'ec-private-file-windows-' + architectureName + '.exe';
  const privateFile = path.join(resources, 'engine', privateFileName);
  const packagedProfiles = assertPackagedSchoolProfiles(archive, path.join(resources, 'engine'));
  assertExactNativeResources(path.join(resources, 'engine'), [
    engineName,
    proxyCommandName,
    gatewayProbeName,
    ...(platformName === 'windows' ? [privateFileName] : []),
    ...packagedProfiles.map(({ profileId }) => `${profileId}.json`),
  ]);
  for (const [label, executable] of [
    ['engine', engine], ['SSH proxy helper', proxyCommand], ['Gateway probe', gatewayProbe],
    ...(platformName === 'windows' ? [['private-file helper', privateFile]] : []),
  ]) {
    if (!fs.existsSync(executable) || !fs.statSync(executable).isFile() || fs.statSync(executable).size === 0) {
      throw new Error(`missing packaged ${label}: ${executable}`);
    }
  }
  assertNoTestOnlyEngineMarker(engine);
  if (platformName === 'windows') {
    for (const executable of [engine, proxyCommand, gatewayProbe, privateFile]) {
      const header = fs.readFileSync(executable);
      const peOffset = header.length >= 0x40 ? header.readUInt32LE(0x3c) : -1;
      const signature = peOffset >= 0 && peOffset + 6 <= header.length
        ? header.subarray(peOffset, peOffset + 4).toString('binary')
        : '';
      const machine = signature === 'PE\u0000\u0000' ? header.readUInt16LE(peOffset + 4) : -1;
      const expectedMachine = architectureName === 'arm64' ? 0xaa64 : 0x8664;
      if (machine !== expectedMachine) {
        throw new Error(
          `packaged binary is not a ${architectureName} Windows PE executable: ${executable}`,
        );
      }
    }
  } else if (platformName === 'linux') {
    for (const executable of [engine, proxyCommand, gatewayProbe]) {
      assertLinuxElfArchitecture(executable, architectureName);
    }
  } else if (platformName === 'darwin') {
    for (const executable of [engine, proxyCommand, gatewayProbe]) {
      assertMacSystemOnlyDylibs(executable);
    }
  }

  const packagedManifest = JSON.parse(extractArchiveFile(archive, 'package.json').toString('utf8'));
  const sourceManifest = require(path.join(__dirname, '..', 'package.json'));
  if (packagedManifest.version !== sourceManifest.version) {
    throw new Error(
      `packaged version ${packagedManifest.version} does not match source ${sourceManifest.version}`,
    );
  }

  let signature = 'not-applicable';
  const appPath = platformName === 'darwin' ? resolveMacAppPath(resourcesArgument) : null;
  if (appPath) {
    assertMacAppIcon(appPath);
    signature = readMacSignature(appPath);
  }
  if (requireAppleSignature && signature !== 'apple') {
    throw new Error(`package requires an Apple signature, found signature=${signature}`);
  }

  return `verified ${platformName}/${architectureName}: campus browser, settings update, engine, signature=${signature}, v${packagedManifest.version}`;
}

module.exports = {
  TEST_ONLY_ENGINE_MARKER,
  archiveEntryPath,
  assertMacDylibDependenciesAllowed,
  assertMacAppIcon,
  assertMacSystemOnlyDylibs,
  assertLinuxElfArchitecture,
  assertCustomResourceManager,
  assertExactNativeResources,
  assertNoTestOnlyEngineMarker,
  assertPackagedSchoolProfile,
  assertPackagedSchoolProfiles,
  assertNoTestOnlyNativeResources,
  assertNoTestOnlyPackageEntries,
  parseArguments,
  parseMachODylibDependencies,
  readMacSignature,
  resolveMacAppPath,
  resolveResourcesDirectory,
  verifyPackage,
};

if (require.main === module) {
  process.stdout.write(`${verifyPackage(parseArguments(process.argv.slice(2)))}\n`);
}
