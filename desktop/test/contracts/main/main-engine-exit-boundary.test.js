'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const attempt = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-process'), 'utf8');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
const servingSource = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-connection-runtime'), 'utf8');
const termination = servingSource.slice(servingSource.indexOf('class EngineTerminationCoordinator'));
const operations = fs.readFileSync(require.resolve('../../../lib/connection/state/connection-state-machine'), 'utf8');

test('engine exit closes the browser request boundary before stdio close cleanup', () => {
  assert.match(source, /engineTermination\.exit\(\.\.\.args\)/u);
  assert.match(source, /const engineTermination = engineApplication\.createTermination\(/u);
  assert.match(attempt, /isGenerationCurrent: generation => supervisor\.isCurrent\(generation\)/u);
  assert.match(source, /clearCredential: clearActiveProxyCredential, removeSidecar: removeExternalProxySidecar/u);
  assert.match(source, /suspendBrowser: suspendOpenBrowserPolicy, clearPresentation: clearConnectionPresentation/u);
  assert.match(termination, /this\.isGenerationCurrent\(generation\)/);
  assert.match(termination, /isCurrentContext\(generation\)/);
  assert.match(termination, /this\.connectionState\.markEngineStopping\(generation, \{ uptimeMs \}\)/);
  assert.match(termination, /this\.clearCredential\(generation\)/);
  assert.match(termination, /this\.suspendBrowser\(\)/);

  const startCall = attempt.slice(attempt.indexOf('const started = this.engineSupervisor.start({'));
  assert.match(source, /engineAttempts\.run\(isRetry, intent\)/u);
  assert.match(startCall, /onExit:\s*\(result\) => \{\s*engineRuntime\?\.beginExitDrain\(\);\s*this\.handleEngineExitBoundary\(result, isCurrentEngineContext\);\s*\},\s*onClose:/);
  assert.match(startCall, /const structuredStopReason = engineRuntime\?\.stoppedReason \|\| null;\s*engineRuntime\?\.dispose\(\)/);
});

test('fatal, stopping, and exit boundaries revoke in-flight serving promotion', () => {
  const revoke = termination.slice(termination.indexOf('  revokeServing('), termination.indexOf('  exit('));
  assert.match(source, /engineTermination\.revokeServing\(\.\.\.args\)/u);
  assert.match(revoke, /this\.connectionState\.markEngineStopping\(generation, \{ uptimeMs \}\)/);
  assert.match(revoke, /this\.suspendBrowser\(\)/);
  assert.match(revoke, /this\.clearPresentation\(\)/);

  assert.match(attempt, /handlers: serving\.handlers/u);
  assert.match(attempt, /revokeServing: \(\) => this\.revokeEngineServing\(engineGeneration, isCurrentEngineContext\)/u);
  assert.match(attempt, /stopEngine: \(\) => this\.engineSupervisor\.stop\(\{ graceMs: 1000, forceWaitMs: STOP_FORCE_WAIT_MS \}\)/u);
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
  assert.match(source, /cleanupProxyAccess: DesktopPersistenceRuntime\.cleanupProxyAccessForEngineClose/u);
  assert.match(close, /this\.cleanupProxyAccess\(\{[\s\S]*generation,[\s\S]*supervisorGenerationCurrent,[\s\S]*connectionGenerationCurrent: this\.connectionState\.isCurrentGeneration\(generation\),[\s\S]*clearCredential: this\.clearCredential,[\s\S]*removeSidecar: this\.removeSidecar/);
  assert.match(close, /\}\)\) return;/);
});

test('physical network recovery requires local closure while explicit reconnect retains the cleanup gate', () => {
  const recovery = operations.slice(
    operations.indexOf('  async recoverConnectivity('),
    operations.indexOf('  onConnectivityRecoveryDeclined('),
  );
  assert.match(recovery, /!stopped\.ok/);
  assert.match(recovery, /this\.connectionState\.failIntent\(intent\)/);
  assert.match(recovery, /error\.engineStuck/);
  assert.match(source, /reconnect: \(intent, reason\) => connectionOperations\.recoverConnectivity\(intent, reason\)/u,
    'Main delegates connectivity restart admission to the existing operation owner');

  assert.match(source, /connectionOperations\.reconnect\(expectedGeneration\)/u);
  const reconnect = operations.slice(operations.indexOf('  async reconnect('));
  assert.match(reconnect, /stopResult\.cleanExit === false/);
  assert.match(reconnect, /connectionState\.failIntent\(intent\)/);
  assert.match(reconnect, /error\.engineCleanupUnconfirmed/);
});

test('orphan cleanup and Windows owner recording are mandatory start boundaries', () => {
  const connect = attempt;
  assert.match(source, /engineOwnerFile: ENGINE_OWNER/u);
  assert.match(attempt, /writeOwnerRecord: writeEngineOwnerRecord/u);
  assert.match(connect,
    /killStrayEngines\(resolvedBin\) !== true[\s\S]*cleanupUnconfirmed: true/u,
    'an unconfirmed orphan cleanup must stop before spawning a replacement Engine');
  assert.match(connect,
    /this\.writeOwnerRecord\(this\.engineOwnerFile, ownedEngine\);[\s\S]*catch \{[\s\S]*engineSupervisor\.stop/u,
    'a Windows Engine without a durable owner record must be stopped immediately');
});
