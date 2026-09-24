'use strict';

const path = require('node:path');
const { runFixture } = require('./support/owned-electron-fixture');

runFixture({
  electron: require('electron'),
  stage: path.join(__dirname, 'campus-popup-mfa-safety.electron.js'),
  prefix: 'hkustgz-popup-mfa-',
  marker: 'campus popup MFA assertions: PASS',
}).then(() => {
  process.stdout.write('campus popup MFA credential safety: PASS (child closed, profile removed)\n');
}).catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
