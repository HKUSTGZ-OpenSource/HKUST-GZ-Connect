# Campus Browser navigation owner

- Status: Proposed bounded M2 extraction; not full Browser lifecycle ownership
- Owner: Desktop Browser maintainers
- Last verified: 2026-09-29
- Applies to: candidate based on development `main@c5f91595744749aaf45ba40d973163c0de5d7927`, not published v2.0.3

`BrowserNavigationOwner` now owns tab-bound navigation intent, Home/New Tab, address navigation,
reload and the final page load. The Browser orchestrator supplies explicit URL normalization,
effective route, Session-readiness, tab identity and toolbar ports; it retains only forwarding
methods for its existing diagnostic/test surface. A readiness completion after a newer intent,
tab removal or renderer destruction cannot start a late load. The saved New Tab URL remains a
destination preference, not an implicit Direct-route override. A reviewed initial resource route
still survives the first load, while subsequent navigation resolves live Routing policy.

The owner class is temporarily co-located with the existing `BrowserTabLifecycle` in
`desktop/lib/browser/tabs/tab-manager.js`. Both share tab identity and retirement, and this
preserves the existing 170-module Main transitive dependency cap. It does not claim a distinct
production-file boundary. The tab file is 516 lines, below the existing 600-line per-owner cap;
the Browser orchestrator falls from 1,437 to 1,368 lines. Later M2 slices must continue to
reduce the Browser root without increasing architecture budgets.

Synthetic tests cover superseded/removed tab intents, late readiness, effective New Tab routing,
failed-page reload and malformed URL feedback. Existing Browser, tab teardown, popup MFA,
strict-proxy, performance and package checks are required before merge. No credential, Session,
IPC, persisted schema, Engine or installed application behavior is intentionally changed. These
checks do not prove a live school login or published-package behavior.

Rollback the owner class, Browser forwarding methods, tests and this record as one change.
