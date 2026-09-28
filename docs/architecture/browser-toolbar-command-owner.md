# Browser toolbar command owner

- Status: Proposed bounded M2 extraction; not full Browser lifecycle ownership
- Owner: Desktop Browser maintainers
- Last verified: 2026-09-29
- Applies to: candidate based on development `main@6267547d4fe28e54551b9912259995d8a0762144`, not published v2.0.3

The existing Browser Toolbar module now includes a distinct `BrowserToolbarCommandOwner` for
validated toolbar commands and native page keyboard shortcuts. It consumes the same exact
`normalizeToolbarCommand` contract as the sandboxed toolbar Preload and calls only explicit,
injected Browser actions. Browser remains the composition point for navigation, Session,
credential and route effects; the command owner does not acquire a generic IPC bridge or direct
Engine/credential access.

The command owner keeps only the find query for the current Browser instance. The existing
presentation owner still coalesces and fences toolbar state updates across window teardown.
No new timer, listener or persistent state is introduced by the command owner; the page event
listener remains registered and retired through the existing tab/window lifecycle. Invalid
commands are rejected, and a failed route switch reports the same translated error.

The Browser orchestrator falls from 1,236 to 1,137 lines. The co-located Toolbar module is
262 lines, below the existing 600-line owner ceiling; Main's 170-module transitive dependency
cap and Browser routing authority are unchanged. M2 remains open for page-event and routing
activation ownership. Synthetic command tests cover payload rejection, tab/history dispatch,
find state, keyboard shortcuts and failed route feedback. Browser, MFA, strict-proxy,
performance/soak, exact-tree secret and package checks must pass before merge. These checks do
not establish real-school behavior or an installed-app update.

Rollback the command owner, Browser wiring, tests and this record as one change. No IPC wire,
persisted schema, user data, Engine behavior or published artifact is modified.
