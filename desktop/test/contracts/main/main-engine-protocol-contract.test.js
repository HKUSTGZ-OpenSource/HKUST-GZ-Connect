'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const attempt = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-process'), 'utf8');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
const runtime = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'lib', 'connection', 'engine', 'engine-connection-runtime.js'),
  'utf8',
);

test('main consumes generation-bound stopped reasons at process close', () => {
  assert.match(attempt, /new EngineConnectionRuntime\(\{/);
  assert.match(runtime, /new EngineProtocolSession\(generation\)/);
  assert.match(runtime, /this\.protocol\.accept\(event\)/);
  assert.match(attempt, /engineRuntime\?\.stoppedReason \|\| null/);
  assert.match(attempt, /engineRuntime\?\.dispose\(\)/);
  assert.match(source, /engineTermination\.close\(\.\.\.args\)/u);
  assert.match(runtime, /resolveEngineFailureKind\(\{[\s\S]*stopReason: structuredStopReason/);
  assert.match(runtime, /classifyEngineStopReason\(structuredStopReason, stoppedSocksPort, this\.t\)/);
  assert.match(attempt, /appendDiagnostic: chunk => this\.logWriter\.append\(chunk\)/);
  assert.match(runtime, /onDiagnostic: \(event\) => this\.appendDiagnostic\(formatEngineEventDiagnostic\(event,/);
});

test('desktop requires Engine API hello and has no English stdout readiness fallback', () => {
  assert.match(runtime, /ENGINE_HELLO_TIMEOUT_MS/);
  assert.match(runtime, /this\.protocol\.helloSeen/);
  assert.match(runtime, /onProtocolTimeout/);
  assert.match(attempt, /serving\.fatalCode = 'EVENT_OUTPUT_FAILED'/);
  assert.doesNotMatch(`${source}\n${attempt}\n${runtime}`, /legacyFallback|legacyStdoutTail/);
  assert.doesNotMatch(`${source}\n${attempt}\n${runtime}`, /SOCKS5 server listening|Client IP assigned/);
  assert.match(attempt, /child\.stderr\.on\('data'[\s\S]*applyHumanDiagnostic\(chunk\)/);
});

test('desktop opts into the private Control v2 stream and retains signal fallback', () => {
  assert.match(source, /controlRegistry: engineControlRegistry/);
  assert.match(runtime, /controlRegistry\.bind\(generation, stdin, contextToken\)/);
  assert.match(attempt, /contextToken: engineContextToken/u);
  assert.match(runtime, /this\.control\.feed\(data\)/);
  assert.match(attempt, /'--control-api-v2-stdin'/);
  assert.match(attempt, /'--profile-binding-v1-stdin'/);
  assert.match(attempt, /child\.stdin\.write\([\s\S]*engineConfigBinding\.stdinFrame/u);
  assert.doesNotMatch(attempt, /child\.stdin\.end\(/);
  const credentials = attempt.indexOf('${engineConfigBinding.stdinFrame}\\n${username}\\n${pw}');
  const runtimeStart = attempt.indexOf('engineRuntime.start(child.stdout)');
  assert.ok(credentials > 0 && runtimeStart > credentials,
    'runtime/handshake starts only after the credential prefix');
  assert.match(runtime, /this\.control\.handshake\(\)/);
  assert.match(runtime, /this\.control\.providerCapabilities\(\)/);
  assert.match(source, /activeSchoolProfile\.observeCapabilityReport\(report\)/u);
  assert.doesNotMatch(source, /capabilitySnapshot:\s*activeSchoolProfile\.capabilitySnapshot\(\)/u);
  assert.match(source, /requestGracefulStop: requestActiveEngineControlShutdown/);
});
