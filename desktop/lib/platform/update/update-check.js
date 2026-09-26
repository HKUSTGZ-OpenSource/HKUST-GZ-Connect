'use strict';

// Check-and-notify only: the macOS builds are ad-hoc signed, so in-app
// downloads cannot be trusted to install. This module only asks GitHub for
// the latest release tag and compares it with the running version; the UI
// then points the user at the release page. Every failure (offline, API
// limit, malformed payload) collapses to `null` so a broken network can
// never surface as an error in the main loop.
const https = require('https');

const REPOSITORY_ID = 1279507615;
const REPOSITORY_NAME = 'HKUST-GZ-Connect';
const REPOSITORY_API_URL = `https://api.github.com/repositories/${REPOSITORY_ID}`;
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 1024 * 1024;
const USER_AGENT = 'hkustgzconnect-update-check';

// shell.openExternal targets from the renderer are confined to this prefix so
// a compromised or buggy page cannot hand the OS an arbitrary URL.
function isAllowedReleaseUrl(url, releasesUrlPrefix) {
  return typeof url === 'string'
    && typeof releasesUrlPrefix === 'string'
    && (url === releasesUrlPrefix || url.startsWith(`${releasesUrlPrefix}/`));
}

// Issuance check, not a general URL validator: the result is owned by Main and
// already checked against the immutable repository ID and current release prefix.
function isCurrentUpdateUrl(url, verifiedUpdate) {
  return typeof url === 'string' && url.length > 0 &&
    verifiedUpdate?.updateAvailable === true && url === verifiedUpdate.url;
}

function repositoryReleaseEndpoints(repository) {
  if (!repository || repository.id !== REPOSITORY_ID || repository.name !== REPOSITORY_NAME ||
      typeof repository.owner?.login !== 'string' ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(repository.owner.login)) return null;

  const owner = repository.owner.login;
  const canonicalApi = `https://api.github.com/repos/${owner}/${REPOSITORY_NAME}`;
  const canonicalWeb = `https://github.com/${owner}/${REPOSITORY_NAME}`;
  if (repository.full_name !== `${owner}/${REPOSITORY_NAME}` ||
      repository.private !== false || repository.visibility !== 'public' ||
      repository.archived !== false || repository.disabled !== false ||
      repository.url !== canonicalApi || repository.html_url !== canonicalWeb ||
      repository.releases_url !== `${canonicalApi}/releases{/id}`) return null;

  return Object.freeze({
    latestApiUrl: `${canonicalApi}/releases/latest`,
    prereleasesApiUrl: `${canonicalApi}/releases?per_page=30`,
    releasesUrlPrefix: `${canonicalWeb}/releases`,
  });
}

function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const normalized = version.trim().replace(/^v/i, '');
  const match = normalized.match(
    /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/u,
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
    prerelease: match[4] ? match[4].split('.') : [],
    normalized,
  };
}

function comparePrereleaseIdentifiers(a, b) {
  const aNumeric = /^\d+$/u.test(a);
  const bNumeric = /^\d+$/u.test(b);
  if (aNumeric && bNumeric) {
    const left = Number(a);
    const right = Number(b);
    return left === right ? 0 : left > right ? 1 : -1;
  }
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a === b ? 0 : a > b ? 1 : -1;
}

