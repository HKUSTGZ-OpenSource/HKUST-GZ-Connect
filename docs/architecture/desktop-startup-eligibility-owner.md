# Desktop startup eligibility ownership

- Status: Proposed bounded Connection extraction for M3; not full M3/M5 completion
- Owner: Desktop Connection maintainers
- Last verified: 2026-10-04 (local source and synthetic native checks)
- Applies to: initial auto-connect admission in the existing network startup module

`createStartupAutoConnectEligibility` lives in the existing public network startup
entrypoint. Main supplies settings-read and persistent-credential presence effects,
then injects the returned predicate into the existing `shouldAutoConnect` capability.
The coordinator/system API, network baseline, timers, epochs, cancellation, offline
handoff and recovery paths remain unchanged. No second eligibility implementation,
constructor fallback or alternative authority is added.

Factory construction validates functions without invoking them. Each predicate
evaluation retains the old left-to-right sequence: settings read, exact-false
auto-connect check, nonempty username, then persistent presence. It does not open,
decrypt, probe secure storage or consume staged credentials. Dynamic settings and
presence are read at evaluation, not snapshotted at construction. Memory-only
credentials do not authorize cross-launch auto-connect.

The predicate preserves the original return value and failure: it neither coerces
the presence result nor catches reader errors. The unchanged coordinator's
`eligible()` owns strict-true admission and fail-closed exception handling. Missing
settings still fail rather than becoming permissive defaults. No new retry,
timeout, event, connection-intent or user-facing policy is introduced.

The coordinator and monitor class bodies and `createNetworkStartupSystem` body are
byte-identical. Main removes only its now-unused presence facade and predicate;
other credential helpers are not cleaned up in this slice. Main falls 667 to 666
lines with the budget lowered; direct/effective/transitive metrics remain 20/35/170
and private-edge cap 98. No new production module, dependency, barrel, IPC, persisted
schema, credential or system-network mutation is involved.

Four new factory/coordinator cases fail before the factory exists, then pass for
effect-free construction, capability validation, short-circuit/read order,
dynamic values, uncoerced results and preserved failure/fail-closed admission.
The portable owner integration in the existing Windows-selected test file evaluates
Main's actual factory wiring with the existing credential owner and covers
persistent vs staged memory with injected presence and forbidden secret reads;
it does not claim actual protected-storage decryption was tested. The actual Electron initial
network startup fixture captures that public factory in its test process and
retains all offline/online/generation/manual-connect assertions and deadlines.
Native/platform results remain distinct from source tests and live-school evidence.

Rollback factory/Main/test and downward budget together; no stored-data migration
is needed. Published 2.0.3, installed app and system network remain unchanged. Exact
primary-only shared-portal credential eligibility and final Main semantic/public
entrypoint review remain separate M3 work; size targets alone do not close the goal.
