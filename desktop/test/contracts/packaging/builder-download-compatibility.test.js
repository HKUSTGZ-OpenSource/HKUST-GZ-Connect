'use strict';

// Exercise the installed builder, not a second implementation of its download policy.
// Each fixture runs in a fresh process with loopback-only mirrors/proxies and an empty cache.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

async function runWorker(kind, cacheRoot) {
  const body = Buffer.from('synthetic builder artifact; never executable');
  const checksum = crypto.createHash('sha256').update(body).digest('hex');
  let requests = 0;
  let proxied = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    if (request.url.startsWith('http://127.0.0.2:')) proxied += 1;
    if (kind === 'deadline') return;
    response.writeHead(200, { 'Content-Length': body.length });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  if (kind === 'proxy') process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
  // Optional local negative experiment: replace only builder's @electron/get import.
  // This does not edit node_modules, the lockfile or any installed application.
  if (process.env.HKUST_TEST_GET5_CANDIDATE === '1') {
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
  const { downloadElectronArtifactZip } = require('app-builder-lib/out/util/electronGet');
  const filename = `electron-v43.7.7-${process.platform}-${process.arch}.zip`;
  const options = {
    artifactName: 'electron', version: '43.7.7',
    platformName: process.platform, arch: process.arch, cacheDir: cacheRoot,
    electronDownload: {
      checksums: { [filename]: kind === 'checksum' ? '0'.repeat(64) : checksum },
      mirrorOptions: {
        resolveAssetURL: async () => `http://${kind === 'proxy' ? '127.0.0.2' : '127.0.0.1'}:${port}/${filename}`,
      },
      downloadOptions: { timeout: { request: kind === 'deadline' ? 50 : 2_000 },
        retry: { limit: 0 }, quiet: true },
    },
  };
  const started = performance.now();
  try {
    const downloaded = await downloadElectronArtifactZip(options);
    assert.deepEqual(await fs.readFile(downloaded), body);
    assert.ok(downloaded.startsWith(`${cacheRoot}${path.sep}`));
    if (kind === 'cache') {
      const second = await downloadElectronArtifactZip(options);
      assert.equal(second, downloaded);
    }
    return { outcome: 'downloaded', requests, proxied };
  } catch (error) {
    return { outcome: 'rejected', code: error.code || '', requests, proxied,
      checksumMismatch: error instanceof require('sumchecker').ChecksumMismatchError,
      elapsed: performance.now() - started };
  } finally {
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
    assert.equal(result.code, 'ETIMEDOUT');
    assert.ok(result.elapsed < 18_000, 'bounded retries must retain request deadlines');
  });
}