// Returns 1 / 0 / -1 like a comparator, or null when either side is not a
// plain numeric version. Callers treat null as "cannot tell", never as
// "update available".
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
  }
  if (pa.prerelease.length === 0 || pb.prerelease.length === 0) {
    if (pa.prerelease.length === pb.prerelease.length) return 0;
    return pa.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < length; i++) {
    if (pa.prerelease[i] === undefined) return -1;
    if (pb.prerelease[i] === undefined) return 1;
    const comparison = comparePrereleaseIdentifiers(pa.prerelease[i], pb.prerelease[i]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function isPrerelease(version) {
  const parsed = parseVersion(version);
  return Boolean(parsed?.prerelease.length);
}

// The user-facing 2.0 Beta line intentionally permits maintenance builds such
// as 2.0.1-beta.1 before the evidence-gated 2.0.0 final. Standard SemVer ranks
// that Beta above 2.0.0, so the final release needs one explicit promotion
// rule. Keeping it here avoids enabling general downgrades.
function isBetaFinalPromotion(candidateVersion, currentVersion) {
  const candidate = parseVersion(candidateVersion);
  const current = parseVersion(currentVersion);
  return Boolean(candidate && current &&
    candidate.prerelease.length === 0 && candidate.patch === 0 &&
    current.prerelease[0]?.toLowerCase() === 'beta' &&
    candidate.major === current.major && candidate.minor === current.minor);
}

function isUpdateCandidate(candidateVersion, currentVersion) {
  const comparison = compareVersions(candidateVersion, currentVersion);
  return comparison === 1 || isBetaFinalPromotion(candidateVersion, currentVersion);
}

function releaseVersion(release) {
  if (!release || release.draft === true || typeof release.tag_name !== 'string') return null;
  const version = release.tag_name.trim().replace(/^v/i, '');
  return parseVersion(version) ? version : null;
}

function selectPrereleaseUpdate(releases, currentVersion, releasesUrlPrefix) {
  if (!Array.isArray(releases)) return null;
  const eligible = releases
    .map((release) => ({ release, version: releaseVersion(release) }))
    .filter(({ version }) => version && isUpdateCandidate(version, currentVersion));
  if (eligible.length === 0) {
    return { updateAvailable: false, latestVersion: currentVersion, url: releasesUrlPrefix };
  }

  // A stable release wins over a Beta once it is eligible. Otherwise choose
  // the greatest SemVer candidate returned by GitHub, independent of API order.
  eligible.sort((a, b) => {
    const aStable = !isPrerelease(a.version);
    const bStable = !isPrerelease(b.version);
    if (aStable !== bStable) return aStable ? -1 : 1;
    return -(compareVersions(a.version, b.version) || 0);
  });
  const selected = eligible[0];
  return {
    updateAvailable: true,
    latestVersion: selected.version,
    url: isAllowedReleaseUrl(selected.release.html_url, releasesUrlPrefix)
      ? selected.release.html_url : releasesUrlPrefix,
  };
}

function defaultFetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`release check failed with HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) req.destroy(new Error('release response too large'));
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('release check timed out')));
    req.on('error', reject);
  });
}

// fetchJson is injectable so tests never touch the network. The release page
// URL is only trusted when it stays inside the releases allowlist; anything
// else falls back to the releases index.
async function checkForUpdate(currentVersion, fetchJson = defaultFetchJson) {
  try {
    const current = parseVersion(currentVersion);
    if (!current) return null;
    const endpoints = repositoryReleaseEndpoints(await fetchJson(REPOSITORY_API_URL));
    if (!endpoints) return null;
    if (current.prerelease.length > 0) {
      return selectPrereleaseUpdate(
        await fetchJson(endpoints.prereleasesApiUrl),
        current.normalized,
        endpoints.releasesUrlPrefix,
      );
    }

    const release = await fetchJson(endpoints.latestApiUrl);
    if (!release || typeof release.tag_name !== 'string') return null;
    const latestVersion = release.tag_name.trim().replace(/^v/i, '');
    const comparison = compareVersions(latestVersion, currentVersion);
    if (!latestVersion || comparison === null) return null;
    return {
      updateAvailable: comparison > 0,
      latestVersion,
      url: isAllowedReleaseUrl(release.html_url, endpoints.releasesUrlPrefix)
        ? release.html_url : endpoints.releasesUrlPrefix,
    };
  } catch {
    return null;
  }
}

// Automatic checks are throttled: at most one per interval, persisted across
// restarts via settings.updateCheckedAt. A missing/unparseable timestamp or a
// previous failed check (timestamp left at 0) means "check now".
function shouldAutoCheck(lastCheckedAt, now = Date.now(), intervalMs = AUTO_CHECK_INTERVAL_MS) {
  const last = Number(lastCheckedAt);
  if (!Number.isFinite(last) || last <= 0) return true;
  return now - last >= intervalMs;
}

class UpdateNotificationRuntime {
  constructor({ getVersion, check = checkForUpdate, readSettings, saveSettings, assertPersistence,
    runTransaction, onAvailable, openExternal, now = Date.now,
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    if (![getVersion, check, readSettings, saveSettings, assertPersistence, runTransaction,
      onAvailable, openExternal, now, setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn]
      .every(value => typeof value === 'function')) {
      throw new TypeError('Update notification dependencies are incomplete');
    }
    Object.assign(this, { getVersion, check, readSettings, saveSettings, assertPersistence,
      runTransaction, onAvailable, openExternal, now, setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn });
    this.latest = null;
    this.startupTimer = null;
    this.interval = null;
    this.timerEpoch = 0;
    this.started = false;
  }

  snapshot() { return this.latest; }

  async run(force = false) {
    if (!force && !shouldAutoCheck(this.readSettings().updateCheckedAt, this.now())) return null;
    const result = await this.check(this.getVersion());
    if (result) {
      // Keep the settings read inside the existing serialized context transaction:
      // a preference changed during the request must not be overwritten.
      await this.runTransaction(() => {
        this.assertPersistence();
        const settings = this.readSettings();
        return {
          commit: () => this.saveSettings({ ...settings, updateCheckedAt: this.now() }),
          rollback: () => this.saveSettings(settings),
        };
      });
    }
    if (result && result.updateAvailable) {
      this.latest = result;
      this.onAvailable();
    }
    return result;
  }

  open(url) {
    if (!isCurrentUpdateUrl(url, this.latest)) return { ok: false };
    this.openExternal(url).catch(() => {});
    return { ok: true };
  }

  startAutomatic(packaged) {
    if (!packaged || this.started) return false;
    this.started = true;
    const epoch = ++this.timerEpoch;
    const check = () => {
      if (this.started && epoch === this.timerEpoch) this.run().catch(() => {});
    };
    this.startupTimer = this.setTimeoutFn(() => {
      if (epoch !== this.timerEpoch) return;
      this.startupTimer = null;
      check();
    }, 5000);
    this.interval = this.setIntervalFn(check, AUTO_CHECK_INTERVAL_MS);
    this.interval.unref?.();
    return true;
  }

  stopAutomatic() {
    this.started = false;
    this.timerEpoch++;
    if (this.startupTimer !== null) this.clearTimeoutFn(this.startupTimer);
    if (this.interval !== null) this.clearIntervalFn(this.interval);
    this.startupTimer = null;
    this.interval = null;
  }
}


module.exports = {
  UpdateNotificationRuntime,
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
};
