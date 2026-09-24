'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  exactLockQueries,
  npmAuditReport,
  packageNameFromLockPath,
  queryOsv,
  validateOsvResults,
} = require('../../../../.github/scripts/check-dependency-vulnerabilities');

test('lockfile audit includes nested and scoped packages exactly once', () => {
  assert.equal(packageNameFromLockPath('node_modules/a/node_modules/@scope/pkg'), '@scope/pkg');
  assert.equal(packageNameFromLockPath('packages/app'), '');
  const queries = exactLockQueries({
    lockfileVersion: 3,
    packages: {
      '': { version: '2.0.0' },
      'node_modules/a': { version: '1.0.0' },
      'node_modules/a/node_modules/@scope/pkg': { version: '2.0.0' },
      'node_modules/b/node_modules/a': { version: '1.0.0' },
      'node_modules/link': { version: '1.0.0', link: true },
    },
  });
  assert.deepEqual(queries, [
    { package: { ecosystem: 'npm', name: '@scope/pkg' }, version: '2.0.0' },
    { package: { ecosystem: 'npm', name: 'a' }, version: '1.0.0' },
  ]);
});

test('a structured npm vulnerability report never falls through to a network fallback', () => {
  const clean = npmAuditReport(JSON.stringify({ metadata: { vulnerabilities: {
    info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0,
  } } }), 0);
  assert.equal(clean.kind, 'report');
  assert.equal(clean.passed, true);

  const vulnerable = npmAuditReport(JSON.stringify({ metadata: { vulnerabilities: {
    info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1,
  } } }), 1);
  assert.equal(vulnerable.kind, 'report');
  assert.equal(vulnerable.passed, false);
  assert.equal(npmAuditReport('{"error":"network timeout"}', 1).kind, 'unavailable');
});

test('OSV fallback is exact-length and fails on every reported advisory', async () => {
  const queries = exactLockQueries({
    lockfileVersion: 3,
    packages: { 'node_modules/a': { version: '1.0.0' } },
  });
  assert.throws(() => validateOsvResults(queries, { results: [] }), /exact lockfile query/);
  const findings = await queryOsv(queries, {
    attempts: 1,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ results: [{ vulns: [{ id: 'GHSA-test-1234' }] }] }),
    }),
  });
  assert.deepEqual(findings, [{ id: 'GHSA-test-1234', name: 'a', version: '1.0.0' }]);
});
