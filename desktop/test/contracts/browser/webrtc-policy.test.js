'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('WebRTC direct UDP is disabled before Electron becomes ready', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
  const policy = source.indexOf("'force-webrtc-ip-handling-policy'");
  const value = source.indexOf("'disable_non_proxied_udp'", policy);
  const ready = source.indexOf('app.whenReady().then(');

  assert.ok(policy >= 0, 'missing WebRTC IP handling policy switch');
  assert.ok(value > policy, 'missing disable_non_proxied_udp policy value');
  assert.ok(ready > value, 'WebRTC policy must be configured before app.whenReady()');
});
