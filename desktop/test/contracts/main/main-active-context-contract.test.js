'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const attempt = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-process'), 'utf8');
const statusOwner = fs.readFileSync(require.resolve('../../../lib/connection/state/connection-recovery-presentation'), 'utf8');
const operationOwner = fs.readFileSync(require.resolve('../../../lib/connection/state/connection-state-machine'), 'utf8');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}

test('Main creates one Profile-bound lease before persistence and connection services', () => {
  const profile = source.indexOf('const activeSchoolProfile = createPreReadySchoolProfileController(');
  const lease = source.indexOf(
    'new ActiveContextLease(activeSchoolProfile.activeContextBinding())',
  );
  const storage = source.indexOf('const preReadyStorage =');
  assert.ok(profile >= 0 && lease > profile && storage > lease);
});

test('Engine callbacks require context epoch connection intent and process generation', () => {
  const connect = attempt;
  assert.match(source, /engineAttempts\.run\(isRetry, intent\)/u);
  assert.match(source, /contextLease: \{ capture: options => activeContextLease\.capture\(options\) \}/u);
  assert.match(source, /activeEngineContextCurrent = \(generation, token\) => connectionOperations\.isCurrentEngineContext\(generation, token\)/u);
  assert.match(source, /contextLease: activeContextLease, connectivityRecovery, loadSettingsOrReport/u);
  assert.match(operationOwner, /this\.engineSupervisor\.isCurrent\(generation\) && this\.contextLease\.isCurrent\(token, \{\s*connectionIntent: this\.connectionState\.snapshot\(\)\.intent, engineGeneration: generation/u);
  assert.doesNotMatch(source, /activeContextLease\.isCurrent\(token|engineSupervisor\.isCurrent\(generation\)/u);
  assert.match(connect, /activeEngineContextCurrent\(generation, engineContextToken\)/u);
  const capture = connect.indexOf('this.contextLease.capture({ connectionIntent: intent, engineGeneration })');
  const bind = connect.indexOf('connectionState.bindEngineGeneration(engineGeneration)');
  const runtime = connect.indexOf('new EngineConnectionRuntime({');
  assert.ok(bind >= 0 && capture > bind && runtime > capture);
  assert.match(connect, /isCurrent: isCurrentEngineContext/u);
  const serving = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-connection-runtime'), 'utf8');
  assert.match(serving, /if \(!this\.isCurrent\(this\.generation\)/u);
  assert.match(connect, /new EngineServingCoordinator\(\{[\s\S]*getGeneration: \(\) => engineGeneration/u);
  assert.match(connect, /handleEngineExitBoundary\(result, isCurrentEngineContext\)/u);
  assert.match(connect, /Number\(s\.port\), isCurrentEngineContext,/u);
  assert.match(connect, /revokeEngineServing\(engineGeneration, isCurrentEngineContext\)/u);
  assert.match(connect, /this\.onFirstConnected\(engineGeneration, engineContextToken\)/u);
  assert.match(source, /onFirstConnected: \(generation, token\) => connectionStatus\.firstConnected\(generation, token\)/u);
  assert.match(statusOwner, /this\.#effects\.getTelemetry\(\)\.start\(generation, token\)/u);
  assert.match(source, /isEngineCurrent: \(generation, token\) => activeEngineContextCurrent\(generation, token\)/u);
  assert.match(source, /onRecovering: \(generation, token\) => connectionStatus\.reportRecovering\(generation, token\)/u);
  assert.match(statusOwner, /if \(!this\.#effects\.isEngineCurrent\(generation, token\)\) return;/u);
  assert.match(source, /isEngineCurrent: activeEngineContextCurrent/u);
  assert.match(source, /reconnect: \(generation, token\) => connectionOperations\.reconnectCurrentEngineContext\(generation, token\)/u);
  assert.doesNotMatch(connect, /activeContextEpoch:\s*1/u);
});

test('all serialized settings routing and resource mutations capture active context', () => {
  assert.match(source, /new RoutingPolicyTransactionQueue\(\{ isContextCurrent: \(token\) => activeContextLease\.isContextCurrent\(token\) \}\)/u);
  assert.match(source, /routingPolicyTransactions\.run\(activeContextLease\.captureContext\(\), options\)/u);
  assert.match(source, /runTransaction: runActiveContextTransaction, encodePac: pacDataUrl/u);
  assert.match(source, /function runDomainPolicyTransaction[\s\S]*return routingPolicyCoordinator\.run/u);
  assert.match(source, /runSerialTransaction: runActiveContextTransaction/u);
  const directRuns = source.match(/routingPolicyTransactions\.run\(/gu) || [];
  assert.equal(directRuns.length, 1, 'every mutation must pass through the context-token helper');
});

test('Main injects Routing coordination without owning PAC publication or rule rollback', () => {
  assert.match(source, /new RoutingPolicyCoordinator\(\{/u);
  assert.match(source, /canResumeBrowser: \(\) => connectionOperations\.canResumeBrowser\(\)/u);
  assert.match(operationOwner, /return this\.connectionState\.isConnected\(\) && this\.engineSupervisor\.hasActive/u);
  assert.match(source, /browserRoutingPolicy = routingPolicyCoordinator\.browserPolicy/u);
  assert.doesNotMatch(source, /require\('\.\/lib\/routing\/pac\/pac-file'\)/u);
  assert.doesNotMatch(source, /\bsavePacFile\(|\bcurrentPacUrl\b|function browserPolicyProxyConfig/u);
});

test('Main delegates initial offline intent choreography without cancelling its startup owner', () => {
  assert.match(source, /pauseOffline: \(\) => connectionOperations\.pauseInitialOffline\(\)/u);
  assert.doesNotMatch(source, /connectionState\.beginConnectIntent\(|connectivityRecovery\.networkOffline\(intent\)/u);
  const pause = operationOwner.slice(operationOwner.indexOf('  pauseInitialOffline() {'), operationOwner.indexOf('  currentRecoveryIntent() {'));
  assert.match(pause, /this\.connectivityRecovery\.cancel\(\)/u);
  assert.match(pause, /this\.connectionState\.beginConnectIntent\(\)/u);
  assert.match(pause, /this\.connectivityRecovery\.networkOffline\(intent\) \? intent : null/u);
  assert.doesNotMatch(pause, /this\.cancelRecovery\(/u);
});

test('Main delegates settings snapshot and close-action transaction to Persistence', () => {
  assert.match(source, /function routingSettings\(\) \{ return persistenceRuntime\.routingSettings\(\); \}/u);
  assert.match(source, /function saveSettings\(settings\) \{ return persistenceRuntime\.saveSettingsWithGuard\(settings\); \}/u);
  assert.match(source, /function rememberCloseAction\(action\) \{ return persistenceRuntime\.rememberCloseAction\(action, runActiveContextTransaction\); \}/u);
  assert.doesNotMatch(source, /routingSettingsSnapshot|const next = \{ \.\.\.previous, closeAction: action \}/u);
});
