# Campus Browser viewport owner

- Status: Proposed M2 source owner contract; exact-head acceptance remains required
- Owner: Desktop / Browser maintainers
- Last verified: 2026-10-04
- Applies to: `BrowserViewportOwner` composed by `CampusBrowser`, after immutable v2.0.3
- Supersedes: viewport resize/find state inside the Browser orchestrator

## Boundary

The viewport owner lives beside the existing toolbar owners in
`desktop/lib/browser/toolbar/browser-toolbar-owner.js`. It owns only per-window find visibility,
one immediate resize handle and its invalidation generation. It does not own windows, tabs,
navigation intent, routes, cookies, credentials or workspace resources. Fixed toolbar/find heights
and current-window/current-tab/context ports are injected; no new production file, dependency,
public IPC channel, Renderer export, persisted schema or package resource is introduced.

`CampusBrowser` retains its `findOpen` and `scheduledLayout` diagnostic reads and void-returning
layout/find commands. Those facades delegate to the owner. Find matches remain per-tab, while
find visibility survives tab switching only within the same window. Opening focuses the existing
find input; closing clears the current tab's selection and restores page focus. Bounds, dimensions,
minimum sizes, markup, colors and motion preferences are unchanged.

## Lifecycle

- Resize bursts coalesce into one unreferenced immediate. Execution uses the live selected tab,
  rather than laying out a previously selected page. Only the active native view remains attached.
- Cancellation clears the owned handle and invalidates its generation before cancellation effects.
  A callback already queued before cancellation cannot clear or execute a replacement handle.
- Execution checks the same native window, destruction and current opaque Browser context.
  Retired contexts do not resize or focus even while their native window is still closing.
- Synchronous layout cancels queued resize first. Find state updates bounds before toolbar state
  and focus; a reentrant toolbar effect that retires the window cannot then focus it.
- Existing tab/window/close boundaries cancel scheduled updates. Window cleanup additionally resets
  find visibility. Reset is idempotent and ordinary reopen starts clean; context retirement remains
  terminal in the existing window owner. Tab/window/context ownership is not duplicated here.

## Verification scope

The source baseline is accepted `main@0e7eaf19ce2a15e2d0d273b6537a2b4445ebea8e`.
Six direct owner contracts cover geometry/find focus, coalescing/live tab, cancel/reset/late callback,
window/page/context retirement, configuration validation and synchronous focus retirement. The
existing Browser, toolbar and command contracts continue to exercise the production facades.
The new owner contract was red before implementation; no prior passing assertions were deleted.

The actual Electron toolbar fixture adds compact/standard/wide native view bounds and find toggles,
then closes/reopens a window and checks owned timer/find cleanup. It retains all existing toolbar,
workspace, route, keyboard and accessibility assertions. The fixture explicitly keeps Electron alive
after last-window closure so an exit without reaching the final marker cannot pass as this test.

Local full source suite: 1,999 tests, 1,983 passed, 16 platform skips, no failures. The initial full
run caught the stale Browser size contract; that assertion now matches a downward 1,094-line cap,
not a raised budget. Local native viewport/toolbar acceptance reached both final PASS markers.
Local native popup/password-MFA, strict proxy, tab retirement and routing-restart gates also pass.
The 20-tab offline performance fixture reports 100 switches (p95 1.6 ms, max 7.5 ms), 30/30 soak
views created/destroyed and zero terminal tab/view/slow-timer residue. These are synthetic blocked-
port measurements, not Gateway performance. Exact-head three-platform package acceptance remains
required; no local synthetic case establishes a real Gateway session or a signed release.

Browser orchestrator size falls from 1,122 to 1,094 lines; the whole-root M2 target remains open.
Main stays 662 / 20 direct / 35 effective / 170 transitive dependencies. No dependency/debt cap
or visibility is expanded. The new viewport owner is 80 lines, below the 600-line ceiling; the
larger Browser orchestrator still needs page/document and credential-command ownership work.

## Rollback and non-goals

Revert owner, Browser facades, direct/native contracts and downward cap together. There is no
data migration, installed-app replacement, routing update, new permission or protocol change.
Rolling back invalidation also restores the old late-resize callback risk; do not call that safe.
This is one independently reviewable M2 boundary, not complete M2/M1/M5 or original-report closure.
