'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntegrationCenterRuntime } = require('../../../lib/integrations/integration-center-runtime');
const { createIntegrationBinding } = require('../../../lib/integrations/integration-schema');
const { createProfileNetworkRules } = require('../../../lib/integrations/profile-network-rules');
const { ensureProxyCredentialSidecar } = require('../../../lib/integrations/external-proxy-config');
const { validateGenericExportPayload } = require('../../../lib/integrations/generic-export-adapters');
const { verifyWindowsFileOwnerOnly } = require('../../../lib/platform/storage/windows-private-file');
const profile = require('../../../assets/profiles/hkustgz/school-profile.json');

test('native export roundtrip supports spaced Unicode paths for YAML and SSH', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, '学生 config');
  fs.mkdirSync(directory, { mode: 0o700 });
  const credentialFile = path.join(directory, 'proxy-credential');
  const target = path.join(directory, '校园配置.yaml');
  const helper = path.join(directory, `ec-proxy-command${process.platform === 'win32' ? '.exe' : ''}`);
  const rules = createProfileNetworkRules({ profileDocument: profile });
  const credential = { withStrings: fn => fn('A'.repeat(32), 'B'.repeat(32)) };
  let copied = '';
  const runtime = createIntegrationCenterRuntime({
    helperPath: helper, credentialFile,
    selectTarget: async () => target,
    ensureSidecar: () => ensureProxyCredentialSidecar({ filePath: credentialFile, port: 6180,
      credential, profileId: 'hkustgz' }),
    writeClipboard: text => { copied = text; return true; },
    getContext: adapterId => ({ networkRules: rules, port: 6180, credential,
      bindingFor: () => createIntegrationBinding({
        adapterId, adapterVersion: 1, recordRevision: 1,
        profileId: rules.profileId, profileRevision: rules.profileRevision,
        profileCredentialBindingRevision: rules.profileCredentialBindingRevision,
        accountKey: `account-${'a'.repeat(32)}`, accountRevision: 1, accountCredentialRevision: 1,
        workspaceKey: `workspace-${'b'.repeat(32)}`, activeContextEpoch: 1,
        listenerKind: 'socks5-optional-authentication', loopbackHost: '127.0.0.1', loopbackPort: 6180,
        proxySecurityRevision: 3, credentialRef: `credential-${'c'.repeat(32)}`,
        networkRulesDigest: rules.rulesDigest, pacDigest: 'd'.repeat(64), engineGeneration: 1,
      }),
    }),
  });
  for (const [adapterId, action] of [['clash_mihomo_yaml', 'copy'], ['clash_mihomo_yaml', 'save'],
    ['vscode_remote_ssh', 'copy']]) {
    const preview = await runtime.prepare({ adapterId, action });
    const result = await runtime.confirm({ confirmationHandle: preview.confirmationHandle });
    assert.equal(result.ok, true, `${adapterId}/${action}`);
    const payload = action === 'save' ? fs.readFileSync(target) : Buffer.from(copied);
    assert.equal(validateGenericExportPayload(adapterId, payload), true);
    if (adapterId === 'vscode_remote_ssh') {
      assert.ok(fs.existsSync(credentialFile));
      assert.ok(!copied.includes('B'.repeat(32)));
    }
  }
  if (process.platform === 'win32') {
    assert.equal(verifyWindowsFileOwnerOnly(target), true);
    assert.equal(verifyWindowsFileOwnerOnly(credentialFile), true);
  }
});
