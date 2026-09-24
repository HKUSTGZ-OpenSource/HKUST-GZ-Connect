'use strict';
const path = require('node:path');
const { runFixture } = require('./support/owned-electron-fixture');
runFixture({
  electron: require('electron'),
  stage: path.join(__dirname, 'browser-native-download.electron.js'),
  prefix: 'hkustgz-download-native-',
  marker: 'native DownloadItem save timing and active retirement: PASS',
}).then(() => {
  process.stdout.write('native download lifecycle: PASS (child closed, fixture removed)\n');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
