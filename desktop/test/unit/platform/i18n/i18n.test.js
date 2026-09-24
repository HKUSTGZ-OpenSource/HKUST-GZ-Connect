'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const desktopRoot = path.resolve(__dirname, '..', '..', '..', '..');

const mainI18n = require('../../../../lib/platform/i18n/i18n');
const rendererI18n = require('../../../../renderer/i18n');

for (const [name, mod] of [['main', mainI18n], ['renderer', rendererI18n]]) {
  test(`${name} dictionaries have identical zh/en key sets`, () => {
    const zh = Object.keys(mod.dictionaries.zh).sort();
    const en = Object.keys(mod.dictionaries.en).sort();
    assert.deepEqual(en, zh);
  });

  test(`${name} resolveLocale maps zh* to zh, other explicit locales to en, blank to zh`, () => {
    assert.equal(mod.resolveLocale('zh-CN'), 'zh');
    assert.equal(mod.resolveLocale('zh-Hans-CN'), 'zh');
    assert.equal(mod.resolveLocale('ZH'), 'zh');
    assert.equal(mod.resolveLocale('en-US'), 'en');
    assert.equal(mod.resolveLocale('en'), 'en');
    assert.equal(mod.resolveLocale('fr-FR'), 'en');
    assert.equal(mod.resolveLocale(''), 'zh');
    assert.equal(mod.resolveLocale(undefined), 'zh');
    assert.equal(mod.resolveLocale(null), 'zh');
  });

  test(`${name} t interpolates {vars} and falls back to zh then to the key`, () => {
    const en = mod.createT('en');
    const zh = mod.createT('zh');
    const [key] = Object.keys(mod.dictionaries.zh);
    assert.equal(en(key), mod.dictionaries.en[key]);
    assert.equal(zh(key), mod.dictionaries.zh[key]);
    // unknown locale → zh dictionary
    assert.equal(mod.createT('klingon')(key), mod.dictionaries.zh[key]);
    // unknown key → the key itself, never undefined
    assert.equal(en('no.such.key'), 'no.such.key');
  });
}

test('effectiveLocale lets a saved zh/en override win over the OS locale', () => {
  assert.equal(mainI18n.effectiveLocale('en', 'zh-CN'), 'en');
  assert.equal(mainI18n.effectiveLocale('zh', 'en-US'), 'zh');
  assert.equal(mainI18n.effectiveLocale('auto', 'en-US'), 'en');
  assert.equal(mainI18n.effectiveLocale('auto', 'zh-CN'), 'zh');
  assert.equal(mainI18n.effectiveLocale(undefined, 'en-GB'), 'en');
  assert.equal(mainI18n.effectiveLocale('fr', undefined), 'zh');
});

test('main t interpolates named variables', () => {
  const en = mainI18n.createT('en');
  assert.equal(en('tray.status', { status: 'Connected' }), 'Status: Connected');
  // missing vars leave the placeholder untouched
  assert.equal(en('tray.status'), 'Status: {status}');
  assert.equal(mainI18n.createT('zh')('route.campus'), '校园隧道');
  assert.equal(en('route.campus'), 'Campus tunnel');
});

test('renderer t interpolates named variables', () => {
  const en = rendererI18n.createT('en');
  assert.equal(en('dialog.editing', { name: 'x' }), 'Editing: x');
  assert.equal(rendererI18n.createT('zh')('resources.saved'), '已添加到常用网站');
});

function markupKeys(file) {
  const html = fs.readFileSync(path.join(desktopRoot, 'renderer', file), 'utf8');
  const keys = new Set();
  for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) keys.add(match[1]);
  for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of match[1].split(';')) {
      const [, key] = pair.split(':').map((part) => part.trim());
      if (key) keys.add(key);
    }
  }
  return keys;
}

for (const file of ['index.html', 'campus-browser.html']) {
  test(`every data-i18n key in ${file} exists in the renderer dictionaries`, () => {
    const keys = markupKeys(file);
    assert.ok(keys.size > 10, `${file} should opt many strings into i18n`);
    for (const key of keys) {
      assert.ok(rendererI18n.dictionaries.zh[key], `zh dictionary missing ${key}`);
      assert.ok(rendererI18n.dictionaries.en[key], `en dictionary missing ${key}`);
    }
  });
}

test('both pages load i18n.js before their app script', () => {
  const renderer = (file) => fs.readFileSync(path.join(desktopRoot, 'renderer', file), 'utf8');
  for (const [file, appScript] of [['index.html', 'app.js'], ['campus-browser.html', 'campus-browser.js']]) {
    const html = renderer(file);
    assert.ok(html.indexOf('src="i18n.js"') !== -1, `${file} must load i18n.js`);
    assert.ok(html.indexOf('src="i18n.js"') < html.indexOf(`src="${appScript}"`),
      `${file} must load i18n.js before ${appScript}`);
    assert.match(html, /<script type="module" src="i18n.js"><\/script>/u);
    for (const [tag] of html.slice(html.indexOf('src="i18n.js"')).matchAll(/<script\b[^>]*>/gu)) {
      assert.ok(tag.includes('type="module"') || tag.includes('defer="defer"'),
        `${file}: consumers must not run before the localization module: ${tag}`);
    }
  }
});

test('main.js never shadows the module-level translator with a local t', () => {
  // Regression: onData once declared `const t = d.toString()`, shadowing the
  // translator and crashing the main process with "t is not a function".
  const main = fs.readFileSync(path.join(desktopRoot, 'main.js'), 'utf8');
  assert.doesNotMatch(main, /\bconst t =/);
});
