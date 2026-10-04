# Queued startup auto-connect cancellation

- Status: Proposed source repair for reproduced issue #235; not a release claim
- Owner: Desktop Connection maintainers
- Last verified: 2026-10-04 (offline owner/FSM and local native Electron fixtures)
- Applies to: NetworkStartupCoordinator's initially-online delayed auto-connect

The delayed timer previously checked its startup epoch, quit observation and
eligibility before enqueueing a Promise continuation, but the continuation called
connect without rechecking. Cancellation between timer execution and the queued
continuation could therefore create a new user connection intent after disconnect.
The actual OperationCoordinator/FSM with a fake attempt reproduced one unexpected
launch and desiredConnected becoming true. No real Gateway or Engine was involved.

The existing startup owner now rechecks the captured epoch, disposal/quit and
exact-true current eligibility immediately before calling connect in the queued
continuation. Stale work returns undefined through the existing promise/error
boundary. It does not create a new owner, module, timer, dependency or IPC method.
The live delayed path, single-flight startup, offline intent recovery, cancellation
API, strict boolean admission, baseline deadline and timer delay remain unchanged.
Eligibility must be re-read at execution; a settings-read error remains fail-closed.

Regression coverage distinguishes cancellation before timer firing (existing)
from cancellation after firing but before execution (new). The latter includes
cancel, terminal dispose, quit, eligibility becoming false and read failure, plus
the live case. A real OperationCoordinator/FSM case preserves the user stop intent
without a launch. Native Main startup captures its real public startup capabilities
and tests the same queued cancellation through an isolated coordinator/timer; the
unchanged prior offline/online/manual recovery assertions remain in that fixture.
Synthetic child generation count is unchanged after cancellation, not inferred
from a mocked success. This is not an installed-app or live-school result.

Rollback removes the queued execution guard and matching tests together. There is
no stored-data migration or wire/schema change, but rollback restores the observed
late auto-connect risk. No system proxy, DNS, route, installed Clash selection or
user data is modified. Published 2.0.3 is not silently changed. M3/M1/M2/M5 and
the original reporter issues remain separate acceptance work.
