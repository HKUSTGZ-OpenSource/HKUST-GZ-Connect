'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
const runtime = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'lib', 'connection', 'engine', 'engine-connection-runtime.js'),
  'utf8',
);

test('main consumes generation-bound stopped reasons at process close', () => {
  assert.match(source, /new EngineConnectionRuntime\(\{/);
  assert.match(runtime, /new EngineProtocolSession\(generation\)/);
  assert.match(runtime, /this\.protocol\.accept\(event\)/);
  assert.match(source, /engineRuntime\?\.stoppedReason \|\| null/);
  assert.match(source, /engineRuntime\?\.dispose\(\)/);
  assert.match(source, /resolveEngineFailureKind\(\{[\s\S]*stopReason: structuredStopReason/);
  assert.match(source, /classifyEngineStopReason\(structuredStopReason, stoppedSocksPort, t\)/);
  assert.match(source, /onDiagnostic: \(event\) => logWriter\.append\(formatEngineEventDiagnostic\(event,/);
});

test('desktop requires Engine API hello and has no English stdout readiness fallback', () => {
  assert.match(runtime, /ENGINE_HELLO_TIMEOUT_MS/);
  assert.match(runtime, /this\.protocol\.helloSeen/);
  assert.match(runtime, /onProtocolTimeout/);
  assert.match(source, /structuredFatalCode = 'EVENT_OUTPUT_FAILED'/);
  assert.doesNotMatch(`${source}\n${runtime}`, /legacyFallback|legacyStdoutTail/);
  assert.doesNotMatch(`${source}\n${runtime}`, /SOCKS5 server listening|Client IP assigned/);
  assert.match(source, /child\.stderr\.on\('data'[\s\S]*applyHumanDiagnostic\(chunk\)/);
});

test('desktop opts into the private Control v2 stream and retains signal fallback', () => {
  assert.match(source, /controlRegistry: engineControlRegistry/);
  assert.match(runtime, /controlRegistry\.bind\(generation, stdin, contextToken\)/);
  assert.match(source, /contextToken: engineContextToken/u);
  assert.match(runtime, /this\.control\.feed\(data\)/);
  assert.match(source, /'--control-api-v2-stdin'/);
  assert.match(source, /'--profile-binding-v1-stdin'/);
  assert.match(source, /child\.stdin\.write\([\s\S]*engineConfigBinding\.stdinFrame/u);
  assert.doesNotMatch(source, /child\.stdin\.end\(/);
  const credentials = source.indexOf('${engineConfigBinding.stdinFrame}\\n${username}\\n${pw}');
  const runtimeStart = source.indexOf('engineRuntime.start(child.stdout)');
  assert.ok(credentials > 0 && runtimeStart > credentials,
    'runtime/handshake starts only after the credential prefix');
  assert.match(runtime, /this\.control\.handshake\(\)/);
  assert.match(runtime, /this\.control\.providerCapabilities\(\)/);
  assert.match(source, /activeSchoolProfile\.observeCapabilityReport\(report\)/u);
  assert.doesNotMatch(source, /capabilitySnapshot:\s*activeSchoolProfile\.capabilitySnapshot\(\)/u);
  assert.match(source, /requestGracefulStop: requestActiveEngineControlShutdown/);
});
