'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  BufferedLogWriter,
  DEFAULT_RETENTION_MS,
  readLogTail,
  redactDiagnosticText,
} = require('../../../../lib/diagnostics/logging/log-writer');

function temporaryLog(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-buffered-log-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'engine.log');
}

function symbolicLogTarget(t, content = 'unrelated private content\n') {
  const file = temporaryLog(t);
  const target = path.join(path.dirname(file), 'unrelated-private-file');
  fs.writeFileSync(target, content, { mode: 0o640 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o640);
  fs.symlinkSync(target, file);
  return {
    content,
    file,
    mode: process.platform === 'win32' ? null : fs.statSync(target).mode & 0o777,
    target,
  };
}

function assertTargetUnchanged(snapshot) {
  assert.equal(fs.readFileSync(snapshot.target, 'utf8'), snapshot.content);
  if (snapshot.mode !== null) {
    assert.equal(fs.statSync(snapshot.target).mode & 0o777, snapshot.mode);
  }
}

test('redacts common authentication material before it reaches disk', () => {
  const result = redactDiagnosticText([
    'Authorization: Bearer abc.def',
    'Cookie: session=abcdef',
    'password=super-secret token: one-time',
    'https://id.example/saml?SAMLRequest=payload&RelayState=state',
  ].join('\n'));
  assert.doesNotMatch(result, /abc\.def|abcdef|super-secret|one-time|payload|state$/m);
  assert.match(result, /\[REDACTED\]/);
});

test('redacts generic MFA and continuation fields without depending on a protocol endpoint', () => {
  const secrets = [
    'otp=654321',
    'TOTP: 918273',
    'one_time_code="alpha-code"',
    'verification-code: verify-me',
    'passcode=pass-me',
    'TwfID: partial-session',
    'CSRF_RAND_CODE=csrf-material',
    '{"otp":"json-otp","TwfID":"json-session"}',
    'https://id.example/challenge?otp=url-otp&verification_code=url-code&csrf_token=url-csrf',
    'requestId=42 challengeEpoch=3',
  ];
  const result = redactDiagnosticText(secrets.join('\n'));
  for (const secret of [
    '654321', '918273', 'alpha-code', 'verify-me', 'pass-me',
    'partial-session', 'csrf-material', 'json-otp', 'json-session',
    'url-otp', 'url-code', 'url-csrf',
  ]) {
    assert.doesNotMatch(result, new RegExp(secret));
  }
  assert.match(result, /otp=\[REDACTED\]/i);
  assert.match(result, /TwfID: \[REDACTED\]/i);
  assert.match(result, /requestId=42/);
  assert.equal(redactDiagnosticText('requestId=42 challengeEpoch=3'),
    'requestId=42 challengeEpoch=3');
});

test('buffers writes, keeps owner-only permissions, and rotates at a fixed limit', async (t) => {
  const file = temporaryLog(t);
  const writer = new BufferedLogWriter(file, {
    maxBytes: 1024,
    maxBufferBytes: 4096,
    flushIntervalMs: 60_000,
  });
  writer.append(`${'a'.repeat(800)}\n`);
  await writer.flush();
  writer.append(`${'b'.repeat(800)}\n`);
  await writer.flush();
  await writer.close();

  assert.equal(fs.existsSync(`${file}.1`), true);
  assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /^a+/);
  assert.match(fs.readFileSync(file, 'utf8'), /^b+/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(`${file}.1`).mode & 0o777, 0o600);
  }
});

test('retention window removes every log older than three days even during continuous use', async (t) => {
  assert.equal(DEFAULT_RETENTION_MS, 3 * 24 * 60 * 60 * 1000);
  const file = temporaryLog(t);
  let currentTime = Date.UTC(2026, 7, 1);
  const writer = new BufferedLogWriter(file, {
    flushIntervalMs: 60_000,
    now: () => currentTime,
  });

  writer.append('first-day\n');
  await writer.flush();
  currentTime += DEFAULT_RETENTION_MS - 1;
  writer.append('still-inside-window\n');
  await writer.flush();
  assert.match(fs.readFileSync(file, 'utf8'), /first-day/);

  currentTime += 1;
  writer.append('new-window\n');
  await writer.flush();
  await writer.close();

  assert.equal(fs.readFileSync(file, 'utf8'), 'new-window\n');
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), '');
});

