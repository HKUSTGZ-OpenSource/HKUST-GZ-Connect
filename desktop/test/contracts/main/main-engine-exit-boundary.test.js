'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
const servingSource = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-connection-runtime'), 'utf8');
const termination = servingSource.slice(servingSource.indexOf('class EngineTerminationCoordinator'));

test('engine exit closes the browser request boundary before stdio close cleanup', () => {
  assert.match(source, /engineTermination\.exit\(\.\.\.args\)/u);
  assert.match(source, /isGenerationCurrent: generation => engineSupervisor\.isCurrent\(generation\)/u);
  assert.match(source, /clearCredential: clearActiveProxyCredential, removeSidecar: removeExternalProxySidecar/u);
  assert.match(source, /suspendBrowser: suspendOpenBrowserPolicy, clearPresentation: clearConnectionPresentation/u);
  assert.match(termination, /this\.isGenerationCurrent\(generation\)/);
  assert.match(termination, /isCurrentContext\(generation\)/);
  assert.match(termination, /this\.connectionState\.markEngineStopping\(generation, \{ uptimeMs \}\)/);
  assert.match(termination, /this\.clearCredential\(generation\)/);
  assert.match(termination, /this\.suspendBrowser\(\)/);

  const startCall = source.slice(source.indexOf('const started = engineSupervisor.start({'));
  assert.match(startCall, /onExit:\s*\(result\) => \{\s*engineRuntime\?\.beginExitDrain\(\);\s*handleEngineExitBoundary\(result, isCurrentEngineContext\);\s*\},\s*onClose:/);
  assert.match(startCall, /const structuredStopReason = engineRuntime\?\.stoppedReason \|\| null;\s*engineRuntime\?\.dispose\(\)/);
});

test('fatal, stopping, and exit boundaries revoke in-flight serving promotion', () => {
  const revoke = termination.slice(termination.indexOf('  revokeServing('), termination.indexOf('  exit('));
  assert.match(source, /engineTermination\.revokeServing\(\.\.\.args\)/u);
  assert.match(revoke, /this\.connectionState\.markEngineStopping\(generation, \{ uptimeMs \}\)/);
  assert.match(revoke, /this\.suspendBrowser\(\)/);
  assert.match(revoke, /this\.clearPresentation\(\)/);

  assert.match(source, /handlers: serving\.handlers/u);
  assert.match(source, /revokeServing: \(\) => revokeEngineServing\(engineGeneration, isCurrentEngineContext\)/u);
  assert.match(source, /stopEngine: \(\) => engineSupervisor\.stop\(\{ graceMs: 1000, forceWaitMs: STOP_FORCE_WAIT_MS \}\)/u);
  const handlers = servingSource.slice(servingSource.indexOf('class EngineServingCoordinator'));
  assert.match(handlers, /onStopping:.*this\.revokeServing\(\)/);
  assert.match(handlers, /onListenerMismatch:[\s\S]*?this\.revokeServing\(\)[\s\S]*?this\.stopEngine\(\)/);
  assert.match(handlers, /onFatalError:[\s\S]*?this\.revokeServing\(\)/);
  assert.match(handlers, /onProtocolTimeout:[\s\S]*?this\.revokeServing\(\)/);
  assert.match(source, /engineTermination\.close\(\.\.\.args\)/u);
  const close = termination.slice(termination.indexOf('  close('), termination.indexOf('  revokeServing('));
  assert.match(close, /closeSnapshot\.wasConnectedBeforeStop/);
  assert.match(close, /closeSnapshot\.connectedUptimeBeforeStop/);
  assert.match(close, /this\.isGenerationCurrent\(generation\) && isCurrentContext\(generation\)/);
  assert.match(source, /cleanupProxyAccess: cleanupProxyAccessForEngineClose/u);
  assert.match(close, /this\.cleanupProxyAccess\(\{[\s\S]*generation,[\s\S]*supervisorGenerationCurrent,[\s\S]*connectionGenerationCurrent: this\.connectionState\.isCurrentGeneration\(generation\),[\s\S]*clearCredential: this\.clearCredential,[\s\S]*removeSidecar: this\.removeSidecar/);
  assert.match(close, /\}\)\) return;/);
});

test('an unclean stop releases the local process but blocks automatic reconnect', () => {
  const recoveryStart = source.indexOf('async function recoverConnectivity(');
  const connectStart = source.indexOf('\nasync function connect(', recoveryStart);
  const recovery = source.slice(recoveryStart, connectStart);
  assert.match(recovery, /stopped\.cleanExit === false/);
  assert.match(recovery, /connectionState\.failIntent\(intent\)/);
  assert.match(recovery, /error\.engineCleanupUnconfirmed/);

  const reconnectStart = source.indexOf('async function reconnect(');
  const pacStart = source.indexOf('// ---------- PAC file', reconnectStart);
  const reconnect = source.slice(reconnectStart, pacStart);
  assert.match(reconnect, /stopResult\.cleanExit === false/);
  assert.match(reconnect, /connectionState\.failIntent\(intent\)/);
  assert.match(reconnect, /error\.engineCleanupUnconfirmed/);
});

test('orphan cleanup and Windows owner recording are mandatory start boundaries', () => {
  const connect = source.slice(source.indexOf('async function connectOnce('));
  assert.match(connect,
    /killStrayEngines\(resolvedBin\) !== true[\s\S]*cleanupUnconfirmed: true/u,
    'an unconfirmed orphan cleanup must stop before spawning a replacement Engine');
  assert.match(connect,
    /writeEngineOwnerRecord\(ENGINE_OWNER, ownedEngine\);[\s\S]*catch \{[\s\S]*engineSupervisor\.stop/u,
    'a Windows Engine without a durable owner record must be stopped immediately');
});
