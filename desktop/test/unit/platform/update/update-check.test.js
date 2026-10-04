'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const net = require('node:net');
const {
  AUTO_CHECK_INTERVAL_MS,
  REPOSITORY_API_URL,
  REPOSITORY_ID,
  REPOSITORY_NAME,
  REQUEST_TIMEOUT_MS,
  checkForUpdate,
  compareVersions,
  isBetaFinalPromotion,
  isAllowedReleaseUrl,
  isCurrentUpdateUrl,
  repositoryReleaseEndpoints,
  shouldAutoCheck,
} = require('../../../../lib/platform/update/update-check');

const INITIAL_OWNER = 'heeh02';
const INITIAL_API = `https://api.github.com/repos/${INITIAL_OWNER}/${REPOSITORY_NAME}`;
const RELEASES_API_URL = `${INITIAL_API}/releases/latest`;
const PRERELEASES_API_URL = `${INITIAL_API}/releases?per_page=30`;
const RELEASES_URL_PREFIX = `https://github.com/${INITIAL_OWNER}/${REPOSITORY_NAME}/releases`;

test('Main release opening accepts only its exact identity-checked issued update', async () => {
  const original = await checkForUpdate('2.0.0', repositoryFetcher({
    tag_name: 'v2.0.3', html_url: `${RELEASES_URL_PREFIX}/tag/v2.0.3`,
  }));
  assert.equal(isCurrentUpdateUrl(original.url, original), true);
  for (const url of ['', null, undefined, original.url + '/extra', original.url + '?x=1',
    original.url.replace('v2.0.3', 'v2.0.4'), 'file:///tmp/test', 'https://example.invalid']) {
    assert.equal(isCurrentUpdateUrl(url, original), false);
  }
  assert.equal(isCurrentUpdateUrl(original.url, null), false);
  assert.equal(isCurrentUpdateUrl(original.url, { ...original, updateAvailable: false }), false);
  const transferred = await checkForUpdate('2.0.0', repositoryFetcher({ tag_name: 'v2.0.3',
    html_url: 'https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/releases/tag/v2.0.3',
  }, 'HKUSTGZ-OpenSource'));
  assert.equal(isCurrentUpdateUrl(transferred.url, transferred), true);
  assert.equal(isCurrentUpdateUrl(original.url, transferred), false);
});

function repositoryMetadata(owner = INITIAL_OWNER) {
  const api = `https://api.github.com/repos/${owner}/${REPOSITORY_NAME}`;
  const web = `https://github.com/${owner}/${REPOSITORY_NAME}`;
  return {
    id: REPOSITORY_ID,
    name: REPOSITORY_NAME,
    full_name: `${owner}/${REPOSITORY_NAME}`,
    owner: { login: owner },
    url: api,
    html_url: web,
    releases_url: `${api}/releases{/id}`,
    private: false,
    visibility: 'public',
    archived: false,
    disabled: false,
  };
}

function repositoryFetcher(releaseValue, owner = INITIAL_OWNER) {
  return async (url) => url === REPOSITORY_API_URL
    ? repositoryMetadata(owner)
    : releaseValue;
}

