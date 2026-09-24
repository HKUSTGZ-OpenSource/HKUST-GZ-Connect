'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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
  const connect = section('async function connectOnce(', '\nfunction ensureEngineStopped()');
  assert.match(source, /activeContextLease\.isCurrent\(token, \{ connectionIntent: connectionState\.snapshot\(\)\.intent, engineGeneration: generation \}\)/u);
  assert.match(connect, /activeEngineContextCurrent\(generation, engineContextToken\)/u);
  const capture = connect.indexOf('activeContextLease.capture({ connectionIntent: intent, engineGeneration })');
  const bind = connect.indexOf('connectionState.bindEngineGeneration(engineGeneration)');
  const runtime = connect.indexOf('new EngineConnectionRuntime({');
  assert.ok(capture > bind && runtime > capture);
  assert.match(connect, /isCurrent: isCurrentEngineContext/u);
  assert.match(connect, /if \(!isCurrentEngineContext\(engineGeneration\)/u);
  assert.match(connect, /handleEngineExitBoundary\(result, isCurrentEngineContext\)/u);
  assert.match(connect, /Number\(s\.port\), isCurrentEngineContext,/u);
  assert.match(connect, /revokeEngineServing\(engineGeneration, isCurrentEngineContext\)/u);
  assert.match(connect, /telemetryCoordinator\.start\(engineGeneration, engineContextToken\)/u);
  assert.match(source, /isEngineCurrent: activeEngineContextCurrent/u);
  assert.match(source, /reconnect: \(generation, token\) => activeEngineContextCurrent\(generation, token\)/u);
  assert.doesNotMatch(connect, /activeContextEpoch:\s*1/u);
});

test('all serialized settings routing and resource mutations capture active context', () => {
  assert.match(source, /new RoutingPolicyTransactionQueue\(\{ isContextCurrent: \(token\) => activeContextLease\.isContextCurrent\(token\) \}\)/u);
  assert.match(source, /routingPolicyTransactions\.run\(activeContextLease\.captureContext\(\), options\)/u);
  assert.match(source, /function runDomainPolicyTransaction[\s\S]*return runActiveContextTransaction/u);
  assert.match(source, /runSerialTransaction: runActiveContextTransaction/u);
  const directRuns = source.match(/routingPolicyTransactions\.run\(/gu) || [];
  assert.equal(directRuns.length, 1, 'every mutation must pass through the context-token helper');
});
