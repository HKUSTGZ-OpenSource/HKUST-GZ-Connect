# Notifications and help Renderer owner

- Status: Proposed bounded M1 migration; not full Renderer bootstrap completion
- Owner: Desktop Renderer maintainers
- Last verified: 2026-09-29
- Applies to: candidate based on development `main@1b962307a6af244738ed3c80cffbeba55f133811`, not published v2.0.3

Notifications and Help is now one native feature with an explicit `create` entrypoint mounted
through the existing feature host. Its pure recovery/status projection, diagnostic-log display,
drawer focus trap, action dispatch and Reduced Motion timing share one lifecycle. App injects
translation, bounded Preload `getLogs`, page navigation, reconnect and timer/media effects. The
feature reads no files or connection secrets and exports nothing through `window`.

The two former classic scripts, `notification-view.js` and `notification-drawer.js`, are retired
from HTML, the frozen legacy-global registry and the packaged application. The package verifier
requires `features/notifications/index.mjs` and rejects those retired globals. This lowers two
legacy global exceptions and two HTML-order dependencies without adding another Renderer
bootstrap or expanding an architecture budget. `app.js` remains 412 lines and still contains
other legacy feature composition; M1 remains open.

The visible summary, action labels and drawer markup/DOM IDs are unchanged. Keyboard Escape and
Tab trapping, focus return, 180 ms normal close and zero-delay Reduced Motion close are preserved.
The focus trap now excludes controls inside a closed diagnostic `<details>` element; Chromium
otherwise reports a layout box for its hidden Refresh button and Tab can escape the drawer.
The owner removes all listeners and cancels pending animation/timer work on page retirement; a
late log read cannot update the retired view. Reopening during a pending close cancels that close
instead of hiding the newly opened drawer.

Synthetic tests cover recovery categories, known actions, bilingual-key usage, focus trapping,
motion timing, lifecycle cleanup and stale log reads. Narrow/standard/wide native Renderer layout,
keyboard focus, overflow, package and exact-tree gates are required before merge. These checks do
not establish real school login, installed-app behavior or a new release.

Rollback the feature entrypoint, bootstrap wiring, registry/HTML retirement, package verifier,
tests and this record together. No IPC wire, persisted schema, Engine behavior or user data is
modified.
