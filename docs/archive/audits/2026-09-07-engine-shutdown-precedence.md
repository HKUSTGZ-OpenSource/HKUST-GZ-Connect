# Committed shutdown precedence regression

- Status: Local candidate regression receipt; not merged or released
- Owner: Rust Engine maintainers
- Verified: 2026-09-07
- Applies to: pre-listener connection-operation coordinator on macOS arm64
- Base: `a9e05f38d122e7c92be1aed225dc33cc5099e087`
- Scope: behavior fix separate from the preceding structural extraction

## Reproduction

A worker was made ready before entering the coordinator. A previously accepted shutdown deadline
was set at the existing 100 ms commitment boundary. The biased select polled the shutdown timer
first, but the newly constructed timer could still require registration with its time driver;
the already-ready worker then returned `Completed`. The stop boundary lost to result promotion.

The new `committed_shutdown_outranks_an_already_completed_worker` test failed on round zero of
the original implementation. Its command was:

```text
cargo test --locked --offline --no-default-features --bin ec-engine committed_shutdown_outranks -- --nocapture
```

The test failure was `committed shutdown lost to worker promotion at round 0`, not a network or
credential failure. This local synthetic evidence does not identify the cause of any user's
Windows SSH report or prove a real-campus failure frequency.

The adjacent operation-deadline branch had the same first-poll failure. The added
`elapsed_operation_deadline_outranks_a_completed_worker` regression also failed at round zero,
with `expired operation deadline lost to promotion at round 0`. It was run with the same Cargo
options and that test name as the filter, after fixing the shutdown-only case and before fixing
the operation deadline.

## Fix and regression boundaries

Before selecting among async events, compare the pending shutdown deadline with the current
monotonic time. If already elapsed, enter the existing user-requested cancellation and bounded
drain path. Do not change the 100 ms window, 500 ms drain timeout, capability/session contracts,
provider algorithms, signals, Event API, or persisted data. This matches the existing serving
coordinator's treatment of committed shutdown state.

The operation deadline remains in its existing select position, below signals and above control
frames and completion. Its future now returns immediately if the deadline is already elapsed;
otherwise it awaits the existing timer. This prevents promotion after operation expiry without
moving expiry ahead of a ready signal or changing either deadline duration.

The regression runs 32 iterations, including queued late cancel frames on alternate rounds, and
requires the completed worker result to be collected as cancelled rather than promoted. Another
test verifies that future and cancelled shutdown requests still permit a ready result. Existing
phase-transition, EOF, output-failure and non-cooperative-worker tests remain active.
The operation-expiry regression separately runs 32 iterations with a completed worker and an
elapsed operation deadline, requiring the result to be collected under `DeadlineExpired`.

Rollback the small pre-select guard and associated regression/specification clarification together;
the earlier structural extraction need not be reverted. No migration or installed-app replacement
is involved. A rollback restores the known race and is not a stability recommendation.

Windows/Linux execution, performance matrices, signed artifacts and real-school verification are
not established by this receipt. The candidate is local-first and does not trigger Actions.

## Local verification

Rust 1.97.1 on macOS arm64; existing shared target, locked offline dependencies and
`CARGO_INCREMENTAL=0`:

```text
cargo fmt --all -- --check
cargo clippy --locked --offline --all-targets --no-default-features -- -D warnings
cargo test --locked --offline --no-default-features
cargo clippy --locked --offline --all-targets --no-default-features --features engine-lifecycle-fixture -- -D warnings
cargo test --locked --offline --no-default-features --features engine-lifecycle-fixture
node --test desktop/test/unit/connection/state/stop-policy.test.js
```

Final default suite: 312 passed, zero failed, two performance matrices ignored. Final feature
suite: 314 passed, zero failed, the same two ignored, including the real-binary 100-round lifecycle
soak. Both deadline regressions and the future/cancelled negative case pass in both configurations.
Formatting and both Clippy configurations pass. Desktop stop-policy tests: three passed.
The operation owner remains below its 600-line cap (581 lines including tests); no budget was raised.