test('compareVersions orders plain numeric versions', () => {
  assert.equal(compareVersions('1.0.7', '1.0.7'), 0);
  assert.equal(compareVersions('1.0.8', '1.0.7'), 1);
  assert.equal(compareVersions('1.1.0', '1.0.9'), 1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.7', '1.0.8'), -1);
  assert.equal(compareVersions('1.0.7', '1.1.0'), -1);
  assert.equal(compareVersions('1.0.7', '2.0.0'), -1);
});

test('compareVersions tolerates leading v and short forms', () => {
  assert.equal(compareVersions('v1.0.8', '1.0.7'), 1);
  assert.equal(compareVersions('1.1', '1.1.0'), 0);
  assert.equal(compareVersions(' 1.0.8 ', '1.0.7'), 1);
});

test('compareVersions applies SemVer prerelease ordering', () => {
  assert.equal(compareVersions('2.0.0-beta.2', '2.0.0-beta.1'), 1);
  assert.equal(compareVersions('2.0.0-beta.10', '2.0.0-beta.2'), 1);
  assert.equal(compareVersions('2.0.0-beta.1', '2.0.0'), -1);
  assert.equal(compareVersions('2.0.0', '2.0.0-beta.9'), 1);
  assert.equal(compareVersions('2.0.0-alpha.2', '2.0.0-alpha.10'), -1);
});

test('only the same release-line Beta can promote to its patch-zero final', () => {
  assert.equal(isBetaFinalPromotion('2.0.0', '2.0.1-beta.4'), true);
  assert.equal(isBetaFinalPromotion('2.0.0', '2.0.0-beta.4'), true);
  assert.equal(isBetaFinalPromotion('2.0.1', '2.0.2-beta.4'), false);
  assert.equal(isBetaFinalPromotion('2.1.0', '2.0.1-beta.4'), false);
  assert.equal(isBetaFinalPromotion('2.0.0-beta.5', '2.0.1-beta.4'), false);
});

test('compareVersions refuses unparsable input instead of guessing', () => {
  assert.equal(compareVersions('latest', '1.0.7'), null);
  assert.equal(compareVersions('1.0.7', ''), null);
  assert.equal(compareVersions(null, '1.0.7'), null);
  assert.equal(compareVersions(undefined, undefined), null);
});

test('checkForUpdate reports a newer release with its allowlisted page', async () => {
  const release = {
    tag_name: 'v1.1.0',
    html_url: `${RELEASES_URL_PREFIX}/tag/v1.1.0`,
  };
  const result = await checkForUpdate('1.0.7', repositoryFetcher(release));
  assert.deepEqual(result, {
    updateAvailable: true,
    latestVersion: '1.1.0',
    url: release.html_url,
  });
});

test('checkForUpdate resolves the canonical release API through the immutable repository ID', async () => {
  const requested = [];
  await checkForUpdate('1.0.7', async (url) => {
    requested.push(url);
    if (url === REPOSITORY_API_URL) return repositoryMetadata();
    return { tag_name: 'v1.0.7' };
  });
  assert.deepEqual(requested, [REPOSITORY_API_URL, RELEASES_API_URL]);
});

test('prerelease builds query the release list and discover a newer Beta', async () => {
  const requested = [];
  const release = {
    tag_name: 'v2.0.1-beta.2',
    prerelease: true,
    html_url: `${RELEASES_URL_PREFIX}/tag/v2.0.1-beta.2`,
  };
  const result = await checkForUpdate('2.0.0-beta.1', async (url) => {
    requested.push(url);
    if (url === REPOSITORY_API_URL) return repositoryMetadata();
    return [{ tag_name: 'v1.2.3', prerelease: false }, release];
  });
  assert.deepEqual(requested, [REPOSITORY_API_URL, PRERELEASES_API_URL]);
  assert.deepEqual(result, {
    updateAvailable: true,
    latestVersion: '2.0.1-beta.2',
    url: release.html_url,
  });
});

test('the evidence-gated final supersedes a numerically higher maintenance Beta', async () => {
  const release = {
    tag_name: 'v2.0.0',
    prerelease: false,
    html_url: `${RELEASES_URL_PREFIX}/tag/v2.0.0`,
  };
  const result = await checkForUpdate('2.0.1-beta.7', repositoryFetcher([
    { tag_name: 'v2.0.1-beta.8', prerelease: true },
    release,
  ]));
  assert.deepEqual(result, {
    updateAvailable: true,
    latestVersion: '2.0.0',
    url: release.html_url,
  });
});

test('prerelease selection ignores drafts and older stable releases', async () => {
  const result = await checkForUpdate('2.0.0-beta.3', repositoryFetcher([
    { tag_name: 'v2.0.0-beta.4', prerelease: true, draft: true },
    { tag_name: 'v1.2.3', prerelease: false },
    { tag_name: 'not-a-version', prerelease: true },
  ]));
  assert.deepEqual(result, {
    updateAvailable: false,
    latestVersion: '2.0.0-beta.3',
    url: RELEASES_URL_PREFIX,
  });
});

test('checkForUpdate treats same or older tags as no update', async () => {
  for (const tag of ['v1.0.7', '1.0.7', 'v1.0.6', 'v0.9.9']) {
    const result = await checkForUpdate('1.0.7', repositoryFetcher({ tag_name: tag }));
    assert.equal(result.updateAvailable, false, tag);
    assert.equal(result.latestVersion, tag.replace(/^v/, ''));
    assert.equal(result.url, RELEASES_URL_PREFIX);
  }
});

test('checkForUpdate replaces off-allowlist release URLs with the releases index', async () => {
  const result = await checkForUpdate('1.0.7', repositoryFetcher({
    tag_name: 'v2.0.0',
    html_url: 'https://evil.example.com/releases/tag/v2.0.0',
  }));
  assert.equal(result.updateAvailable, true);
  assert.equal(result.url, RELEASES_URL_PREFIX);
});

test('checkForUpdate collapses every failure mode to null', async () => {
  assert.equal(await checkForUpdate('1.0.7', async () => { throw new Error('offline'); }), null);
  assert.equal(await checkForUpdate('1.0.7', repositoryFetcher(null)), null);
  assert.equal(await checkForUpdate('1.0.7', repositoryFetcher({})), null);
  assert.equal(await checkForUpdate('1.0.7', repositoryFetcher({ tag_name: 42 })), null);
  assert.equal(await checkForUpdate('1.0.7', repositoryFetcher({ tag_name: 'not-a-version' })), null);
  assert.equal(await checkForUpdate('not-a-version', async () => ({ tag_name: 'v1.0.8' })), null);
});

test('repository identity accepts an Organization transfer without trusting a different repository', () => {
  const transferred = repositoryReleaseEndpoints(repositoryMetadata('hkust-connect'));
  assert.deepEqual(transferred, {
    latestApiUrl: `https://api.github.com/repos/hkust-connect/${REPOSITORY_NAME}/releases/latest`,
    prereleasesApiUrl: `https://api.github.com/repos/hkust-connect/${REPOSITORY_NAME}/releases?per_page=30`,
    releasesUrlPrefix: `https://github.com/hkust-connect/${REPOSITORY_NAME}/releases`,
  });

  for (const tampered of [
    { ...repositoryMetadata(), id: REPOSITORY_ID + 1 },
    { ...repositoryMetadata(), name: 'lookalike' },
    { ...repositoryMetadata(), full_name: 'evil/lookalike' },
    { ...repositoryMetadata(), html_url: 'https://evil.example.com/repository' },
    { ...repositoryMetadata(), url: 'https://api.github.com/repos/evil/lookalike' },
    { ...repositoryMetadata(), releases_url: 'https://api.github.com/repos/evil/lookalike/releases{/id}' },
    { ...repositoryMetadata(), owner: { login: 'bad/name' } },
    { ...repositoryMetadata(), private: true },
    { ...repositoryMetadata(), visibility: 'private' },
    { ...repositoryMetadata(), archived: true },
    { ...repositoryMetadata(), disabled: true },
  ]) assert.equal(repositoryReleaseEndpoints(tampered), null);
});

test('checkForUpdate accepts only the release page for the repository ID current owner', async () => {
  const owner = 'hkust-connect';
  const prefix = `https://github.com/${owner}/${REPOSITORY_NAME}/releases`;
  const result = await checkForUpdate('2.0.0', repositoryFetcher({
    tag_name: 'v2.0.1',
    html_url: `${prefix}/tag/v2.0.1`,
  }, owner));
  assert.deepEqual(result, {
    updateAvailable: true,
    latestVersion: '2.0.1',
    url: `${prefix}/tag/v2.0.1`,
  });
});

test('isAllowedReleaseUrl only trusts the GitHub releases prefix', () => {
  assert.equal(isAllowedReleaseUrl(RELEASES_URL_PREFIX, RELEASES_URL_PREFIX), true);
  assert.equal(isAllowedReleaseUrl(
    `${RELEASES_URL_PREFIX}/tag/v1.0.8`, RELEASES_URL_PREFIX,
  ), true);
  assert.equal(isAllowedReleaseUrl(
    `http://github.com/heeh02/HKUST-GZ-Connect/releases/tag/v1`, RELEASES_URL_PREFIX,
  ), false);
  assert.equal(isAllowedReleaseUrl(
    'https://github.com/heeh02/HKUST-GZ-Connect/releases.evil.com/x', RELEASES_URL_PREFIX,
  ), false);
  assert.equal(isAllowedReleaseUrl(
    'https://github.com/heeh02/HKUST-GZ-Connect/issues/1', RELEASES_URL_PREFIX,
  ), false);
  assert.equal(isAllowedReleaseUrl('https://example.com', RELEASES_URL_PREFIX), false);
  assert.equal(isAllowedReleaseUrl('file:///etc/passwd', RELEASES_URL_PREFIX), false);
  assert.equal(isAllowedReleaseUrl('', RELEASES_URL_PREFIX), false);
  assert.equal(isAllowedReleaseUrl(null, RELEASES_URL_PREFIX), false);
  assert.equal(isAllowedReleaseUrl(undefined, RELEASES_URL_PREFIX), false);
  assert.equal(isAllowedReleaseUrl(RELEASES_URL_PREFIX), false,
    'there is no mutable-owner production default');
  const transferredPrefix = `https://github.com/hkust-connect/${REPOSITORY_NAME}/releases`;
  assert.equal(isAllowedReleaseUrl(`${transferredPrefix}/tag/v2.0.1`, transferredPrefix), true);
  assert.equal(isAllowedReleaseUrl(`${RELEASES_URL_PREFIX}/tag/v2.0.1`, transferredPrefix), false);
});

test('automatic checks are throttled to one per interval', () => {
  const now = 1786100000000;
  assert.equal(shouldAutoCheck(0, now), true, 'never checked');
  assert.equal(shouldAutoCheck(undefined, now), true, 'missing timestamp');
  assert.equal(shouldAutoCheck('junk', now), true, 'unparseable timestamp');
  assert.equal(shouldAutoCheck(now - AUTO_CHECK_INTERVAL_MS + 1000, now), false, 'inside the window');
  assert.equal(shouldAutoCheck(now - AUTO_CHECK_INTERVAL_MS, now), true, 'window elapsed');
  assert.equal(shouldAutoCheck(now - 2 * AUTO_CHECK_INTERVAL_MS, now), true, 'long overdue');
});

test('cancelled release checks do not begin or continue identity/release requests', async () => {
  const controller = new AbortController(), calls = [];
  controller.abort();
  assert.equal(await checkForUpdate('2.0.3', async url => { calls.push(url); }, { signal: controller.signal }), null);
  assert.deepEqual(calls, []);
  for (const current of ['2.0.3', '2.0.3-beta.1']) {
    const active = new AbortController();
    assert.equal(await checkForUpdate(current, async (url, options) => {
      assert.equal(options.signal, active.signal); calls.push(url); active.abort(); return repositoryMetadata();
    }, { signal: active.signal }), null);
  }
  assert.deepEqual(calls, [REPOSITORY_API_URL, REPOSITORY_API_URL]);
});

test('cancellation after a release reply prevents issuance of its otherwise valid URL', async () => {
  const controller = new AbortController(); let reads = 0;
  const result = await checkForUpdate('2.0.3', async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    if (++reads === 1) return repositoryMetadata();
    controller.abort(); return { tag_name: 'v99.0.0', html_url: `${RELEASES_URL_PREFIX}/tag/v99.0.0` };
  }, { signal: controller.signal });
  assert.equal(result, null); assert.equal(reads, 2);
});

