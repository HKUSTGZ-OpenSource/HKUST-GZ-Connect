'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  STOP_CONTROL_GRACE_MS,
  STOP_GRACE_MS,
  STOP_FORCE_WAIT_MS,
  stopPhase,
} = require('../../../../lib/connection/state/stop-policy');

function rustDurationMs(source, name) {
  const match = source.match(new RegExp(
    `const ${name}: Duration = Duration::from_(millis|secs)\\((\\d+)\\);`,
  ));
  assert.ok(match, `missing Rust duration constant ${name}`);
  const value = Number(match[2]);
  return match[1] === 'secs' ? value * 1000 : value;
}

test('stop policy allows the engine logout grace window before forcing it', () => {
  assert.equal(stopPhase(STOP_GRACE_MS - 1), 'grace');
  assert.equal(stopPhase(STOP_GRACE_MS), 'force');
  assert.equal(stopPhase(STOP_GRACE_MS + STOP_FORCE_WAIT_MS - 1), 'force');
  assert.equal(stopPhase(STOP_GRACE_MS + STOP_FORCE_WAIT_MS), 'failed');
});

test('stop policy accounts for the optional Control v2 grace window', () => {
  assert.equal(stopPhase(STOP_CONTROL_GRACE_MS - 1, { withControl: true }), 'control');
  assert.equal(stopPhase(STOP_CONTROL_GRACE_MS, { withControl: true }), 'grace');
  assert.equal(
    stopPhase(STOP_CONTROL_GRACE_MS + STOP_GRACE_MS, { withControl: true }),
    'force',
  );
  assert.equal(
    stopPhase(
      STOP_CONTROL_GRACE_MS + STOP_GRACE_MS + STOP_FORCE_WAIT_MS,
      { withControl: true },
    ),
    'failed',
  );
});

test('Engine cancellation and logout retain one second inside the control grace', () => {
  const repository = path.resolve(__dirname, '..', '..', '..', '..', '..');
  const operation = fs.readFileSync(path.join(repository, 'independent/src/bin/engine_app/operation.rs'), 'utf8');
  const control = fs.readFileSync(path.join(repository, 'independent/src/bin/engine_app/control.rs'), 'utf8');
  const session = fs.readFileSync(path.join(repository, 'independent/src/engine/session.rs'), 'utf8');
  const reviewedWorstCase = rustDurationMs(control, 'CONTROL_SHUTDOWN_CANCEL_WINDOW') +
    rustDurationMs(operation, 'CONNECTION_OPERATION_CANCEL_DRAIN_TIMEOUT') +
    rustDurationMs(session, 'LOGOUT_TIMEOUT');
  assert.ok(reviewedWorstCase + 1000 <= STOP_CONTROL_GRACE_MS,
    'Rust cleanup budgets must not drift into Desktop force termination');
});
