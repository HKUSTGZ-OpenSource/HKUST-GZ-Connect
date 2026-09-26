# Campus Browser window owner

- Status: Proposed M2 owner extraction; not a release or complete Browser acceptance
- Owner: Desktop / Browser maintainers
- Last verified: 2026-09-27
- Applies to: `CampusBrowserWindowOwner` composed through `CampusBrowserManager`

## Boundary

`CampusBrowserWindowOwner` owns the Campus Browser chrome `BrowserWindow`: creation options,
toolbar-file loading and query, the allowlisted toolbar-command event binding, resize binding,
current-window identity, user close requests and context-switch close confirmation. `CampusBrowser`
supplies live profile/locale presentation and callbacks, and remains responsible for Browser-specific
cleanup of tabs, WebContentsViews, certificate prompts, downloads and managed credential popups.

The owner class lives in the existing `desktop/lib/browser/session/campus-browser-manager.js`
module. The `CampusBrowserManager` public entrypoint injects its factory into `CampusBrowser`;
`campus-browser.js` does not import its manager, and no new production graph node or runtime
dependency is added. Direct native fixtures use the same factory.

## Preserved contracts

- The chrome keeps its existing dimensions, localized school/trust title, parent policy and
  toolbar query. Its WebPreferences remain sandboxed, context-isolated, web-secure and without
  Node integration or DevTools.
- Only `campus-toolbar-command` reaches the existing command handler. This does not add a channel,
  expand Preload, or change Renderer behavior.
- The owner keeps the current window available while Browser cleanup detaches views, then clears
  that exact window. Repeated or stale close events cannot tear down a replacement window.
- Context switches still wait for the native `closed` event and fail closed at the existing bounded
  deadline. Missing/destroyed windows delegate cleanup to `CampusBrowser`.
- Managed MFA remains in the existing credential-popup path. It is not converted into a tab or
  moved to this owner; shared Electron Session, opener/postMessage/self-close behavior, and
  user-entered OTP handling are unchanged.
- Routing, Session cookies, login/credential algorithms, persisted state and user data are not
  moved or changed.

## Verification and rollback

The direct owner suite covers constrained window construction, command-channel filtering, resize
binding, teardown ordering and idempotence, stale-window fencing, and context-switch close
confirmation/deadline behavior. The full Node suite passed 1,610 tests (1,596 passed, 14
platform-conditioned skips, no failures). Local macOS Electron toolbar, popup-MFA credential
safety, strict-proxy, routing-restart, tab-retirement and workspace-layout fixtures passed. The
offline performance fixture measured 100 tab-switch samples (p95 1.6 ms, max 14.9 ms) and a
30-cycle soak (30/30 views created and destroyed; zero terminal tab/view/timer residue); all pages
used Chromium-blocked synthetic port 1, and the report explicitly says Gateway performance was
not measured. None is a live-school test.

The artifact package verifier was not run on this worktree because `desktop/engine` contains only
`.gitkeep`, not the exact-platform Engine, proxy and probe binaries required by `afterPack`. No
package or cross-platform acceptance is inferred from source or a different checkout.

The source-only candidate reduces `campus-browser.js` from the 1,502-line starting point to 1,476
lines without changing Main's measured 34 direct / 170 transitive production dependencies. The
owner remains below the M2 600-line ceiling. Revert the Browser owner integration, its direct tests
and fixture factory injection together; there is no schema migration, persistent-data change,
network-policy change or package artifact to roll back.
