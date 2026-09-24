'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  PROXY_SECURITY_VERSION,
  MAX_SETTINGS_DOCUMENT_BYTES,
  loadSettings,
  normalizeSettings,
  saveSettings,
} = require('../../../../lib/persistence/settings/settings-store');
const { protectedStorageAvailable } = require('../../../../lib/persistence/credentials/credential-store');

test('settings normalization drops obsolete keys and bounds values', () => {
  assert.deepEqual(
    normalizeSettings({
      username: 'test-user',
      port: '2080',
      maxAttempts: 99,
      autoReconnect: false,
      startAtLogin: true,
      autoConnect: false,
      strictProxyAuth: true,
      proxySecurityVersion: PROXY_SECURITY_VERSION,
      proxyAuthMigrationPending: false,
      closeAction: 'minimize',
      language: 'en',
      server: 'untrusted.example',
      customDns: '1.2.3.4',
    }),
    {
      username: 'test-user',
      port: 2080,
      maxAttempts: 10,
      autoReconnect: false,
      startAtLogin: true,
      autoConnect: false,
      strictProxyAuth: true,
      proxySecurityVersion: PROXY_SECURITY_VERSION,
      proxyAuthMigrationPending: false,
      closeAction: 'minimize',
      language: 'en',
      browserNewTabUrl: 'https://www.bing.com/',
      underlaySourceAddress: '',
      updateCheckedAt: 0,
      routeDomains: [],
      customResources: [],
      hiddenBuiltinResourceIds: [],
    },
  );
});

test('underlay source selection is a bounded IP address or automatic', () => {
  assert.equal(normalizeSettings({}).underlaySourceAddress, '');
  assert.equal(normalizeSettings({ underlaySourceAddress: '192.0.2.15' }).underlaySourceAddress,
    '192.0.2.15');
  assert.equal(normalizeSettings({ underlaySourceAddress: 'adapter-name' }).underlaySourceAddress, '');
});

test('the language override is whitelisted to auto/zh/en', () => {
  assert.equal(normalizeSettings({}).language, 'auto');
  assert.equal(normalizeSettings({ language: 'zh' }).language, 'zh');
  assert.equal(normalizeSettings({ language: 'en' }).language, 'en');
  assert.equal(normalizeSettings({ language: 'fr' }).language, 'auto');
});

test('new tabs default to Bing while safe custom and blank pages remain canonical', () => {
  assert.equal(normalizeSettings({}).browserNewTabUrl, 'https://www.bing.com/');
  assert.equal(normalizeSettings({ browserNewTabUrl: 'example.com/start' }).browserNewTabUrl,
    'https://example.com/start');
  assert.equal(normalizeSettings({ browserNewTabUrl: 'about:blank' }).browserNewTabUrl,
    'about:blank');
  assert.equal(normalizeSettings({ browserNewTabUrl: 'file:///etc/passwd' }).browserNewTabUrl,
    'https://www.bing.com/');
});

test('profile route defaults apply only when settings do not contain a valid user value', () => {
  const options = { defaultRouteDomains: ['campus.example.edu'] };
  assert.deepEqual(normalizeSettings({}, options).routeDomains, ['campus.example.edu']);
  assert.deepEqual(
    normalizeSettings({ routeDomains: ['user.example.edu'] }, options).routeDomains,
    ['user.example.edu'],
  );
  assert.deepEqual(
    normalizeSettings({ routeDomains: ['bad/domain'] }, options).routeDomains,
    ['campus.example.edu'],
  );
});

test('invalid ports and retry counts use reviewed defaults', () => {
  const settings = normalizeSettings({ port: 80, maxAttempts: 1.5 });
  assert.equal(settings.port, 1080);
  assert.equal(settings.maxAttempts, 3);
  assert.equal(settings.strictProxyAuth, false);
  assert.equal(settings.proxySecurityVersion, PROXY_SECURITY_VERSION);
});

