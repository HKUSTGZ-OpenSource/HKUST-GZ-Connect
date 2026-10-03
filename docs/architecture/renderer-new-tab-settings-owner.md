# Renderer new-tab settings owner

- Status: Current merged bounded M1 owner; not a released UI redesign or complete Renderer bootstrap
- Owner: Desktop Renderer maintainers
- Last verified: 2026-10-03
- Applies to: merged #213; verified development `main@eb5a60743427286e5af5c6eafce48d4ddaa5b63d`, not v2.0.3

The new-tab address control now has one native feature entrypoint registered with
the existing feature host. The former classic HTML script and its frozen
`window.browserNewTabSettings` exception retire together. Dependencies are injected
through the feature factory, not global HTML order. No replacement global, generic
IPC method, persisted schema or new external network capability is introduced.

Existing input/button/status IDs, shared styles, translation keys, Bing default,
blank/default behavior, Main validation, click/Enter actions and bounded save patch
remain unchanged. Main still owns persistence/canonical results; the Renderer
projects them. Existing active-save concurrency behavior is not redesigned here.

The feature host owns exact click/keyboard listeners with start-once and terminal
idempotent disposal. Already submitted Main writes are not cancelled/undone; a
retired feature stops projecting late completion or rejection into its old DOM or
local settings. Cleanup attempts both listener removals and reports failure rather
than hiding it behind a no-op. This is lifecycle ownership, not a new save policy.

Baseline static contracts and the actual five-size control-shell suite pass before
movement, with screenshots outside Git. New native-seam tests initially cannot
load the absent entrypoint, then cover rendering, click/Enter, refusal, disposal,
retained callbacks, late outcomes and cleanup failure. Existing factory/export and
global/HTML boundary assertions are retained and updated to the migrated catalog.

The native shell fixture exercises click and real Chromium Return key input at
its narrow/minimum/default/wide/ultrawide sizes, checks focus/containment, restores
synthetic state, and keeps existing Reduced Motion and official/personal layout
contracts. Source, actual native/ASAR and exact-head platform checks remain separate
acceptance; fixture screenshots do not prove live-school behavior.

One legacy global/script dependency is removed. `app.js` grows four explicit
composition lines, rather than falsely claiming a root-line reduction; no cap is
raised. Shared UI styling remains untouched. M1 stays open for login/resource
algorithms and remaining global/HTML-order dependencies.

Rollback the migrated feature, bootstrap/catalog, retired script, tests and this
receipt together. No application replacement, user-data migration, Main/Engine
protocol, global networking or third-party configuration change.
