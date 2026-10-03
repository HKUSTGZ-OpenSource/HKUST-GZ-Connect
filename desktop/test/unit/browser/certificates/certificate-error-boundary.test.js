'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { routeCertificateError } = require('../../../../lib/browser/certificates/certificate-controller');

test('unowned certificate errors retain Chromium default handling', () => {
  let prevented = 0;
  let callbacks = 0;
  const result = routeCertificateError({
    owned: false,
    isMainFrame: true,
    event: { preventDefault: () => { prevented++; } },
    callback: () => { callbacks++; },
    prompt: () => { throw new Error('must not prompt'); },
  });
  assert.deepEqual(result, { handled: false, prompted: false });
  assert.equal(prevented, 0);
  assert.equal(callbacks, 0);
});

test('owned subresource certificate errors fail closed without a dialog', () => {
  let prevented = 0;
  const answers = [];
  let prompts = 0;
  const result = routeCertificateError({
    owned: true,
    isMainFrame: false,
    event: { preventDefault: () => { prevented++; } },
    callback: (allowed) => answers.push(allowed),
    prompt: () => { prompts++; },
  });
  assert.deepEqual(result, { handled: true, prompted: false });
  assert.equal(prevented, 1);
  assert.deepEqual(answers, [false]);
  assert.equal(prompts, 0);
});

test('only an owned main-frame certificate error reaches the trust controller', async () => {
  let prevented = 0;
  let prompts = 0;
  const result = routeCertificateError({
    owned: true,
    isMainFrame: true,
    event: { preventDefault: () => { prevented++; } },
    callback: () => {},
    prompt: () => { prompts++; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(result, { handled: true, prompted: true });
  assert.equal(prevented, 1);
  assert.equal(prompts, 1);
});

test('unknown ownership and frame status never elevate certificate consent', () => {
  for (const owned of [undefined, null, false, 'true', 1]) {
    assert.deepEqual(routeCertificateError({ owned, isMainFrame: true }),
      { handled: false, prompted: false });
  }
  for (const isMainFrame of [undefined, null, false, 'true', 1]) {
    const answers = [];
    assert.deepEqual(routeCertificateError({ owned: true, isMainFrame,
      callback: value => answers.push(value), prompt: () => assert.fail('must not prompt'),
    }), { handled: true, prompted: false });
    assert.deepEqual(answers, [false]);
  }
});

test('missing prompt and throwing callbacks fail closed without escaping', () => {
  assert.deepEqual(routeCertificateError({ owned: true, isMainFrame: true,
    event: { preventDefault() { throw new Error('synthetic retired event'); } },
    callback(value) { assert.equal(value, false); throw new Error('synthetic retired callback'); },
  }), { handled: true, prompted: false });
});

for (const asynchronous of [false, true]) {
  test(`failed ${asynchronous ? 'async' : 'sync'} prompt rejects the certificate`, async () => {
    const answers = [];
    const result = routeCertificateError({ owned: true, isMainFrame: true,
      callback: value => answers.push(value),
      prompt: asynchronous
        ? async () => { throw new Error('synthetic prompt failure'); }
        : () => { throw new Error('synthetic prompt failure'); },
    });
    assert.deepEqual(result, { handled: true, prompted: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(answers, [false]);
  });
}
