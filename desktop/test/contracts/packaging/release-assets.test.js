'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const desktopRoot = path.join(__dirname, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
const workflow = fs.readFileSync(path.join(desktopRoot, '..', '.github', 'workflows', 'build.yml'), 'utf8');
const ciWorkflow = fs.readFileSync(path.join(desktopRoot, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const localEngineBuild = fs.readFileSync(path.join(desktopRoot, 'scripts', 'build-engine.sh'), 'utf8');
const localMacRebuild = fs.readFileSync(path.join(desktopRoot, 'scripts', 'rebuild-mac.sh'), 'utf8');
const engineManifest = fs.readFileSync(path.join(desktopRoot, '..', 'independent', 'Cargo.toml'), 'utf8');
const packageVerifier = fs.readFileSync(path.join(desktopRoot, 'build', 'verify-package.js'), 'utf8');
const repositoryAttributes = fs.readFileSync(path.join(desktopRoot, '..', '.gitattributes'), 'utf8');
const releaseGuide = fs.readFileSync(path.join(desktopRoot, '..', 'RELEASING.md'), 'utf8');

test('cross-platform desktop checks use repository-owned source gates', () => {
  const start = workflow.indexOf('- name: Test desktop shell');
  const end = workflow.indexOf('- name: Test independent Rust engine', start);
  assert.ok(start >= 0 && end > start);
  const step = workflow.slice(start, end);
  assert.match(step, /shell:\s*bash/,
    'the remaining shell entry-point checks require Bash on every release runner');
  for (const source of [step, ciWorkflow]) {
    assert.match(source, /npm run check:syntax -- --tree "\$GITHUB_SHA"/u);
    assert.match(source, /npm run check:install-scripts/u);
    assert.doesNotMatch(source, /rg --files|done < <\(/u,
      'source gates must not silently depend on runner-provided ripgrep or process substitution');
  }
});

test('release guidance exposes only maintained macOS entry points', () => {
  assert.equal(
    fs.existsSync(path.join(desktopRoot, 'scripts', 'install-mac.sh')),
    false,
    'the retired ZIP/checksum installer must not return while releases publish DMGs only',
  );
  assert.doesNotMatch(ciWorkflow, /install-mac\.sh/u);
  assert.doesNotMatch(releaseGuide, /lib\/campus-browser\.js/u);
  assert.match(releaseGuide, /lib\/browser\/session\/campus-browser\.js/u);
});

test('cloud release policy publishes only macOS DMGs, Windows EXEs, and Linux AppImages', () => {
  assert.equal(manifest.build.mac.icon, 'build/icon.icns');
  assert.deepEqual(
    manifest.build.mac.target,
    [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    'macOS packaging must not generate ZIP releases',
  );
  assert.match(workflow, /Build \(macOS DMG\)/, 'cloud build needs a required DMG step');
  assert.match(workflow, /desktop\/release\/\*\.dmg/, 'cloud artifacts must include DMGs');
  assert.match(workflow, /desktop\/release\/\*\.exe/, 'cloud artifacts must include Windows EXEs');
  assert.match(workflow, /desktop\/release\/\*\.AppImage/, 'cloud artifacts must include Linux AppImages');
  assert.match(
    workflow,
    /os: ubuntu-latest\s+platform: linux/,
    'the release matrix must include a Linux runner',
  );
  assert.match(workflow, /ec-engine-linux-amd64/, 'the Linux engine must use the packaged name');
  assert.match(
    workflow,
    /ec-proxy-command-linux-amd64/,
    'the Linux SSH proxy helper must use the packaged name',
  );
  assert.match(workflow, /ec-gateway-probe-linux-amd64/,
    'the credential-free Gateway probe must use the packaged Linux name');
  assert.match(workflow, /npm run test:main-profile-switch/,
    'tag builds must gate recoverable Profile switching and relaunch');
  assert.match(workflow, /npm run test:main-school-onboarding/,
    'tag builds must gate the real School selector and custom Gateway onboarding');
  assert.match(workflow, /Build \(Linux AppImage x86_64\)/, 'cloud build needs a required AppImage step');
  assert.match(workflow, /release\/linux-unpacked\/resources linux x64/, 'the unpacked Linux package must be verified');
  assert.deepEqual(
    manifest.build.linux.target,
    [{ target: 'AppImage', arch: ['x64'] }],
    'Linux packaging must produce the portable x86_64 AppImage target',
  );
  assert.doesNotMatch(
    workflow,
    /--mac zip|\.zip|\.txt|\.blockmap|SHA256SUMS/i,
    'cloud release must not publish ZIP, text, checksum, or blockmap files',
  );
  assert.match(workflow, /no macOS DMG was produced/, 'a failed DMG build must fail the cloud job');
  assert.match(workflow, /no Linux AppImage was produced/, 'a failed AppImage build must fail the cloud job');
});

test('electron-builder never publishes implicitly from build jobs or local scripts', () => {
  for (const scriptName of ['dist', 'dist:mac', 'dist:win', 'dist:linux']) {
    assert.match(manifest.scripts[scriptName], /--publish never/u, scriptName);
  }
  const builderCommands = [workflow, localMacRebuild]
    .flatMap((source) => source.match(/[^\n]*npx electron-builder[^\n]*/gu) || []);
  assert.ok(builderCommands.length >= 2);
  for (const command of builderCommands) {
    assert.match(command, /--publish never/u, command);
  }
  assert.match(workflow, /release:[\s\S]*permissions:[\s\S]*contents: write/u);
  assert.match(workflow, /release:[\s\S]*softprops\/action-gh-release@/u);
  assert.match(
    localMacRebuild,
    /--config\.electronDist="\$HERE\/node_modules\/electron\/dist"/u,
    'local rebuilds must reuse the installed Electron runtime instead of downloading it again',
  );
});

test('ordinary CI gates popup MFA, exact-tree secrets and real Windows DACLs', () => {
  assert.match(ciWorkflow, /test:main-engine-lifecycle/u);
  assert.match(ciWorkflow, /test:main-profile-switch/u);
  assert.match(ciWorkflow, /test:main-school-onboarding/u);
  assert.match(workflow, /test:main-engine-lifecycle/u);
  assert.match(ciWorkflow, /test:campus-popup-mfa-safety/u);
  assert.match(
    ciWorkflow,
    /secret-scan:[\s\S]*check-sensitive-patterns\.js --tree "\$GITHUB_SHA"/u,
  );
  assert.match(workflow, /check:secrets -- --tree "\$GITHUB_SHA"/u);
  assert.match(ciWorkflow, /windows-private-file:[\s\S]*runs-on: windows-latest/u);
  assert.match(
    ciWorkflow,
    /test\/unit\/platform\/storage\/windows-private-file\.test\.js/u,
  );
  assert.match(ciWorkflow, /test\/unit\/integrations\/external-proxy-config\.test\.js/u);
  assert.match(
    ciWorkflow,
    /cargo clippy --locked --all-targets --no-default-features --features engine-lifecycle-fixture -- -D warnings/u,
  );
  assert.match(
    ciWorkflow,
    /cargo test --locked --no-default-features --features engine-lifecycle-fixture --test engine_success_lifecycle/u,
  );
});

test('ordinary CI exposes a stable three-platform package-verifier gate', () => {
  assert.match(ciWorkflow, /package-verifier-platform:[\s\S]*macos-latest/u);
  assert.match(ciWorkflow, /package-verifier-platform:[\s\S]*windows-latest/u);
  assert.match(ciWorkflow, /package-verifier-platform:[\s\S]*ubuntu-latest/u);
  assert.match(
    ciWorkflow,
    /package-verifier:[\s\S]*needs: package-verifier-platform[\s\S]*MATRIX_RESULT/u,
  );
});

test('package verification binds the reviewed school profile before signing', () => {
  assert.match(packageVerifier, /assertPackagedSchoolProfile\(archive,/u);
  assert.match(packageVerifier, /packaged external Engine config differs from its profile binding/u);
  assert.match(packageVerifier, /assets\/profiles\/manifest\.json/u);
  assert.match(packageVerifier, /lib\/profiles\/runtime\/school-profile-runtime\.js/u);
  assert.match(packageVerifier, /lib\/profiles\/runtime\/school-profile-controller\.js/u);
  assert.match(packageVerifier, /lib\/profiles\/deletion\/custom-profile-deletion-runtime\.js/u);
  assert.match(packageVerifier, /lib\/ipc\/control-state-snapshot\.js/u);
  assert.match(packageVerifier, /lib\/integrations\/atomic-export-file-transaction\.js/u);
  assert.match(packageVerifier, /lib\/resources\/schema\/campus-resource-contract\.js/u);
  assert.match(packageVerifier, /lib\/resources\/runtime\/resource-library-runtime\.js/u);
  assert.match(packageVerifier, /lib\/browser\/toolbar\/campus-toolbar-contract\.js/u);
  assert.match(packageVerifier, /assets\/profiles\/hkustgz\/builtin-resources\.json/u);
  assert.match(packageVerifier, /legacy duplicate campus resource asset entered the package/u);
  assert.match(packageVerifier, /retired third-party installer entered the package/u);
  assert.match(packageVerifier, /exposes a retired external-tool control/u);
  assert.match(packageVerifier, /packaged Desktop does not enforce private Engine profile binding/u);
  assert.match(packageVerifier, /packaged product does not expose safe Other-school onboarding/u);
  assert.match(packageVerifier, /assertPackagedSchoolProfiles\(archive,/u);
  assert.match(localEngineBuild, /stage-reviewed-profile-configs\.js/u);
  assert.doesNotMatch(workflow, /config\/hkustgz\.json \.\.\/desktop\/engine\/hkustgz\.json/u);
});

test('Electron gates exit nonzero on assertion failure', () => {
  for (const relativePath of [
    'e2e/main-engine-lifecycle.electron.js',
    'e2e/school-profile-asar.electron.js',
  ]) {
    const source = fs.readFileSync(path.join(desktopRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /app\.exitCode/u, relativePath);
    assert.match(source, /app\.exit\(1\)/u, relativePath);
  }
});

test('every byte-bound profile asset has deterministic LF checkout semantics', () => {
  for (const rule of [
    'desktop/assets/profiles/manifest.json text eol=lf',
    'desktop/assets/profiles/**/*.json text eol=lf',
    'desktop/assets/logo.svg text eol=lf',
    'independent/config/*.json text eol=lf',
  ]) assert.ok(repositoryAttributes.split(/\r?\n/u).includes(rule), rule);
});

test('every shipped Engine build excludes test-only Cargo features', () => {
  const releaseBuilds = workflow.match(/cargo build[^\n]+/gu) || [];
  const ordinaryCiBuilds = ciWorkflow.match(/cargo build[^\n]+/gu) || [];
  assert.ok(releaseBuilds.length >= 6);
  assert.ok(ordinaryCiBuilds.length >= 1);
  for (const command of [...releaseBuilds, ...ordinaryCiBuilds]) {
    assert.match(command, /--no-default-features/u);
    assert.doesNotMatch(command, /--features\s+engine-lifecycle-fixture/u);
  }
  assert.match(localEngineBuild, /cargo build --locked --release --no-default-features/u);
  assert.doesNotMatch(workflow, /--features\s+engine-lifecycle-fixture/u);
});

test('release builds strictly verify macOS signatures and smoke-test unpacked apps', () => {
  assert.match(workflow, /codesign --verify --deep --strict --verbose=2/u);
  assert.doesNotMatch(workflow, /electron-builder --mac dmg --arm64 --x64/u);
  assert.match(workflow, /stage_mac_engine arm64 aarch64-apple-darwin arm64/u);
  assert.match(workflow, /stage_mac_engine x64 x86_64-apple-darwin amd64/u);
  assert.match(
    workflow,
    /Smoke-test packaged macOS application[\s\S]*Contents\/MacOS\/hkustgzconnect/u,
  );
  assert.match(
    workflow,
    /Smoke-test packaged Windows application[\s\S]*release\\win-unpacked\\hkustgzconnect\.exe/u,
  );
  assert.match(
    workflow,
    /Smoke-test packaged Linux application[\s\S]*release\/linux-unpacked\/hkustgzconnect/u,
  );
  assert.match(
    workflow,
    /sandbox_helper="release\/linux-unpacked\/chrome-sandbox"[\s\S]*chown root:root[\s\S]*chmod 4755/u,
    'Linux unpacked smoke must configure Chromium sandbox ownership without changing the AppImage',
  );
  assert.match(
    workflow,
    /packaged Linux stderr \(tail\)[\s\S]*tail -n 120/u,
    'Linux smoke failures must retain bounded Chromium diagnostics',
  );
  assert.match(workflow, /softwareupdate --install-rosetta --agree-to-license/u);
  assert.match(workflow, /timeout --kill-after=2s 3s xvfb-run -a/u);
  assert.match(workflow, /HKUSTGZ_USER_DATA_DIR/u);
});

test('macOS native release binaries cannot depend on Homebrew libraries', () => {
  assert.match(
    engineManifest,
    /xz2\s*=\s*\{[^\n]*features\s*=\s*\["static"\]/u,
    'liblzma must be linked from vendored static source instead of host pkg-config',
  );
  assert.match(packageVerifier, /assertMacSystemOnlyDylibs\(executable\)/u);
  assert.match(packageVerifier, /packaged macOS native executable depends on a non-system dylib/u);
});

test('macOS packages verify every legacy and Retina icon layer has transparent corners', () => {
  assert.match(packageVerifier, /assertMacAppIcon\(appPath\)/u);
  assert.match(packageVerifier, /verify-macos-icon\.swift/u);
  const iconGenerator = fs.readFileSync(
    path.join(desktopRoot, 'scripts', 'make-icons.sh'),
    'utf8',
  );
  assert.match(iconGenerator, /assets\/hkust-gz-favicon\.png/u);
  assert.doesNotMatch(iconGenerator, /qlmanage/u);
});

test('initially-offline Main recovery is a named ordinary and tag-build Electron gate', () => {
  assert.equal(
    manifest.scripts['test:main-network-startup'],
    'electron e2e/main-network-startup.electron.js',
  );
  assert.match(ciWorkflow, /npm run test:main-network-startup/u);
  const macIntegration = workflow.slice(
    workflow.indexOf('- name: Exercise real Electron integration and browser soak'),
    workflow.indexOf('- name: Build independent engines (mac)'),
  );
  assert.match(macIntegration, /npm run test:main-network-startup/u);
});
