# Browser connection readiness through Connection owner

- Status: Proposed bounded M3 extraction; not full Main composition
- Owner: Desktop Connection maintainers
- Last verified: 2026-09-29
- Applies to: candidate based on development `main@0538277`, not published v2.0.3

The existing `ConnectionOperationCoordinator` in the public
`desktop/lib/connection/state/connection-state-machine.js` entrypoint now owns the two
Browser-specific readiness outcomes. Main injects its existing intent-bound
`ConnectionWaitRegistry.wait` callback and the same reviewed 75-second deadline. BrowserManager
still receives narrow `ensureCampusReady` (boolean request gate) and `ensureConnected` (open-result)
callbacks; it does not import the Engine or inspect state text. The Connection state machine,
generation/intent authority and wait registry remain their existing owners.

The two historical paths deliberately differ. The boolean request gate returns immediately on a
terminal failed connect when no connection remains in progress; a still-connecting intent waits.
The Browser-open result waits on the returned intent even if the immediate connect result is not
OK, then projects the existing last error or translated timeout. Both return immediately when
already connected. The candidate preserves those distinctions instead of replacing them with a
new inferred success state, polling loop or shorter timeout. Rejected wait operations still reject
and are handled by their existing callers.

Main keeps only callback injection and the deadline constant; its duplicate readiness functions
and inline open-result block are removed. It falls from 845 to 831 lines. The Connection public
entrypoint remains 562 lines, below the existing 600-line owner ceiling. Direct/effective/
transitive Main dependencies remain 30/44/170 and no architecture budget is raised. The
below-800/24 and final M3 targets, Browser-open request orchestration and M2 lifecycle work remain
open.

Synthetic tests cover already-connected fast paths, terminal failure, in-progress intent waiting,
error/timeout projection and propagated waiter failure. Existing Main/Browser/strict-proxy,
Profile-switch, routing-restart, Engine lifecycle, package and exact-tree secret gates must be
recorded on the final candidate. These checks do not prove real Gateway connection timing or
installed-version behavior.

Rollback the Connection owner methods, Main injection, contracts and this record together. No
wire protocol, IPC payload, persisted schema, credential, system route, release or user data changes.
