'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('capabilities stay Engine-owned and are not projected into the Control Tower', () => {
  const renderer = path.join(__dirname, '..', '..', '..', 'renderer');
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(renderer, 'app.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
  assert.doesNotMatch(html, /capabilitySummary|towerCapabilitySection|capability-presentation\.js/u);
  assert.doesNotMatch(app, /capabilitySnapshot|app-status-updated/u);
  assert.doesNotMatch(main, /capabilitySnapshot:\s*activeSchoolProfile\.capabilitySnapshot\(\)/u);
  assert.match(main, /activeSchoolProfile\.observeCapabilityReport\(report\)/u);
});
