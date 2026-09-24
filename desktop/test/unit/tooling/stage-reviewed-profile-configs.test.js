'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  reviewedProfileConfigs,
  stageReviewedProfileConfigs,
} = require('../../../scripts/stage-reviewed-profile-configs');

const desktopRoot = path.resolve(__dirname, '..', '..', '..');

test('reviewed Profile staging follows the manifest instead of a hardcoded HKUST copy', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-profile-stage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'stale-profile.json'), '{}');
  const configs = reviewedProfileConfigs({ desktopRoot });
  assert.deepEqual(configs.map(({ profileId, filename }) => ({ profileId, filename })), [
    { profileId: 'hkustgz', filename: 'hkustgz.json' },
  ]);
  const staged = stageReviewedProfileConfigs({ desktopRoot, engineDirectory: directory });
  assert.deepEqual(staged, [{ profileId: 'hkustgz', filename: 'hkustgz.json' }]);
  assert.equal(fs.existsSync(path.join(directory, 'stale-profile.json')), false);
  assert.deepEqual(
    fs.readFileSync(path.join(directory, 'hkustgz.json')),
    fs.readFileSync(path.join(desktopRoot, 'assets', 'profiles', 'hkustgz', 'engine-config.json')),
  );
});
