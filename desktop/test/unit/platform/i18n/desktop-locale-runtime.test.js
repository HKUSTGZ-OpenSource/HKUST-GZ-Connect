'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { DesktopLocaleRuntime, createT } = require('../../../../lib/platform/i18n/i18n');

function fixture() {
  const calls = [], state = { language: 'auto', system: 'en-US', settingsFailure: null, systemFailure: null };
  const owner = new DesktopLocaleRuntime({
    readSettings: () => { calls.push('settings'); if (state.settingsFailure) throw state.settingsFailure;
      return { language: state.language }; },
    getSystemLocale: () => { calls.push('system'); if (state.systemFailure) throw state.systemFailure;
      return state.system; },
  });
  return { owner, calls, state };
}

test('locale construction is effect-free and keeps the existing early Chinese fallback', () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  assert.equal(f.owner.locale, 'zh');
  assert.equal(f.owner.translator('route.campus'), createT('zh')('route.campus'));
  assert.equal(f.owner.translator, f.owner.translator);
  assert.equal(f.owner.translator('unknown-key'), 'unknown-key');
});

test('current locale preserves saved-choice precedence, fresh OS reads and evaluation order', () => {
  const f = fixture();
  for (const [language, system, expected] of [
    ['en', 'zh-CN', 'en'], ['zh', 'en-US', 'zh'], ['auto', 'zh-Hans-CN', 'zh'],
    ['auto', 'en-US', 'en'], [undefined, 'fr-FR', 'en'], ['unexpected', '', 'zh'],
  ]) {
    Object.assign(f.state, { language, system }); f.calls.length = 0;
    assert.equal(f.owner.current(), expected);
    assert.deepEqual(f.calls, ['settings', 'system']);
    assert.equal(f.owner.locale, 'zh', 'selection does not publish startup state itself');
  }
});

test('fallback asks only the current OS reader and retains blank-to-Chinese policy', () => {
  const f = fixture();
  assert.equal(f.owner.fallback(), 'en');
  assert.deepEqual(f.calls, ['system']);
  f.state.system = ''; f.calls.length = 0;
  assert.equal(f.owner.fallback(), 'zh');
  assert.deepEqual(f.calls, ['system']);
});

test('startup set and language selection preserve actual translator function identities', () => {
  const f = fixture(), early = f.owner.translator;
  f.owner.set('en');
  assert.deepEqual(f.calls, []);
  assert.equal(f.owner.locale, 'en');
  assert.notEqual(f.owner.translator, early);
  assert.equal(early('route.campus'), createT('zh')('route.campus'));
  const english = f.owner.translator;
  f.state.system = 'zh-CN';
  f.owner.choose('auto');
  assert.deepEqual(f.calls, ['system']);
  assert.equal(f.owner.locale, 'zh');
  assert.equal(english('route.campus'), createT('en')('route.campus'));
  const chinese = f.owner.translator;
  f.owner.choose('zh');
  assert.notEqual(f.owner.translator, chinese, 'existing setters rebuild even for the same locale');
});

test('read failures keep original causes and do not mutate published locale/translator', () => {
  const f = fixture();
  f.owner.set('en'); const before = f.owner.translator;
  const failure = new Error('synthetic settings failure'); f.state.settingsFailure = failure;
  assert.throws(() => f.owner.current(), error => error === failure);
  assert.deepEqual(f.calls, ['settings']);
  assert.equal(f.owner.translator, before);
  f.state.settingsFailure = null; f.calls.length = 0;
  const osFailure = new Error('synthetic OS locale failure'); f.state.systemFailure = osFailure;
  assert.throws(() => f.owner.choose('zh'), error => error === osFailure);
  assert.equal(f.owner.locale, 'en');
  assert.equal(f.owner.translator, before);
  assert.deepEqual(f.calls, ['system']);
});

test('invalid construction fails before consulting readers and set keeps primitive fallback semantics', () => {
  assert.throws(() => new DesktopLocaleRuntime({}), TypeError);
  assert.throws(() => new DesktopLocaleRuntime({ readSettings() {}, getSystemLocale: null }), TypeError);
  const f = fixture();
  f.owner.set('unexpected');
  assert.equal(f.owner.locale, 'unexpected');
  assert.equal(f.owner.translator('route.campus'), createT('zh')('route.campus'));
  assert.deepEqual(f.calls, []);
});
