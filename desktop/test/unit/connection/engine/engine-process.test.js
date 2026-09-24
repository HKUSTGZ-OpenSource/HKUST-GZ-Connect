'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SYNTHETIC_ENGINE_E2E_ENV,
  SYNTHETIC_GATEWAY_PROBE_E2E_ENV,
  exactExecutablePattern,
  resolveEngineLaunch,
  resolveGatewayProbeLaunch,
  resolveNativeResourcePath,
} = require('../../../../lib/connection/engine/engine-process');

test('orphan cleanup matches only the resolved engine executable', () => {
  const pattern = new RegExp(exactExecutablePattern('/tmp/build+test/ec-engine'));
  assert.equal(pattern.test('/tmp/build+test/ec-engine --config profile.json'), true);
  assert.equal(pattern.test('cargo build --bin ec-engine'), false);
  assert.equal(pattern.test('/other/ec-engine --config profile.json'), false);
});

test('native resource resolver selects exact platform architecture and kind', () => {
  const baseDirectory = path.resolve('/app/desktop');
  const resourcesPath = path.resolve('/app/resources');
  const expected = path.join(resourcesPath, 'engine', 'ec-gateway-probe-darwin-arm64');
  const existing = new Set([expected]);
  assert.equal(resolveNativeResourcePath({
    kind: 'ec-gateway-probe',
    appIsPackaged: true,
    baseDirectory,
    resourcesPath,
    platform: 'darwin',
    architecture: 'arm64',
    fileSystem: { existsSync: (file) => existing.has(file) },
  }), expected);
  assert.throws(() => resolveNativeResourcePath({
    kind: 'unknown', appIsPackaged: true, baseDirectory, resourcesPath,
  }), /native resource/u);
});

test('synthetic Engine launch is a fixed dev-only fixture and packaged apps ignore it', (t) => {
  const baseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-engine-launch-'));
  t.after(() => fs.rmSync(baseDirectory, { recursive: true, force: true }));
  const e2e = path.join(baseDirectory, 'e2e');
  const fixture = path.join(e2e, 'main-engine-fixture.js');
  fs.mkdirSync(e2e);
  fs.writeFileSync(fixture, 'fixture');
  const input = {
    baseDirectory,
    nativeEngine: path.join(baseDirectory, 'engine', 'ec-engine'),
    execPath: path.join(baseDirectory, 'Electron'),
    environment: { [SYNTHETIC_ENGINE_E2E_ENV]: '1', TEST_MARKER: 'kept' },
  };

  const development = resolveEngineLaunch({ ...input, appIsPackaged: false });
  assert.equal(development.synthetic, true);
  assert.equal(development.command, input.execPath);
  assert.deepEqual(development.argsPrefix, [fs.realpathSync(fixture)]);
  assert.equal(development.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(development.options.env.TEST_MARKER, 'kept');

  const packaged = resolveEngineLaunch({ ...input, appIsPackaged: true });
  assert.deepEqual(packaged, {
    command: input.nativeEngine,
    argsPrefix: [],
    options: {},
    synthetic: false,
  });
});

test('synthetic Engine fixture cannot resolve through an e2e symlink to another directory', {
  skip: process.platform === 'win32',
}, (t) => {
  const baseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-engine-escape-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-engine-outside-'));
  t.after(() => fs.rmSync(baseDirectory, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(baseDirectory, 'e2e'));
  fs.writeFileSync(path.join(outside, 'main-engine-fixture.js'), 'fixture');
  fs.symlinkSync(
    path.join(outside, 'main-engine-fixture.js'),
    path.join(baseDirectory, 'e2e', 'main-engine-fixture.js'),
  );

  assert.throws(() => resolveEngineLaunch({
    appIsPackaged: false,
    baseDirectory,
    nativeEngine: path.join(baseDirectory, 'ec-engine'),
    execPath: path.join(baseDirectory, 'Electron'),
    environment: { [SYNTHETIC_ENGINE_E2E_ENV]: '1' },
  }), /escaped its test directory/u);
});

test('synthetic Gateway probe launch is fixed, development-only, and never carries an environment', (t) => {
  const baseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-probe-launch-'));
  t.after(() => fs.rmSync(baseDirectory, { recursive: true, force: true }));
  const fixture = path.join(baseDirectory, 'e2e', 'main-gateway-probe-fixture.js');
  fs.mkdirSync(path.dirname(fixture));
  fs.writeFileSync(fixture, 'fixture');
  const input = {
    baseDirectory,
    nativeProbe: path.join(baseDirectory, 'engine', 'ec-gateway-probe'),
    execPath: path.join(baseDirectory, 'Electron'),
    environment: { [SYNTHETIC_GATEWAY_PROBE_E2E_ENV]: '1', SECRET: 'must-not-cross' },
  };

  assert.deepEqual(resolveGatewayProbeLaunch({ ...input, appIsPackaged: false }), {
    command: input.execPath,
    argsPrefix: [fs.realpathSync(fixture)],
    electronRunAsNode: true,
    synthetic: true,
  });
  assert.deepEqual(resolveGatewayProbeLaunch({ ...input, appIsPackaged: true }), {
    command: input.nativeProbe,
    argsPrefix: [],
    electronRunAsNode: false,
    synthetic: false,
  });
});

test('synthetic Gateway probe fixture cannot escape the fixed e2e directory', {
  skip: process.platform === 'win32',
}, (t) => {
  const baseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-probe-escape-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-probe-outside-'));
  t.after(() => fs.rmSync(baseDirectory, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(baseDirectory, 'e2e'));
  fs.writeFileSync(path.join(outside, 'main-gateway-probe-fixture.js'), 'fixture');
  fs.symlinkSync(
    path.join(outside, 'main-gateway-probe-fixture.js'),
    path.join(baseDirectory, 'e2e', 'main-gateway-probe-fixture.js'),
  );
  assert.throws(() => resolveGatewayProbeLaunch({
    appIsPackaged: false,
    baseDirectory,
    nativeProbe: path.join(baseDirectory, 'ec-gateway-probe'),
    execPath: path.join(baseDirectory, 'Electron'),
    environment: { [SYNTHETIC_GATEWAY_PROBE_E2E_ENV]: '1' },
  }), /escaped its test directory/u);
});