test('default request adapter propagates cancellation and closes an isolated native loopback request', { timeout: REQUEST_TIMEOUT_MS }, async t => {
  let received;
  const requestArrived = new Promise(resolve => { received = resolve; });
  const server = http.createServer((request) => received(request));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: false });
  agent.createConnection = () => net.connect({ host: '127.0.0.1', port: server.address().port });
  t.after(async () => { agent.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const controller = new AbortController(); let client, requests = 0;
  const module = { exports: {} };
  const source = fs.readFileSync(require.resolve('../../../../lib/platform/update/update-check'), 'utf8');
  vm.runInNewContext(source, {
    module, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    require: name => {
      assert.equal(name, 'https');
      return { get: (url, options, callback) => {
        requests++; assert.equal(url, REPOSITORY_API_URL);
        assert.equal(options.signal, controller.signal);
        // Test-only transport adapter: never contact the public API or an
        // installed proxy; preserve the actual ClientRequest signal semantics.
        client = http.get({ hostname: '127.0.0.1', port: server.address().port,
          path: '/', agent, headers: options.headers, timeout: options.timeout,
          signal: options.signal }, callback);
        return client;
      } };
    },
  });
  const pending = module.exports.checkForUpdate('2.0.3', undefined, { signal: controller.signal });
  const request = await requestArrived;
  const closed = new Promise(resolve => request.once('close', resolve));
  controller.abort();
  assert.equal(await pending, null); await closed;
  assert.equal(client.destroyed, true); assert.equal(requests, 1);
});

test('legacy injected fetchers retain the original single argument when no signal is supplied', async () => {
  let calls = 0;
  await checkForUpdate('2.0.3', function fetch(url) {
    assert.equal(arguments.length, 1); calls++;
    return Promise.resolve(url === REPOSITORY_API_URL ? repositoryMetadata() : { tag_name: 'v2.0.3' });
  });
  assert.equal(calls, 2);
});
