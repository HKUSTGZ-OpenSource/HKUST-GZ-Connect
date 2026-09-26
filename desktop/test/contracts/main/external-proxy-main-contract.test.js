'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
const integrationSuite = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'lib', 'ipc', 'integration-center-suite.js'), 'utf8',
);
const connectStart = source.indexOf('async function connectOnce(');
const connectEnd = source.indexOf('\nfunction ensureEngineStopped()', connectStart);
const connectOnce = source.slice(connectStart, connectEnd);

test('strict and compatibility generations share one stable credential with distinct policies', () => {
  assert.match(source, /const PROXY_CREDENTIAL = runtimeStoragePaths\.proxyCredential/);
  assert.match(connectOnce, /proxyCredential = generationProxyCredential\(Number\(s\.port\)\);\s*proxyCredentialMode = 'required'/);
  assert.match(connectOnce, /stableProxyCredential \|\| fs\.existsSync\(PROXY_CREDENTIAL\)[\s\S]*proxyCredentialMode = 'optional'/);
  assert.match(connectOnce, /proxyCredentialMode === 'required'[^\n]+--socks-auth-stdin/);
  assert.match(connectOnce, /proxyCredentialMode === 'optional'[^\n]+--socks-auth-optional-stdin/);
  assert.match(
    connectOnce,
    /\$\{engineConfigBinding\.stdinFrame\}\\n\$\{username\}\\n\$\{pw\}\\n\$\{proxyCredentialLines\}/,
  );
  assert.match(connectOnce, /'--control-api-v2-stdin'/);
});

test('all advanced configuration flows through the closed Integration Center', () => {
  assert.doesNotMatch(integrationSuite, /copyClashNode|sshConfig|buildClashProxyYaml/u);
  assert.doesNotMatch(source, /legacyExternalProxyActions|createLegacyExternalProxyActions/u);
  assert.match(integrationSuite, /createIntegrationCenterRuntime/u);
  assert.match(source, /integrations: externalIntegrationRuntime/u);
});

test('VS Code snippet sidecar follows the connection and Profile lifecycle', () => {
  assert.match(source, /helperPath: proxyHelperPath\(\), credentialFile: PROXY_HELPER_CREDENTIAL/u);
  assert.match(source, /ensureSidecar: \(\) => ensureExternalProxyAccess\(socksPort\(\)\)/u);
  const disconnectStart = source.indexOf('async function disconnect(');
  const reconnectStart = source.indexOf('\nfunction waitForConnected(', disconnectStart);
  assert.match(source.slice(disconnectStart, reconnectStart), /removeExternalProxySidecar\(\)/);
  const exitStart = source.indexOf('function handleEngineExitBoundary');
  const exitEnd = source.indexOf('\nasync function connectOnce(', exitStart);
  assert.match(source.slice(exitStart, exitEnd), /engineTermination\.exit\(\.\.\.args\)/);
  assert.match(source, /removeSidecar: removeExternalProxySidecar/u);
  const termination = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-connection-runtime'), 'utf8');
  assert.match(termination.slice(termination.indexOf('  exit({ generation }')), /this\.removeSidecar\(\)/);
  assert.match(source, /stableProxyCredential\?\.destroy\(\)/);
});

test('Profile switch revokes in-memory and sidecar access before the next Account activates', () => {
  assert.match(source, /function revokeExternalProxyAccess\(\) \{ clearActiveProxyCredential\(\);/u);
  assert.match(source, /stableProxyCredential\?\.destroy\(\); stableProxyCredential = null;/u);
  assert.match(source, /revokeProxyAccess: revokeExternalProxyAccess/u);
});
