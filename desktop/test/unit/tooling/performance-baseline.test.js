'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PERFORMANCE_REPORT_PREFIX,
  PERFORMANCE_REPORT_SCHEMA,
  performanceReportLine,
} = require('../../../scripts/performance-report');
const {
  HARD_TIMEOUT_MS,
  buildIdlePerformanceReport,
  measureHiddenTelemetryIdle,
  observeIdleProcessCpu,
} = require('../../../scripts/idle-performance-baseline');
const { validateTemporaryProfile } = require('../../../scripts/temp-profile-cleanup');
const os = require('node:os');
const path = require('node:path');

test('idle Electron baseline has a release-gate-sized hard timeout', () => {
  assert.ok(HARD_TIMEOUT_MS > 0);
  assert.ok(HARD_TIMEOUT_MS <= 30_000);
});

test('hidden idle baseline has no application enumeration and one bounded timer', async () => {
  const result = await measureHiddenTelemetryIdle({ simulatedIdleMs: 60_000 });
  assert.deepEqual(result, {
    simulatedIdleMs: 60_000,
    // Detached health completion emits its updated status without delaying the
    // seven normal telemetry pumps.
    pumpRuns: 10,
    applicationEnumerationCalls: 0,
    latencySamples: 3,
    healthSamples: 3,
    scheduledTimers: 7,
    minimumTimerMs: 10_000,
    maximumTimerMs: 10_000,
    pendingTimersBeforeStop: 1,
    pendingTimersAfterStop: 0,
  });
});

test('CPU observation is reported as a non-enforced product target', async () => {
  let clock = 1_000_000_000n;
  let firstCpuCall = true;
  const result = await observeIdleProcessCpu({
    durationMs: 250,
    delay: async () => { clock += 250_000_000n; },
    monotonicNow: () => clock,
    cpuUsage: () => {
      if (firstCpuCall) {
        firstCpuCall = false;
        return { user: 10_000, system: 5_000 };
      }
      return { user: 2_000, system: 1_000 };
    },
  });
  assert.deepEqual(result, {
    observationMs: 250,
    cpuMs: 3,
    cpuMsPerWallSecond: 12,
    productTargetMsPerSecond: 25,
    productTargetMet: true,
    enforced: false,
  });
});

test('performance reports are one bounded parseable JSON line', async () => {
  let clock = 0n;
  const report = await buildIdlePerformanceReport({
    simulatedIdleMs: 10_000,
    durationMs: 1,
    delay: async () => { clock += 1_000_000n; },
    monotonicNow: () => clock,
    cpuUsage: (() => {
      let first = true;
      return () => {
        if (first) { first = false; return { user: 0, system: 0 }; }
        return { user: 0, system: 0 };
      };
    })(),
  });
  const line = performanceReportLine(report);
  assert.equal(line.split('\n').length, 1);
  assert.ok(Buffer.byteLength(line) < 16 * 1024);
  assert.equal(
    JSON.parse(line.slice(PERFORMANCE_REPORT_PREFIX.length)).schema,
    PERFORMANCE_REPORT_SCHEMA,
  );
  assert.equal(report.scope.network, 'none');
  assert.equal(report.cpuObservation.enforced, false);
});

test('oversized or wrong-schema performance output fails closed', () => {
  assert.throws(
    () => performanceReportLine({ schema: 'future', kind: 'test' }),
    /schema/,
  );
  assert.throws(
    () => performanceReportLine({
      schema: PERFORMANCE_REPORT_SCHEMA,
      value: 'x'.repeat(100),
    }, { maxBytes: 64 }),
    /bounded/,
  );
});

test('post-Electron cleanup accepts only its named direct temporary profile', () => {
  const expected = path.join(os.tmpdir(), 'hkustgz-idle-baseline-fixture');
  assert.equal(
    validateTemporaryProfile(expected, 'hkustgz-idle-baseline'),
    path.resolve(expected),
  );
  assert.throws(
    () => validateTemporaryProfile(path.join(os.tmpdir(), 'other-fixture'), 'hkustgz-idle-baseline'),
    /outside/,
  );
  assert.throws(
    () => validateTemporaryProfile(path.join(os.tmpdir(), 'nested', 'hkustgz-idle-baseline-x'),
      'hkustgz-idle-baseline'),
    /outside/,
  );
});
