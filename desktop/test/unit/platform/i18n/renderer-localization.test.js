'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../../../renderer/features/localization');
const native = require(root + '/index.mjs');
const { composeLocale, assertMatchingKeys } = require(root + '/compose.mjs');

test('proxy authentication copy preserves the shipped compatibility default in both languages', () => {
  assert.equal(native.createT('zh')('tower.strictProxyAuthSummary'),
    '新安装默认关闭，兼容 Clash、SSH 等本地代理客户端。');
  assert.equal(native.createT('en')('tower.strictProxyAuthSummary'),
    'Off by default on new installations for compatibility with Clash, SSH and other local proxy clients.');
  assert.match(native.createT('zh')('tower.strictProxyAuthHint'), /^默认关闭/);
  assert.match(native.createT('en')('tower.strictProxyAuthHint'), /^Off by default/);
});

test('locale chunks have one matching domain owner per language and matching keys per domain', async () => {
  const names = ['account','browser','common','connection','control-tower','resources','settings','workspace'];
  for (const locale of ['zh','en']) {
    assert.deepEqual(fs.readdirSync(path.join(root,'locales',locale)).sort(),names.map(name=>name+'.mjs'));
  }
  for (const name of names) {
    const dictionaries = {};
    for (const locale of ['zh','en']) {
      const file = path.join(root,'locales',locale,name+'.mjs');
      dictionaries[locale] = composeLocale([(await import(pathToFileURL(file).href)).default]);
    }
    assert.equal(assertMatchingKeys(dictionaries),true,name);
  }
  assert.equal(assertMatchingKeys(native.dictionaries),true);
});

test('composition rejects duplicate keys within and across files and malformed entries', () => {
  const entry = ['example.name','Name'];
  assert.throws(()=>composeLocale([[entry,entry]]),/duplicate/);
  assert.throws(()=>composeLocale([[entry],[entry]]),/duplicate/);
  for (const bad of [null,[],['missing.domain'],['example.name',null],['__proto__','bad'],['example.name','ok','extra']]) {
    assert.throws(()=>composeLocale([[bad]]),/invalid localization entry/);
  }
});

test('locale key mismatch is detected in either direction', () => {
  for (const en of [{}, {'example.name':'Name','example.extra':'Extra'}]) {
    assert.throws(()=>assertMatchingKeys({zh:{'example.name':'名称'},en}),/key mismatch/);
  }
});

test('legacy facade shares the native API and preserves effective weekly labels and fallback', () => {
  assert.ok(fs.readFileSync(path.resolve(root,'../../i18n.js'),'utf8').trimEnd().split('\n').length <= 8,
    'the compatibility bridge must not regain a feature-wide dictionary');
  const bridge = require('../../../../renderer/i18n');
  for (const key of ['applyStatic','createT','dictionaries','resolveLocale']) assert.equal(bridge[key],native[key]);
  assert.equal(native.createT('zh')('workspace.scheduleToday'),'本周');
  assert.equal(native.createT('en')('workspace.scheduleToday'),'This week');
  assert.equal(native.createT('unknown')('dialog.editing',{name:'测试'}),'正在编辑：测试');
  const original = native.dictionaries.en['dialog.editing'];
  try {
    delete native.dictionaries.en['dialog.editing'];
    assert.equal(native.createT('en')('dialog.editing',{name:'测试'}),'正在编辑：测试');
  } finally { native.dictionaries.en['dialog.editing'] = original; }
});
