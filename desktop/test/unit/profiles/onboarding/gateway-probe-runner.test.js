'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  GatewayProbeRunner,
  MAX_GATEWAY_PROBE_OUTPUT_BYTES,
  privateProbeEnvironment,
} = require('../../../../lib/profiles/onboarding/gateway-probe-runner');

function child() {
  const value = new EventEmitter();
  value.stdout = new EventEmitter();
  value.stderr = new EventEmitter();
  value.kill = () => { value.killed = true; };
  return value;
}

test('probe launches one credential-free bounded native request', async () => {
  const calls = [];
  const process = child();
  const runner = new GatewayProbeRunner({
    executablePath: '/app/ec-gateway-probe-darwin-arm64',
    platform: 'darwin',
    environment: {
      TMPDIR: '/private/tmp',
      HTTP_PROXY: 'http://untrusted.invalid',
      GH_TOKEN: 'must-not-cross',
    },
    spawnProcess: (...args) => { calls.push(args); return process; },
  });
  const pending = runner.probe('https://vpn.example.edu/');
  process.stdout.emit('data', Buffer.from(`${JSON.stringify({
    schema_version: 1,
    normalized_origin: 'https://vpn.example.edu',
    https_identity_valid: true,
    compatibility: 'recognized_candidate',
    candidate_family: 'easyconnect-modern-l3',
    reported_version: 'M7.6.8R2',
    http_status: 200,
  })}\n`));
  process.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.normalized_origin, 'https://vpn.example.edu');
  assert.deepEqual(calls[0][1], ['--origin', 'https://vpn.example.edu']);
  assert.deepEqual(calls[0][2].env, { TMPDIR: '/private/tmp' });
  assert.equal(calls[0][2].shell, false);
  assert.deepEqual(calls[0][2].stdio, ['ignore', 'pipe', 'pipe']);
});

test('probe rejects concurrent oversized malformed and failed child outcomes', async () => {
  const first = child();
  const runner = new GatewayProbeRunner({
    executablePath: '/app/ec-gateway-probe-darwin-arm64',
    spawnProcess: () => first,
  });
  const pending = runner.probe('https://vpn.example.edu');
  await assert.rejects(runner.probe('https://other.example.edu'), {
    code: 'GATEWAY_PROBE_ALREADY_RUNNING',
  });
  first.stdout.emit('data', Buffer.alloc(MAX_GATEWAY_PROBE_OUTPUT_BYTES + 1, 1));
  first.emit('close', 1, null);
  await assert.rejects(pending, { code: 'GATEWAY_PROBE_OUTPUT_INVALID' });

  const malformed = child();
  const malformedRunner = new GatewayProbeRunner({
    executablePath: '/app/ec-gateway-probe-darwin-arm64',
    spawnProcess: () => malformed,
  });
  const malformedPending = malformedRunner.probe('https://vpn.example.edu');
  malformed.stdout.emit('data', '{not-json}\n');
  malformed.emit('close', 0, null);
  await assert.rejects(malformedPending, { code: 'GATEWAY_PROBE_OUTPUT_INVALID' });
});

test('timeout and explicit cancellation terminate the child and settle once', async () => {
  for (const action of ['timeout', 'cancel']) {
    const process = child();
    let timeoutCallback = null;
    const runner = new GatewayProbeRunner({
      executablePath: '/app/ec-gateway-probe-darwin-arm64',
      spawnProcess: () => process,
      setTimeoutFn: (callback) => { timeoutCallback = callback; return { unref() {} }; },
      clearTimeoutFn: () => {},
    });
    const pending = runner.probe('https://vpn.example.edu');
    if (action === 'timeout') timeoutCallback();
    else assert.equal(runner.cancel(), true);
    await assert.rejects(pending, {
      code: action === 'timeout' ? 'GATEWAY_PROBE_TIMEOUT' : 'GATEWAY_PROBE_CANCELLED',
    });
    assert.equal(process.killed, true);
    process.emit('close', 0, null);
  }
});

test('private child environment never forwards proxy credential or certificate overrides', () => {
  assert.deepEqual(privateProbeEnvironment({
    SYSTEMROOT: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    HTTP_PROXY: 'forbidden',
    SSL_CERT_FILE: 'forbidden',
    TOKEN: 'forbidden',
  }, 'win32'), {
    SYSTEMROOT: 'C:\\Windows',
    TEMP: 'C:\\Temp',
  });
});

test('synthetic probe uses only a fixed absolute prefix and an isolated Electron Node flag', async () => {
  const calls = [];
  const process = child();
  const runner = new GatewayProbeRunner({
    executablePath: '/app/Electron',
    platform: 'darwin',
    argsPrefix: ['/app/e2e/main-gateway-probe-fixture.js'],
    electronRunAsNode: true,
    environment: { TMPDIR: '/private/tmp', SECRET: 'must-not-cross' },
    spawnProcess: (...args) => { calls.push(args); return process; },
  });
  const pending = runner.probe('https://vpn.example.edu');
  process.stdout.emit('data', `${JSON.stringify({ ok: true })}\n`);
  process.emit('close', 0, null);
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(calls[0][1], [
    '/app/e2e/main-gateway-probe-fixture.js',
    '--origin',
    'https://vpn.example.edu',
  ]);
  assert.deepEqual(calls[0][2].env, {
    TMPDIR: '/private/tmp',
    ELECTRON_RUN_AS_NODE: '1',
  });
  assert.throws(() => new GatewayProbeRunner({
    executablePath: '/app/Electron', argsPrefix: ['relative.js'], spawnProcess: () => child(),
  }), /dependencies are invalid/u);
});

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`probe runner projects only the ${platform} environment allowlist`, async () => {
    const calls = [];
    const process = child();
    const runner = new GatewayProbeRunner({
      executablePath: '/app/synthetic-probe',
      platform,
      environment: {
        TMPDIR: '/private/tmp',
        SYSTEMROOT: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        HTTP_PROXY: 'http://untrusted.invalid',
        SSL_CERT_FILE: 'untrusted.pem',
        TOKEN: 'synthetic-must-not-cross',
      },
      spawnProcess: (...args) => { calls.push(args); return process; },
    });
    const pending = runner.probe('https://vpn.example.edu');
    process.stdout.emit('data', '{"ok":true}\n');
    process.emit('close', 0, null);
    assert.deepEqual(await pending, { ok: true });
    assert.deepEqual(calls[0][2].env, platform === 'win32'
      ? { SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\Temp' }
      : { TMPDIR: '/private/tmp' });
    assert.equal(calls[0][2].shell, false);
    assert.equal(calls[0][2].windowsHide, true);
  });
}
