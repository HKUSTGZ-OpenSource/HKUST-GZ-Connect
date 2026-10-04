# Campus Browser page presentation owner

- Status: Proposed M2 source contract; exact-head/native/package acceptance remains required
- Owner: Desktop / Browser maintainers
- Last verified: 2026-10-04
- Applies to: `BrowserPagePresentationOwner` after accepted source `main@367f66ce88ac1d0065a9e1fdfbb432290a876359`
- Supersedes: page observation, loading/failure presentation and listener lifetime inside `CampusBrowser`

## Ownership and placement

This distinct 212-line owner sits beside the existing chrome/toolbar/viewport owners in
`desktop/lib/browser/toolbar/browser-toolbar-owner.js`. Native page loading, title, crash and local
failure presentation feed that same Browser chrome. It owns a bounded record per existing page:
the exact native window, WebContents, tab membership, listeners and observation revisions.
It does not own native windows, tab allocation, navigation intent, routes, authentication, vault
transactions, cookies, workspace resources or browser Sessions. Those remain injected narrow ports.

The file has 606 lines across separate owners (page212, viewport80, toolbar112, command143) plus
existing pure presentation helpers; this is not falsely described as a sub-600-line file. The M2
ceiling applies to actual owners. No new production dependency node, generic utility layer,
barrel, IPC channel, Renderer/window export, schema, dependency or permission is added. Main stays
662/20 direct/35 effective/170 transitive; no budget or exception is expanded.

Browser facades and exported error helpers remain compatible. `escapeHtml`, `redactedFailedUrl`
and `errorPage` function source is byte-identical to the accepted baseline. Failed URLs stay on the
tab for retry; only their origin appears in the failure document. Colors, dimensions, markup,
locale behavior, motion preferences, URL safety and routing/login algorithms are not redesigned.

## Lifetime and effects

- Attach is idempotent. Every owned event listener is recorded exactly; detach removes only those
  listeners, invalidates admission first, clears the tab's existing slow timer and denies popups.
- Admission requires the same record/window/WebContents, live tab membership, unretired opaque
  Browser context and undestroyed native objects. Background tabs remain admitted; hidden means
  inactive presentation, not ownership retirement.
- The existing ten-second slow timer remains unreferenced and tab-owned for diagnostic reads.
  A late cancelled timer cannot set slow state, clear a replacement timer or schedule chrome work.
- Committed navigation preserves credential/page-route/portal effects. Recent-open completion may
  refresh Workspace only while the same page record/navigation revision remains current. No owned
  route or credential transaction is copied into this presentation class.
- Failure/provisional failure and renderer crash clear staged credentials through the original
  controller port, retain retry state, cancel slow work and render the same error document. Late
  crash feedback cannot target a replacement window or a recovered page.
- Window close/reset invalidates all page records before views close. Per-tab close detaches page
  observation and still runs credential-flow cleanup in `finally`. Managed MFA children stay in
  their existing owner, with shared Session/opener/postMessage/self-close/OTP behavior unchanged.
- Cleanup attempts every listener/record even after a failure. Failed records remain inactive and
  owned for retry; cleanup ambiguity throws rather than claiming retirement. Reset is idempotent.

## Source and native validation

Eight direct owner contracts cover subscription identity/foreign listeners, slow-handle replacement,
background and retired admission, asynchronous recent-open fencing, failure/crash cleanup, URL/
portal policy, destruction and retryable cleanup failure. The initial seven owner cases were red
before implementation. Existing Browser/toolbar/viewport contracts are retained (81 selected pass).
Credential lifecycle source checks now follow the actual owner and original controller ports rather
than assuming the moved handlers still live in the Browser root; clearing assertions remain.

Full local source suite: 2,007 cases, 1,991 passed, 16 platform skips, zero failures. Local native
toolbar/viewport now additionally proves real page-listener removal and late callback inertness
across close/reopen. It preserves compact/standard/wide geometry, keyboard and only-active-view
accessibility assertions. A first new native assertion mistakenly assumed no legitimate new-window
update was queued; the corrected contract checks unchanged replacement-handle identity, with no
timeout or geometry relaxation. A patch hunk-order mismatch was corrected atomically before tests.

Native popup/password MFA, strict proxy, tab retirement and routing restart pass. The synthetic
20-tab fixture records 100 switches (p95 1.2 ms, max 4.9 ms) and 30/30 soak views retired; terminal
tab/view/slow-timer counts are zero. These blocked-port measurements are not Gateway performance.
Exact-head Windows/Linux/native package and final-main acceptance remain required before closure.

Browser source falls 1,094->968 lines, actual orchestrator897->812; its cap ratchets downward.
The full M2 outcome remains open for credential command/sharing and remaining composition flows.
Already-invoked credential transactions are still their original owner's responsibility; page
admission does not falsely claim those asynchronous transactions have been audited or cancelled here.

## Rollback / boundaries

Revert the owner/facades, tests/native fixture, downward cap and contract link together. No user-data
migration, installed-App replacement, release/tag, real-school test or active Clash/network change.
Rolling back admission reintroduces late-page observation risks. Original reports, M1/M5, deferred
governance and the full repository goal remain separate; this slice does not close #80.