test('retention marker survives restart and expires an otherwise idle log', async (t) => {
  const file = temporaryLog(t);
  let currentTime = Date.UTC(2026, 7, 1);
  const first = new BufferedLogWriter(file, {
    flushIntervalMs: 60_000,
    now: () => currentTime,
  });
  first.append('previous-session\n');
  await first.close();

  currentTime += DEFAULT_RETENTION_MS;
  const restarted = new BufferedLogWriter(file, {
    flushIntervalMs: 60_000,
    now: () => currentTime,
  });
  await restarted.flush();
  await restarted.close();

  assert.equal(fs.readFileSync(file, 'utf8'), '');
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), '');
});

test('retention replaces linked log entries without touching their targets', async (t) => {
  if (process.platform === 'win32') {
    t.skip('creating symbolic links requires elevated privileges on some Windows hosts');
    return;
  }
  const file = temporaryLog(t);
  const entries = [file, `${file}.1`];
  const snapshots = entries.map((entry, index) => {
    const target = path.join(path.dirname(file), `retention-target-${index}`);
    const content = `private-${index}\n`;
    fs.writeFileSync(target, content, { mode: 0o640 });
    fs.chmodSync(target, 0o640);
    fs.symlinkSync(target, entry);
    return { content, entry, mode: fs.statSync(target).mode & 0o777, target };
  });

  const currentTime = Date.UTC(2026, 7, 8);
  fs.writeFileSync(
    `${file}.retention`,
    `${currentTime - DEFAULT_RETENTION_MS}\n`,
    { mode: 0o600 },
  );
  const writer = new BufferedLogWriter(file, {
    flushIntervalMs: 60_000,
    now: () => currentTime,
  });
  await writer.flush();
  await writer.close();

  for (const snapshot of snapshots) {
    assert.equal(fs.readFileSync(snapshot.target, 'utf8'), snapshot.content);
    assert.equal(fs.statSync(snapshot.target).mode & 0o777, snapshot.mode);
    assert.equal(fs.lstatSync(snapshot.entry).isSymbolicLink(), false);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), '');
});

test('unsafe retention marker fails closed without touching its target', async (t) => {
  if (process.platform === 'win32') {
    t.skip('creating symbolic links requires elevated privileges on some Windows hosts');
    return;
  }
  const file = temporaryLog(t);
  const target = path.join(path.dirname(file), 'retention-marker-target');
  fs.writeFileSync(target, 'unrelated marker target\n', { mode: 0o640 });
  fs.chmodSync(target, 0o640);
  const mode = fs.statSync(target).mode & 0o777;
  fs.symlinkSync(target, `${file}.retention`);

  const writer = new BufferedLogWriter(file, { flushIntervalMs: 60_000 });
  writer.append('must not be written\n');
  await assert.rejects(writer.flush(), { code: 'ERR_UNSAFE_LOG_PATH' });
  await writer.close();

  assert.equal(fs.readFileSync(target, 'utf8'), 'unrelated marker target\n');
  assert.equal(fs.statSync(target).mode & 0o777, mode);
  assert.equal(fs.lstatSync(`${file}.retention`).isSymbolicLink(), true);
  assert.equal(fs.existsSync(file), false);
});