test('new installs default compatibility while explicit strict choices survive migration', () => {
  assert.equal(normalizeSettings({}).strictProxyAuth, false);
  assert.equal(normalizeSettings({ proxySecurityVersion: PROXY_SECURITY_VERSION }).strictProxyAuth, false);
  assert.equal(normalizeSettings({ strictProxyAuth: false }).strictProxyAuth, false,
    'an unversioned value follows the compatibility default');
  assert.equal(normalizeSettings({
    strictProxyAuth: true,
    proxySecurityVersion: 1,
  }).strictProxyAuth, false, 'the incompatible version-1 automatic opt-in is repaired');
  assert.equal(normalizeSettings({
    strictProxyAuth: false,
    proxySecurityVersion: 2,
  }).strictProxyAuth, false, 'the version-2 compatibility default remains compatible');
  assert.equal(normalizeSettings({
    strictProxyAuth: false,
    proxySecurityVersion: 2,
  }).proxyAuthMigrationPending, true,
  'the inherited compatibility default requires one explicit migration decision');
  assert.equal(normalizeSettings({
    strictProxyAuth: true,
    proxySecurityVersion: 2,
  }).strictProxyAuth, true, 'a version-2 explicit strict choice remains strict');
  assert.equal(normalizeSettings({
    strictProxyAuth: true,
    proxySecurityVersion: 2,
  }).proxyAuthMigrationPending, false);
  assert.equal(normalizeSettings({
    strictProxyAuth: false,
    proxySecurityVersion: PROXY_SECURITY_VERSION,
  }).strictProxyAuth, false, 'the current UI can explicitly select compatibility');
  assert.equal(normalizeSettings({
    strictProxyAuth: false,
    proxySecurityVersion: PROXY_SECURITY_VERSION,
    proxyAuthMigrationPending: true,
  }).proxyAuthMigrationPending, true, 'a pending decision survives unrelated settings saves');
  assert.equal(normalizeSettings({
    strictProxyAuth: true,
    proxySecurityVersion: PROXY_SECURITY_VERSION,
  }).strictProxyAuth, true, 'an explicit strict-authentication choice survives');
});

test('custom shortcut resources survive an owner-only settings round trip', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-settings-resources-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  const resource = {
    id: 'outlook',
    name: 'Outlook',
    description: '邮件',
    url: 'https://outlook.office.com/owa/',
    route: 'direct',
    category: 'custom',
    keywords: [],
  };

  saveSettings(file, { customResources: [resource] });
  assert.deepEqual(loadSettings(file).customResources, [resource]);
  if (process.platform !== 'win32') assert.equal((fs.statSync(file).mode & 0o777), 0o600);
});

test('port 6180 is written atomically and survives a reload', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');

  saveSettings(file, { port: 1080 });
  const saved = saveSettings(file, { port: '6180' });

  assert.equal(saved.port, 6180);
  assert.equal(loadSettings(file).port, 6180);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).port, 6180);
  assert.deepEqual(
    fs.readdirSync(directory).filter((entry) => entry.endsWith('.tmp')),
    [],
  );
});

test('a post-rename settings directory-fsync failure exposes its commit point', {
  skip: process.platform === 'win32',
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-settings-fsync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  const originalFsync = fs.fsyncSync;
  let calls = 0;
  t.after(() => { fs.fsyncSync = originalFsync; });
  fs.fsyncSync = (descriptor) => {
    calls++;
    if (calls === 2) throw Object.assign(new Error('simulated directory fsync failure'), {
      code: 'EIO',
    });
    return originalFsync(descriptor);
  };

  assert.throws(
    () => saveSettings(file, { port: 6180 }),
    (error) => error.commitApplied === true && /directory fsync/.test(error.message),
  );
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).port, 6180,
    'rename committed before durability confirmation failed');
});

test('credential storage rejects Linux plaintext backend', () => {
  const plaintext = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'basic_text',
  };
  assert.equal(protectedStorageAvailable(plaintext, 'linux'), false);
  assert.equal(protectedStorageAvailable(plaintext, 'darwin'), true);
});

test('update check throttle timestamp survives a save/load round trip', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-settings-throttle-'));
  const file = path.join(directory, 'settings.json');
  const saved = saveSettings(file, { updateCheckedAt: 1786100000000 });
  assert.equal(saved.updateCheckedAt, 1786100000000);
  assert.equal(loadSettings(file).updateCheckedAt, 1786100000000);
  assert.equal(normalizeSettings({}).updateCheckedAt, 0);
  assert.equal(normalizeSettings({ updateCheckedAt: 'not-a-number' }).updateCheckedAt, 0);
  assert.equal(normalizeSettings({ updateCheckedAt: -5 }).updateCheckedAt, 0);
});

test('corrupt settings are isolated and restored from the latest committed backup', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-settings-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');

  saveSettings(file, { username: 'first', port: 6180 });
  saveSettings(file, { username: 'second', port: 7200 });
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).port, 7200);
  fs.writeFileSync(file, '{broken-json', { mode: 0o600 });

  const notices = [];
  const recovered = loadSettings(file, { onRecovery: (notice) => notices.push(notice) });
  assert.equal(recovered.username, 'second');
  assert.equal(recovered.port, 7200);
  assert.equal(recovered.strictProxyAuth, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).port, 7200,
    'the recovered settings are restored to the primary path');
  const quarantined = fs.readdirSync(directory)
    .filter((entry) => entry.startsWith('settings.json.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, quarantined[0]), 'utf8'), '{broken-json');
  assert.deepEqual(notices, [{ kind: 'restored', quarantined: true }]);
});

test('unrecoverable settings report defaults but first launch stays silent', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-settings-default-notice-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  const notices = [];
  loadSettings(file, { onRecovery: (notice) => notices.push(notice) });
  assert.deepEqual(notices, []);
  fs.writeFileSync(file, '{broken');
  const recovered = loadSettings(file, { onRecovery: (notice) => notices.push(notice) });
  assert.equal(recovered.port, 1080);
  assert.deepEqual(notices, [{ kind: 'defaults', quarantined: true }]);
});

