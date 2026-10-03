'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const attempt = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-process'), 'utf8');

test('connect takes its final settings and credential snapshot after the last pre-spawn await', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
  assert.match(source, /engineAttempts\.run\(isRetry, intent\)/u);
  const functionStart = attempt.indexOf('  async run(');
  const functionEnd = attempt.indexOf('\n}\n\nmodule.exports', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const connectOnce = attempt.slice(functionStart, functionEnd);

  const logAwait = connectOnce.indexOf('await this.logWriter.reset()');
  const finalSnapshot = connectOnce.indexOf('// FINAL_CONNECTION_SNAPSHOT:');
  const spawn = connectOnce.indexOf('const started = this.engineSupervisor.start(');
  assert.ok(logAwait >= 0 && finalSnapshot > logAwait && spawn > finalSnapshot);

  const snapshotToSpawn = connectOnce.slice(finalSnapshot, spawn);
  assert.match(snapshotToSpawn, /s = this\.loadSettings\(\);/);
  assert.match(snapshotToSpawn,
    /const credentialOwner = this\.openCredential\(this\.profile\.activeContextBinding\(\)\.profileId\)/);
  assert.match(source, /openCredential: profileId => vpnCredentialAccess\.open\(profileId\)/);
  const access = fs.readFileSync(require.resolve('../../../lib/persistence/credentials/credential-store'), 'utf8');
  assert.match(access, /openPersistent: \(\) => this\.persistence\.openCredential\(\)/);
  assert.match(snapshotToSpawn, /credentialOwner\.withStrings\(\(account, password\)/);
  assert.match(snapshotToSpawn, /finally \{ credentialOwner\.destroy\(\); \}/);
  assert.doesNotMatch(snapshotToSpawn, /\bawait\b/);
});

test('the final snapshot is the one passed to engine arguments and credential stdin', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
  assert.match(source, /engineAttempts\.run\(isRetry, intent\)/u);
  const functionStart = attempt.indexOf('  async run(');
  const functionEnd = attempt.indexOf('\n}\n\nmodule.exports', functionStart);
  const connectOnce = attempt.slice(functionStart, functionEnd);
  const finalSnapshot = connectOnce.indexOf('// FINAL_CONNECTION_SNAPSHOT:');
  const finalPath = connectOnce.slice(finalSnapshot);

  assert.match(finalPath, /username\.length > 256 \|\| pw\.length > 4096/);
  assert.match(finalPath, /parseCredentialField\(username/);
  assert.match(finalPath, /parseCredentialField\(pw/);
  assert.match(finalPath, /--socks-bind[^\n]+Number\(s\.port\)/);
  assert.match(finalPath, /s\.strictProxyAuth === true/);
  assert.match(finalPath, /'--control-api-v2-stdin'/);
  assert.match(finalPath, /'--profile-binding-v1-stdin'/);
  assert.match(finalPath, /\$\{engineConfigBinding\.stdinFrame\}\\n\$\{username\}\\n\$\{pw\}\\n/);
  assert.doesNotMatch(finalPath, /child\.stdin\.end\(/);
});