test('tail reading is byte-bounded and returns only requested trailing lines', async (t) => {
  const file = temporaryLog(t);
  fs.writeFileSync(
    file,
    Array.from({ length: 2000 }, (_, index) => `line-${index}`).join('\n'),
    { mode: 0o644 },
  );
  if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
  const tail = await readLogTail(file, { maxBytes: 2048, maxLines: 3 });
  assert.deepEqual(tail.split('\n'), ['line-1997', 'line-1998', 'line-1999']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal((await readLogTail(`${file}.missing`)), '');
});

test('reset is ordered after pending writes and close rejects later appends', async (t) => {
  const file = temporaryLog(t);
  const writer = new BufferedLogWriter(file, { flushIntervalMs: 60_000 });
  writer.append('old\n');
  const flushed = writer.flush();
  const reset = writer.reset();
  await Promise.all([flushed, reset]);
  writer.append('new\n');
  await writer.close();
  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
  assert.equal(writer.append('too late'), false);
});

test('reset atomically replaces a log symlink without touching its target', async (t) => {
  if (process.platform === 'win32') {
    t.skip('creating symbolic links requires elevated privileges on some Windows hosts');
    return;
  }
  const snapshot = symbolicLogTarget(t);
  const writer = new BufferedLogWriter(snapshot.file, { flushIntervalMs: 60_000 });

  await writer.reset();
  await writer.close();

  assertTargetUnchanged(snapshot);
  assert.equal(fs.lstatSync(snapshot.file).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(snapshot.file, 'utf8'), '');
  assert.equal(fs.statSync(snapshot.file).mode & 0o777, 0o600);
});

test('append rejects a log symlink without writing or chmodding its target', async (t) => {
  if (process.platform === 'win32') {
    t.skip('creating symbolic links requires elevated privileges on some Windows hosts');
    return;
  }
  const snapshot = symbolicLogTarget(t);
  const writer = new BufferedLogWriter(snapshot.file, { flushIntervalMs: 60_000 });
  writer.append('must not reach the target\n');

  await assert.rejects(writer.flush(), { code: 'ERR_UNSAFE_LOG_PATH' });

  assertTargetUnchanged(snapshot);
  assert.equal(fs.lstatSync(snapshot.file).isSymbolicLink(), true);
  await writer.close();
});

test('tail reading rejects a log symlink without reading or chmodding its target', async (t) => {
  if (process.platform === 'win32') {
    t.skip('creating symbolic links requires elevated privileges on some Windows hosts');
    return;
  }
  const snapshot = symbolicLogTarget(t, 'secret that must never be returned\n');

  assert.equal(await readLogTail(snapshot.file), '');

  assertTargetUnchanged(snapshot);
  assert.equal(fs.lstatSync(snapshot.file).isSymbolicLink(), true);
});

test('rotation replaces a rotated-log symlink without touching its target', async (t) => {
  if (process.platform === 'win32') {
    t.skip('creating symbolic links requires elevated privileges on some Windows hosts');
    return;
  }
  const file = temporaryLog(t);
  fs.writeFileSync(file, 'a'.repeat(2048), { mode: 0o600 });
  const target = path.join(path.dirname(file), 'rotated-symlink-target');
  const content = 'unrelated rotated target\n';
  fs.writeFileSync(target, content, { mode: 0o640 });
  fs.chmodSync(target, 0o640);
  const mode = fs.statSync(target).mode & 0o777;
  fs.symlinkSync(target, `${file}.1`);

  const writer = new BufferedLogWriter(file, {
    maxBytes: 1024,
    maxBufferBytes: 4096,
    flushIntervalMs: 60_000,
  });
  writer.append(`${'b'.repeat(800)}\n`);
  await writer.close();

  assert.equal(fs.readFileSync(target, 'utf8'), content);
  assert.equal(fs.statSync(target).mode & 0o777, mode);
  assert.equal(fs.lstatSync(`${file}.1`).isSymbolicLink(), false);
  assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /^a+/);
  assert.equal(fs.statSync(`${file}.1`).size, 1024);
  assert.match(fs.readFileSync(file, 'utf8'), /^b+/);
  assert.equal(fs.statSync(`${file}.1`).mode & 0o777, 0o600);
});

test('threshold and timer flush failures are reported without unhandled rejections', async (t) => {
  if (process.platform === 'win32') {
    t.skip('creating symbolic links requires elevated privileges on some Windows hosts');
    return;
  }

  for (const trigger of ['threshold', 'timer']) {
    const file = temporaryLog(t);
    const target = path.join(path.dirname(file), `background-${trigger}-target`);
    fs.writeFileSync(target, 'untouched\n', { mode: 0o640 });
    fs.chmodSync(target, 0o640);
    const mode = fs.statSync(target).mode & 0o777;
    fs.symlinkSync(target, file);

    let reported;
    const errorReported = new Promise((resolve) => {
      reported = resolve;
    });
    const writer = new BufferedLogWriter(file, {
      flushIntervalMs: 10,
      maxBufferBytes: 1024,
      onError: reported,
    });
    writer.append(trigger === 'threshold' ? 'x'.repeat(1024) : 'timer\n');

    const error = await errorReported;
    assert.equal(error.code, 'ERR_UNSAFE_LOG_PATH');
    assert.equal(writer.lastError, error);
    assert.equal(fs.readFileSync(target, 'utf8'), 'untouched\n');
    assert.equal(fs.statSync(target).mode & 0o777, mode);
    await writer.close();
  }
});

