'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const attempt = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-process'), 'utf8');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
const proxyOwner = fs.readFileSync(require.resolve('../../../lib/persistence/credentials/proxy-credential'), 'utf8');
const integrationSuite = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'lib', 'ipc', 'integration-center-suite.js'), 'utf8',
);
const connectOnce = attempt;
const operations = fs.readFileSync(require.resolve('../../../lib/connection/state/connection-state-machine'), 'utf8');

test('strict and compatibility generations share one stable credential with distinct policies', () => {
  assert.match(source, /engineAttempts\.run\(isRetry, intent\)/u);
  assert.match(source, /const PROXY_CREDENTIAL = runtimeStoragePaths\.proxyCredential/);
  assert.match(source, /new ProxyAccessCoordinator\(\{[\s\S]*store: externalProxyCredentialStore,[\s\S]*sidecarFile: PROXY_HELPER_CREDENTIAL/u);
  assert.match(source, /hasStableProxyCredential: \(\) => proxyAccess\.hasStable\(\), proxyCredentialFile: PROXY_CREDENTIAL/u);
  assert.doesNotMatch(source, /let activeProxyCredential|let stableProxyCredential/u);
  assert.match(connectOnce, /proxyCredential = this\.generationProxyCredential\(Number\(s\.port\)\);\s*proxyCredentialMode = 'required'/);
  assert.match(connectOnce, /this\.hasStableProxyCredential\(\) \|\| this\.fileSystem\.existsSync\(this\.proxyCredentialFile\)[\s\S]*proxyCredentialMode = 'optional'/);
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
  const reconnectStart = source.indexOf('\nasync function reconnect(', disconnectStart);
  assert.ok(reconnectStart > disconnectStart, 'the disconnect contract must have an exact source boundary');
  assert.match(source.slice(disconnectStart, reconnectStart), /connectionOperations\.disconnect\(\)/);
  const disconnect = operations.slice(operations.indexOf('  async disconnect('), operations.indexOf('  async reconnect('));
  assert.match(disconnect, /this\.removeSidecar\(\)/);
  const exitStart = source.indexOf('function handleEngineExitBoundary');
  const exitEnd = source.indexOf('\nasync function connectOnce(', exitStart);
  assert.match(source.slice(exitStart, exitEnd), /engineTermination\.exit\(\.\.\.args\)/);
  assert.match(source, /removeSidecar: removeExternalProxySidecar/u);
  const termination = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-connection-runtime'), 'utf8');
  assert.match(termination.slice(termination.indexOf('  exit({ generation }')), /this\.removeSidecar\(\)/);
  assert.match(source, /proxyAccess\.disposeForQuit\(\)/u);
  assert.match(proxyOwner, /disposeForQuit\(\) \{[\s\S]*this\.removeSidecar\(\);[\s\S]*this\.#stable\?\.destroy\(\)/u);
});

test('Profile switch revokes in-memory and sidecar access before the next Account activates', () => {
  assert.match(source, /function revokeExternalProxyAccess\(\) \{ return proxyAccess\.revoke\(\); \}/u);
  assert.match(proxyOwner, /revoke\(\) \{[\s\S]*this\.clearActive\(\);[\s\S]*this\.removeSidecar\(\);[\s\S]*this\.#stable\?\.destroy\(\)/u);
  assert.match(source, /revokeProxyAccess: revokeExternalProxyAccess/u);
});
