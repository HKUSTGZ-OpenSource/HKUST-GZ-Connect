'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..', '..', '..', '..');
const library = path.join(root, 'tools', 'mac-cli', 'proxy-credential.sh');

function bash(script, env = {}) {
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('CLI proxy credential is stable, owner-only, endpoint-aware, and never printed', (t) => {
  if (process.platform === 'win32') {
    t.skip('the root CLI is macOS-only');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-cli-proxy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'credential');
  const first = bash(`
    source "$LIBRARY"
    cli_proxy_load_or_create "$CREDENTIAL" 127.0.0.1:6180 || exit 1
    first_user="$CLI_PROXY_USERNAME"; first_pass="$CLI_PROXY_PASSWORD"
    cli_proxy_clear
    cli_proxy_load_or_create "$CREDENTIAL" 127.0.0.1:6180 || exit 2
    [ "$CLI_PROXY_USERNAME" = "$first_user" ] || exit 3
    [ "$CLI_PROXY_PASSWORD" = "$first_pass" ] || exit 4
    cli_proxy_load_or_create "$CREDENTIAL" 127.0.0.1:7200 || exit 5
    [ "$CLI_PROXY_ENDPOINT" = 127.0.0.1:7200 ] || exit 6
    [ "$CLI_PROXY_USERNAME" = "$first_user" ] || exit 7
    [ "$CLI_PROXY_PASSWORD" = "$first_pass" ] || exit 8
    printf 'ok:%s:%s\n' "$(cli_proxy_file_mode "$CREDENTIAL")" "$(cli_proxy_file_links "$CREDENTIAL")"
  `, { LIBRARY: library, CREDENTIAL: file });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, 'ok:600:1\n');
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, 4,
    'three fields plus the required final LF');

  fs.chmodSync(file, 0o644);
  const unsafe = bash(`
    source "$LIBRARY"
    cli_proxy_load_or_create "$CREDENTIAL" 127.0.0.1:7200
  `, { LIBRARY: library, CREDENTIAL: file });
  assert.notEqual(unsafe.status, 0);
  assert.equal(unsafe.stdout, '');
  assert.doesNotMatch(unsafe.stderr, /username|password|127\.0\.0\.1/);

  fs.chmodSync(file, 0o600);
  const hardLink = `${file}.hard`;
  fs.linkSync(file, hardLink);
  const linked = bash(`
    source "$LIBRARY"
    cli_proxy_load_or_create "$CREDENTIAL" 127.0.0.1:7200
  `, { LIBRARY: library, CREDENTIAL: file });
  assert.notEqual(linked.status, 0, 'a multi-link credential must fail closed');
  fs.unlinkSync(hardLink);

  const target = `${file}.target`;
  fs.renameSync(file, target);
  fs.symlinkSync(target, file);
  const symbolic = bash(`
    source "$LIBRARY"
    cli_proxy_load_or_create "$CREDENTIAL" 127.0.0.1:7200
  `, { LIBRARY: library, CREDENTIAL: file });
  assert.notEqual(symbolic.status, 0, 'a credential symlink must fail closed');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('root CLI always uses strict stdin auth and its authenticated helper', () => {
  const source = fs.readFileSync(path.join(root, 'hkustgzconnect'), 'utf8');
  const reviewedConfig = fs.readFileSync(path.join(root, 'independent', 'config', 'hkustgz.json'));
  const expectedDigest = crypto.createHash('sha256').update(reviewedConfig).digest('hex');
  const declaredDigest = source.match(
    /^REVIEWED_ENGINE_CONFIG_SHA256="([0-9a-f]{64})"$/mu,
  )?.[1];
  const manifest = JSON.parse(fs.readFileSync(path.join(
    root, 'desktop', 'assets', 'profiles', 'manifest.json',
  ), 'utf8'));
  const manifestDigest = manifest.profiles.find(
    ({ profileId }) => profileId === 'hkustgz',
  )?.assets.find(
    ({ kind }) => kind === 'engine-config',
  )?.sha256;
  assert.equal(declaredDigest, expectedDigest);
  assert.equal(declaredDigest, manifestDigest);
  assert.match(source, /source "\$PROXY_CREDENTIAL_LIBRARY"/);
  assert.match(source, /--socks-auth-stdin/);
  assert.match(source, /--profile-binding-v1-stdin/);
  assert.match(source, /"protocolFamily":"easyconnect-password-modern-l3-v1"/u);
  assert.doesNotMatch(source, /shasum[^\n]*ENGINE_CONFIG/u);
  assert.ok(source.indexOf('printf -v binding_frame') < source.indexOf('pw="$(get_pw)"'));
  assert.ok(source.indexOf('engine_config_binding') < source.indexOf('printf \'%s\\n\' "$ACC"'));
  assert.match(source, /printf '%s\\n' "\$CLI_PROXY_USERNAME"/);
  assert.match(source, /printf '%s\\n' "\$CLI_PROXY_PASSWORD"/);
  assert.match(source, /"\$PROXY_HELPER" --credential-file "\$PROXY_CREDENTIAL"/);
  assert.doesNotMatch(source, /nc -X 5 -x/);
});
