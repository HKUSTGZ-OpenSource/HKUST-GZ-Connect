'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../../../main.js'), 'utf8');

test('Main delegates locale state and selection while retaining injected presentation effect order', () => {
  assert.match(source, /const desktopLocale = new DesktopLocaleRuntime\(\{\s*readSettings: loadSettings, getSystemLocale: \(\) => app\.getLocale\(\)/u);
  assert.match(source, /function currentLocale\(\) \{ return desktopLocale\.current\(\); \}/u);
  assert.match(source, /fallbackLocale: \(\) => desktopLocale\.fallback\(\)/u);
  assert.match(source, /setLocale: value => desktopLocale\.set\(value\)/u);
  assert.doesNotMatch(source, /let locale|let t =|createT\(|effectiveLocale\(/u);
  assert.match(source, /getTranslator: \(\) => desktopLocale\.translator/u,
    'owners receive the actual current translator, not a stable wrapper with changed identity');
  const start = source.indexOf('onLanguageChanged: (language) => {');
  const stop = source.indexOf('setStartAtLogin:', start);
  const effect = source.slice(start, stop);
  const order = ['desktopLocale.choose(language)', 'installApplicationMenu()',
    'campusBrowserManager.setLocale(desktopLocale.locale, desktopLocale.translator)', 'emit()']
    .map(marker => effect.indexOf(marker));
  assert.ok(order.every((value, index) => value >= 0 && (index === 0 || value > order[index - 1])));
});
