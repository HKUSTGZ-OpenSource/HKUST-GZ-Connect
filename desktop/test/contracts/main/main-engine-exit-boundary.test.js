'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
const servingSource = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-connection-runtime'), 'utf8');

test('engine exit closes the browser request boundary before stdio close cleanup', () => {
  const boundaryStart = source.indexOf('function revokeEngineServing(');
  const connectStart = source.indexOf('async function connectOnce(');
  assert.ok(boundaryStart >= 0 && connectStart > boundaryStart);
  const boundary = source.slice(boundaryStart, connectStart);
  assert.match(boundary, /engineSupervisor\.isCurrent\(generation\)/);
  assert.match(boundary, /isCurrentContext\(generation\)/);
  assert.match(boundary, /connectionState\.markEngineStopping\(generation, \{ uptimeMs \}\)/);
  assert.match(boundary, /clearActiveProxyCredential\(generation\)/);
  assert.match(boundary, /suspendOpenBrowserPolicy\(\)/);

  const startCall = source.slice(source.indexOf('const started = engineSupervisor.start({'));
  assert.match(startCall, /onExit:\s*\(result\) => \{\s*engineRuntime\?\.beginExitDrain\(\);\s*handleEngineExitBoundary\(result, isCurrentEngineContext\);\s*\},\s*onClose:/);
  assert.match(startCall, /const structuredStopReason = engineRuntime\?\.stoppedReason \|\| null;\s*engineRuntime\?\.dispose\(\)/);
});

test('fatal, stopping, and exit boundaries revoke in-flight serving promotion', () => {
  const revokeStart = source.indexOf('function revokeEngineServing(');
  const exitStart = source.indexOf('function handleEngineExitBoundary(', revokeStart);
  assert.ok(revokeStart >= 0 && exitStart > revokeStart);
  const revoke = source.slice(revokeStart, exitStart);
  assert.match(revoke, /connectionState\.markEngineStopping\(generation, \{ uptimeMs \}\)/);
  assert.match(revoke, /suspendOpenBrowserPolicy\(\)/);
  assert.match(revoke, /clearConnectionPresentation\(\)/);

  assert.match(source, /handlers: serving\.handlers/u);
  assert.match(source, /revokeServing: \(\) => revokeEngineServing\(engineGeneration, isCurrentEngineContext\)/u);
  assert.match(source, /stopEngine: \(\) => engineSupervisor\.stop\(\{ graceMs: 1000, forceWaitMs: STOP_FORCE_WAIT_MS \}\)/u);
  const handlers = servingSource.slice(servingSource.indexOf('class EngineServingCoordinator'));
  assert.match(handlers, /onStopping:.*this\.revokeServing\(\)/);
  assert.match(handlers, /onListenerMismatch:[\s\S]*?this\.revokeServing\(\)[\s\S]*?this\.stopEngine\(\)/);
  assert.match(handlers, /onFatalError:[\s\S]*?this\.revokeServing\(\)/);
  assert.match(handlers, /onProtocolTimeout:[\s\S]*?this\.revokeServing\(\)/);
  const close = source.slice(source.indexOf('function handleEngineClose('), revokeStart);
  assert.match(close, /closeSnapshot\.wasConnectedBeforeStop/);
  assert.match(close, /closeSnapshot\.connectedUptimeBeforeStop/);
  assert.match(close, /engineSupervisor\.isCurrent\(generation\) && isCurrentContext\(generation\)/);
  assert.match(close, /cleanupProxyAccessForEngineClose\(\{[\s\S]*generation,[\s\S]*supervisorGenerationCurrent,[\s\S]*connectionGenerationCurrent: connectionState\.isCurrentGeneration\(generation\),[\s\S]*clearCredential: clearActiveProxyCredential,[\s\S]*removeSidecar: removeExternalProxySidecar/);
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
