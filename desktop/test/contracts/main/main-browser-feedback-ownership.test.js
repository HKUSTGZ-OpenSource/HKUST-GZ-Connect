'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '../../../main.js'), 'utf8');

test('Main delegates Control and shell open feedback to the public Browser owner', () => {
  assert.match(main, /openCampusBrowser: \(request\) => campusBrowserManager\.openWithFeedback\(request\)/u);
  assert.match(main, /openCampusBrowser: \(\) => campusBrowserManager\.openWithFeedback\(\)/u);
  assert.doesNotMatch(main, /connectAndOpenCampusBrowser|await campusBrowserManager\.open\(/u);
  assert.match(main, /reportError: \(message\) => \{\s*state\.browserNotice = message;\s*emit\(\);\s*\}/u);
  assert.match(main, /openRequest: \(request\) => campusBrowserManager\.open\(request\)/u,
    'resource-library opening must retain its original feedback-free contract');
});
