# Desktop settings transaction ownership

- Status: Proposed bounded M3 extraction; not full Main composition
- Owner: Desktop Persistence maintainers
- Last verified: 2026-09-29
- Applies to: candidate based on development `main@2eace99`, not published v2.0.3

`DesktopPersistenceRuntime` owns the cached routing-settings projection and close-action
commit/rollback factory. Main still captures the active Profile/Account/Workspace transaction token
through its existing queue and provides the queue runner as an injected effect. The previous
settings snapshot is read only when that queued factory executes, after admission; no request can
pre-read a stale Account's settings. The existing credential-recovery guard runs before mutations
and again at each commit/rollback save, matching the old Main sequence.

A settings write rebases the routing snapshot only after the underlying legacy or Profile Workspace
store confirms its commit. Failed writes preserve the old snapshot; rollback writes rebase it to the
restored document. This does not introduce a second settings schema or change Profile, Account,
Workspace, update, route, close-button or restart policy. Direct `saveSettings` remains available to
other Persistence callers with its existing semantics; Main explicitly uses the guarded/rebased
method. No filesystem paths, encrypted credential format, IPC payloads or Renderer state move.

Main retains thin compatibility callbacks for its existing consumers but no longer stores a second
mutable routing-settings snapshot or constructs the close-action transaction operations. The
candidate lowers Main from 864 to 845 lines. Direct/effective/transitive dependencies remain
30/44/170 and no architecture cap is raised. The below-800/24 and final M3 gates remain open.

Synthetic tests cover one-time routing projection, successful save rebase, failed-write preservation,
queue-time snapshot and commit/rollback order. Relevant native Main, Browser, migration, upgrade,
settings, package and exact-tree security gates must be recorded on the final candidate. Such tests
cannot establish a real Gateway connection or an installed-application migration.

Rollback this Runtime method addition, Main callbacks, contracts and this record together. User
data, installed applications, release tags and published packages remain untouched.
