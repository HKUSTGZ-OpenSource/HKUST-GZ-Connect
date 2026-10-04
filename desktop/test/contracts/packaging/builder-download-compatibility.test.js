'use strict';

// Exercise the installed builder, not a second implementation of its download policy.
// Each fixture runs in a fresh process with loopback-only mirrors/proxies and an empty cache.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

async function runWorker(kind, cacheRoot) {
  const deadlineCase = kind === 'deadline' || kind === 'deadline-preparation';
  const body = Buffer.from('synthetic builder artifact; never executable');
  const checksum = crypto.createHash('sha256').update(body).digest('hex');
  let requests = 0;
  let proxied = 0;
  let deadlineController = null, deadlineTimer = null;
  const server = http.createServer((request, response) => {
    requests += 1;
    if (request.url.startsWith('http://127.0.0.2:')) proxied += 1;
    if (deadlineCase) {
      // Measure the installed builder's forwarding of the same300ms deadline
      // only after actual request admission, not cache/lock/fetch preparation.
      if (deadlineController && deadlineTimer === null) {
        deadlineTimer = setTimeout(() => deadlineController.abort(
          new DOMException('synthetic in-flight deadline', 'TimeoutError')), 300);
      }
      return;
    }
    if ((kind === 'retry' && requests === 1) || kind === 'not-found') {
      response.writeHead(kind === 'retry' ? 503 : 404);
      response.end('synthetic status');
      return;
    }
    response.writeHead(200, { 'Content-Length': body.length });
    response.end(body);
  });
  // Fetch's ProxyAgent uses CONNECT even for HTTP targets. Terminate that
  // synthetic tunnel locally; never open a connection to any external target.
  server.on('connect', (request, socket, head) => {
    if (!/^127\.0\.0\.2:\d+$/u.test(request.url)) { socket.destroy(); return; }
    proxied += 1;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    server.emit('connection', socket);
    if (head.length) socket.unshift(head);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  if (kind === 'proxy') process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
  const candidateRoot = process.env.HKUST_TEST_BUILDER27_ROOT;
  let builderRequire = require;
  if (candidateRoot) {
    assert.ok(path.isAbsolute(candidateRoot));
    assert.ok(path.basename(candidateRoot).startsWith('hkust-builder27-evaluation.'));
    builderRequire = createRequire(path.join(candidateRoot, 'package.json'));
  }
  const entrypoint = builderRequire.resolve('app-builder-lib');
  const manifest = builderRequire(path.join(path.dirname(entrypoint), '..', 'package.json'));
  const major = Number(manifest.version.split('.')[0]);
  assert.ok([26, 27].includes(major), 'a new builder major needs an explicit compatibility review');
  const usesFetch = major === 27;
  if (usesFetch && deadlineCase) deadlineController = new AbortController();
  // Optional local negative experiment: replace only builder's @electron/get import.
  // This does not edit node_modules, the lockfile or any installed application.
  if (process.env.HKUST_TEST_GET5_CANDIDATE === '1') {
    assert.equal(major, 26, 'the unsafe override experiment applies only to the legacy builder');
    const Module = require('node:module');
    const candidate = require('@electron/get');
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
      if (request === '@electron/get' && parent?.filename.includes(`${path.sep}app-builder-lib${path.sep}`)) {
        return candidate;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  }
  // v27 no longer exports deep imports. This vendor seam is confined to the
  // download contract, never production Main/Preload. It works with both layouts.
  const { downloadElectronArtifactZip } = builderRequire(path.join(path.dirname(entrypoint), 'util', 'electronGet.js'));
  // Builder locks are global by version/platform, even for different cache
  // roots. Use a unique synthetic version so stalled negative fixtures cannot
  // block positive tests or a real build of Electron 43.7.7.
  const version = `43.7.7-synthetic.${process.pid}`;
  const filename = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  const options = {
    artifactName: 'electron', version,
    platformName: process.platform, arch: process.arch, cacheDir: cacheRoot,
    [usesFetch ? 'options' : 'electronDownload']: {
      checksums: { [filename]: kind === 'checksum' ? '0'.repeat(64) : checksum },
      mirrorOptions: {
        resolveAssetURL: async () => `http://${kind === 'proxy' ? '127.0.0.2' : '127.0.0.1'}:${port}/${filename}`,
      },
      downloadOptions: usesFetch
        ? { signal: deadlineController?.signal || AbortSignal.timeout(10_000), quiet: true }
        : { timeout: { request: deadlineCase ? 50 : 2_000 }, retry: { limit: 0 }, quiet: true },
    },
  };
  const started = performance.now();
  try {
    if (kind === 'deadline-preparation') await new Promise(resolve => setTimeout(resolve, 750));
    const downloaded = await downloadElectronArtifactZip(options);
    assert.deepEqual(await fs.readFile(downloaded), body);
    assert.ok(downloaded.startsWith(`${cacheRoot}${path.sep}`));
    if (kind === 'cache') {
      const second = await downloadElectronArtifactZip(options);
      assert.equal(second, downloaded);
    }
    if (kind === 'corrupt-cache') {
      await fs.writeFile(downloaded, 'synthetic corrupted cache');
      const recovered = await downloadElectronArtifactZip(options);
      assert.deepEqual(await fs.readFile(recovered), body);
    }
    return { outcome: 'downloaded', requests, proxied, usesFetch };
  } catch (error) {
    return { outcome: 'rejected', code: error.code || '', requests, proxied, usesFetch,
      checksumMismatch: error instanceof builderRequire('sumchecker').ChecksumMismatchError,
      deadlineRejected: error.name === 'TimeoutError' || error.name === 'AbortError',
      status: error.response?.statusCode ?? error.response?.status ?? null,
      elapsed: performance.now() - started, deadlineArmed: deadlineTimer !== null };
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (process.argv[2] === '--builder-download-worker') {
  runWorker(process.argv[3], process.argv[4]).then((result) => {
    process.send(result, () => process.exit(0));
  }, () => {
    process.send({ outcome: 'fixture-error' }, () => process.exit(1));
  });
} else {
  async function fixture(t, kind) {
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hkust-builder-contract-'));
    t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }));
    const child = fork(__filename, ['--builder-download-worker', kind, cacheRoot], {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ELECTRON_GET_NO_PROGRESS: '1',
        // Intentionally opt-in, for the isolated negative experiment only.
        HKUST_TEST_GET5_CANDIDATE: process.env.HKUST_TEST_GET5_CANDIDATE || '',
        HKUST_TEST_BUILDER27_ROOT: process.env.HKUST_TEST_BUILDER27_ROOT || '',
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let result;
    const outcome = await new Promise((resolve, reject) => {
      const watchdog = setTimeout(() => { child.kill(); }, 20_000);
      child.once('error', reject);
      child.on('message', (value) => { result = value; });
      child.once('exit', (code, signal) => {
        clearTimeout(watchdog);
        if (code !== 0 || !result) {
          reject(new Error(`builder fixture ${kind} failed or exceeded its deadline (${signal || code})`));
        } else resolve(result);
      });
    });
    return outcome;
  }

  test('builder verifies a synthetic download and reuses only its isolated cache', { timeout: 25_000 }, async (t) => {
    const result = await fixture(t, 'cache');
    assert.equal(result.outcome, 'downloaded');
    assert.equal(result.requests, 1, 'second request must be a verified cache hit');
  });

  test('builder rejects a synthetic artifact whose SHA-256 does not match', { timeout: 25_000 }, async (t) => {
    const result = await fixture(t, 'checksum');
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.requests, 1);
    assert.equal(result.checksumMismatch, true);
  });

  test('builder honors the explicit process-local HTTP proxy without changing system settings', { timeout: 25_000 }, async (t) => {
    const result = await fixture(t, 'proxy');
    assert.equal(result.outcome, 'downloaded');
    assert.equal(result.proxied, 1, 'the loopback proxy must actually receive the request');
  });

  test('builder retains its configured request deadline on a stalled loopback download', { timeout: 25_000 }, async (t) => {
    const result = await fixture(t, 'deadline');
    assert.equal(result.outcome, 'rejected');
    if (result.usesFetch) {
      assert.equal(result.deadlineRejected, true);
      assert.equal(result.deadlineArmed, true, 'the abort deadline follows an observed request');
    }
    else assert.equal(result.code, 'ETIMEDOUT');
    assert.ok(result.requests >= 1, 'the deadline must bound an actually started download');
    assert.ok(result.elapsed < 18_000, 'bounded retries must retain request deadlines');
  });

  test('builder retries a synthetic 503 then accepts the checksum-verified artifact', { timeout: 25_000 }, async (t) => {
    const result = await fixture(t, 'retry');
    assert.equal(result.outcome, 'downloaded');
    assert.equal(result.requests, 2);
  });

  test('in-flight deadline evidence excludes delayed preparation before the request starts', { timeout: 25_000 }, async t => {
    const result = await fixture(t, 'deadline-preparation');
    assert.equal(result.outcome, 'rejected');
    assert.ok(result.requests >= 1, 'preparation is not an in-flight request deadline measurement');
    if (result.usesFetch) {
      assert.equal(result.deadlineRejected, true);
      assert.equal(result.deadlineArmed, true);
    }
    else assert.equal(result.code, 'ETIMEDOUT');
    assert.ok(result.elapsed < 18_000, 'the existing total guard is unchanged');
  });

  test('builder rejects a permanent 404 without repeating the download', { timeout: 25_000 }, async (t) => {
    const result = await fixture(t, 'not-found');
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.status, 404);
    assert.equal(result.requests, 1);
  });

  test('builder revalidates a corrupt cached artifact and downloads a verified replacement', { timeout: 25_000 }, async (t) => {
    const result = await fixture(t, 'corrupt-cache');
    assert.equal(result.outcome, 'downloaded');
    assert.equal(result.requests, 2);
  });
}