test('log I/O notifications are throttled per failure episode and clear after proven recovery', async (t) => {
  if (process.platform === 'win32') {
    t.skip('creating symbolic links requires elevated privileges on some Windows hosts');
    return;
  }
  const snapshot = symbolicLogTarget(t);
  const errors = [];
  let recoveries = 0;
  const writer = new BufferedLogWriter(snapshot.file, {
    flushIntervalMs: 60_000,
    onError: (error) => errors.push(error),
    onRecovered: () => { recoveries += 1; },
  });

  writer.append('first failure\n');
  await assert.rejects(writer.flush(), { code: 'ERR_UNSAFE_LOG_PATH' });
  writer.append('same episode\n');
  await assert.rejects(writer.flush(), { code: 'ERR_UNSAFE_LOG_PATH' });
  assert.equal(errors.length, 1, 'repeated failures must not spam the UI');
  assert.equal(writer.lastError.code, 'ERR_UNSAFE_LOG_PATH');

  fs.unlinkSync(snapshot.file);
  writer.append('recovered flush\n');
  await writer.flush();
  assert.equal(recoveries, 1);
  assert.equal(writer.lastError, null);
  await writer.flush();
  assert.equal(recoveries, 1, 'an empty flush is not new recovery evidence');

  fs.unlinkSync(snapshot.file);
  fs.symlinkSync(snapshot.target, snapshot.file);
  writer.append('new failure episode\n');
  await assert.rejects(writer.flush(), { code: 'ERR_UNSAFE_LOG_PATH' });
  assert.equal(errors.length, 2);
  await writer.reset();
  assert.equal(recoveries, 2);
  assert.equal(writer.lastError, null);
  assert.equal(fs.lstatSync(snapshot.file).isSymbolicLink(), false);
  assertTargetUnchanged(snapshot);
  await writer.close();
});

test('bounded tail reads stop at lifecycle boundaries and close their owned descriptor', async t => {
  const file = temporaryLog(t);
  fs.writeFileSync(file, 'synthetic line\n'.repeat(1000), { mode: 0o600 });
  assert.equal(await readLogTail(file, { contextCurrent: () => false }), '');
  assert.equal(await readLogTail(file, { contextCurrent: null }), '');
  const originalOpen = fs.promises.open;
  const handles = [];
  fs.promises.open = async (...args) => { const handle = await originalOpen.apply(fs.promises, args);
    if (args[0] === file) handles.push(handle); return handle; };
  t.after(() => { fs.promises.open = originalOpen; });
  let checks = 0;
  assert.equal(await readLogTail(file, { contextCurrent: () => ++checks < 4 }), '',
    'retirement during content read cannot return old-context bytes');
  assert.equal(handles.length, 1);
  assert.equal(handles[0].fd, -1, 'retirement must still finish descriptor cleanup');
  fs.promises.open = originalOpen;
  assert.ok((await readLogTail(file)).includes('synthetic line'));
});

test('tail result is fenced after asynchronous descriptor cleanup as well', async t => {
  const file = temporaryLog(t); fs.writeFileSync(file, 'synthetic scoped tail\n', { mode: 0o600 });
  const originalOpen = fs.promises.open; let retired = false;
  fs.promises.open = async (...args) => {
    const handle = await originalOpen.apply(fs.promises, args);
    if (args[0] === file) {
      const close = handle.close.bind(handle);
      handle.close = async () => { retired = true; await close(); };
    }
    return handle;
  };
  t.after(() => { fs.promises.open = originalOpen; });
  assert.equal(await readLogTail(file, { contextCurrent: () => !retired }), '');
  assert.equal(retired, true);
});
