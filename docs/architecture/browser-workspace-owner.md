# Browser workspace ownership

- Status: Proposed M2 owner extraction and retirement guards, pending review
- Owner: Desktop Browser maintainers
- Last verified: 2026-09-26
- Applies to: Browser-facing workspace behavior in `campus-workspace-controller.js`
- Base: `a6dca9b0c1baf0a2b2c370e05d3c3338aba8e8f4`

## Boundary

The existing Workspace module now exports `BrowserWorkspaceOwner` alongside the sandbox-view
controller. It owns Browser resource validation, group/bookmark projection, workspace refresh and
focus, and current-page favorite presentation/effects. The view controller continues to own its
existing sandbox view and bounded command/result protocol. No additional production module or npm
dependency is introduced, and no IPC surface is expanded.

Browser composition injects current resource/group providers, profile presentation, tab selection,
URL normalization, favorite mutation and UI effects. The owner never receives the Browser object,
Profile store, credential vault or routing manager. Getters preserve live provider/controller
replacement rather than snapshotting mutable state at construction. Favorite callback invocation
retains its original Browser receiver through the injected adapter.

The public Browser methods and exported `workspaceHomeResources` validator remain compatibility
delegates. Validation and command algorithms retain their existing behavior; stale completion
feedback is now suppressed at the owning Browser boundary.
Resource URLs stay inside Main; the bookmark-bar projection contains only IDs, names, folder
children and the official-entry flag. The two existing resource projections retain their different
DTO contracts rather than silently merging validation rules during extraction.

## Ratchets and evidence

Browser composition falls from 1,627 to 1,502 lines; its architecture gate is lowered accordingly.
The existing Workspace module is 554 lines and a direct regression test caps it at 600. Main retains
36 direct and 170 transitive dependencies. Root Desktop test debt stays at zero.

Existing Browser, Workspace protocol and toolbar tests remain. Direct owner tests cover invalid
and oversized provider batches, live-provider changes, bookmark privacy/order, workspace creation
and focus, loading deferral, layout recipients and favorite outcomes. Native workspace layout and
Browser toolbar/performance fixtures remain required in addition to the full Desktop and exact-tree
architecture, governance, install-script, syntax and secret checks.

Local macOS verification for this slice: `npm test` discovered 1,538 tests, with 1,524 passed,
14 platform-conditioned skips and no failures. Native `test:workspace-layout`,
`test:browser-tab-retirement`, `test:campus-popup-mfa-safety`, `test:strict-proxy-auth`,
`test:browser-native-download` and `test:browser-performance` passed. The synthetic 20-tab
fixture measured 1.6 ms switch p95 against the unchanged 250 ms disaster guard; its 50 native
views were all destroyed and no slow/credential timer remained. This is blocked-port/offline
Chromium evidence, not Gateway latency or live school authentication evidence.

## Deliberate non-goals and rollback

This extraction does not introduce a new persistence authority or change routing, Profile/Account
selection, MFA, cookies, credential storage, Renderer CSS or native packaging. It does not claim
M2 completion: Browser composition still exceeds 600 lines, and other owners remain to be separated.

This slice includes idempotent retirement, cancels scheduled focus,
clears only its owned loading-focus reservation and fences stale tab/selection/controller callbacks.
Confirmed context closure and explicit manager disposal retire the owner; a veto retains it. Late
favorite results and exceptions cannot publish old-context UI. This does not roll back an already
committed favorite mutation; its existing context-bound persistence owner remains authoritative.

The manager also binds Workspace command callbacks and bookmark-manager opens to the original
Browser identity. A completion cannot refresh or focus its replacement; commands from a retired
controller return a bounded stale result before invoking effects. Two new failing regressions
demonstrated these races before the identity checks were added. Unit tests and the native-view
fixture cover retirement; native Windows/Linux and real-campus evidence remain separate gates.

Revert the extraction, direct tests and lowered Browser ratchet together. There are no persisted
data changes to reverse. This local candidate is not merge, release, real-campus or platform approval.