test('a missing primary is recovered from backup without creating a corrupt quarantine', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-settings-missing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  saveSettings(file, { port: 6180 });
  saveSettings(file, { port: 7200 });
  fs.unlinkSync(file);

  assert.equal(loadSettings(file).port, 7200);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).port, 7200);
  assert.equal(
    fs.readdirSync(directory).some((entry) => entry.includes('.corrupt-')),
    false,
  );
});

test('backup recovery preserves compatibility and explicit strict choices', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-settings-safe-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  fs.writeFileSync(`${file}.bak`, JSON.stringify({
    username: 'advanced-user',
    strictProxyAuth: false,
    proxySecurityVersion: 2,
    port: 6180,
  }), { mode: 0o600 });

  const recovered = loadSettings(file);
  assert.equal(recovered.port, 6180);
  assert.equal(recovered.strictProxyAuth, false);
  assert.equal(recovered.proxyAuthMigrationPending, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).strictProxyAuth, false);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).strictProxyAuth, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).proxySecurityVersion,
    PROXY_SECURITY_VERSION, 'the preserved choice is migrated to the current schema');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).proxyAuthMigrationPending, true);

  const legacyFile = path.join(directory, 'legacy-settings.json');
  fs.writeFileSync(`${legacyFile}.bak`, JSON.stringify({
    username: 'legacy-user',
    strictProxyAuth: false,
    port: 7200,
  }), { mode: 0o600 });
  const legacyRecovered = loadSettings(legacyFile);
  assert.equal(legacyRecovered.port, 7200);
  assert.equal(legacyRecovered.strictProxyAuth, false);
  assert.equal(legacyRecovered.proxySecurityVersion, PROXY_SECURITY_VERSION);
});

test('oversized and symbolic settings documents are isolated without unbounded reads', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-settings-bounds-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const oversized = path.join(directory, 'oversized.json');
  const target = path.join(directory, 'target.json');
  const link = path.join(directory, 'settings.json');
  fs.writeFileSync(oversized, 'x'.repeat(MAX_SETTINGS_DOCUMENT_BYTES + 1), { mode: 0o600 });
  fs.writeFileSync(target, JSON.stringify({ port: 6180 }), { mode: 0o600 });
  fs.symlinkSync(target, link);

  assert.equal(loadSettings(oversized).port, 1080);
  assert.equal(loadSettings(link).port, 1080);
  assert.equal(fs.existsSync(target), true, 'isolating a symlink must not move its target');
});

test('transient primary and backup I/O failures never collapse to defaults', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-settings-io-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  saveSettings(file, { username: 'preserved-user', port: 6180 });
  const originalOpen = fs.openSync;
  fs.openSync = (filePath, ...args) => {
    if (filePath === file || filePath === `${file}.bak`) {
      const error = new Error('temporarily unavailable');
      error.code = 'EIO';
      throw error;
    }
    return originalOpen(filePath, ...args);
  };
  try {
    assert.throws(() => loadSettings(file), (error) => error.code === 'EIO');
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).username, 'preserved-user');
});

test('a transient primary failure never restores a readable backup over it', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-settings-primary-io-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  saveSettings(file, { username: 'preserved-user', port: 6180 });
  const primaryBefore = fs.readFileSync(file, 'utf8');
  const originalOpen = fs.openSync;
  fs.openSync = (filePath, ...args) => {
    if (filePath === file) {
      const error = new Error('primary temporarily unavailable');
      error.code = 'EIO';
      throw error;
    }
    return originalOpen(filePath, ...args);
  };
  try {
    assert.throws(() => loadSettings(file), (error) => error.code === 'EIO');
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), primaryBefore);
});

test('a corrupt primary plus transient backup failure propagates the backup error', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-settings-backup-io-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  saveSettings(file, { username: 'preserved-user', port: 6180 });
  fs.writeFileSync(file, '{broken', { mode: 0o600 });
  const originalOpen = fs.openSync;
  fs.openSync = (filePath, ...args) => {
    if (filePath === `${file}.bak`) {
      const error = new Error('backup temporarily unavailable');
      error.code = 'EIO';
      throw error;
    }
    return originalOpen(filePath, ...args);
  };
  try {
    assert.throws(() => loadSettings(file), (error) => error.code === 'EIO');
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).username, 'preserved-user');
});
