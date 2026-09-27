# Connection overview Renderer ownership

- Status: Proposed M1 lifecycle contribution, not complete Renderer migration
- Owner: Desktop Renderer maintainers
- Last verified: 2026-09-27
- Applies to: development source after published v2.0.3

`features/connection-overview/index.mjs` is an explicit native feature-host entrypoint.
It replaces the classic script and its legacy `window.connectionOverview` exception;
the registry gains one known native definition, not another global or dynamic plugin.
App injects the existing bounded API callbacks, translator, document and timer effects.
The feature presents supplied connection state/telemetry and the connection
control card's status/labels, and selects an underlay. It does not own connection
authority, credentials, Engine protocol or routing policy.

The owner starts synchronously once and disposes terminally/idempotently. Disposal
unsubscribes network-environment updates, removes its DOM listeners, clears feedback
timers and fences pending read/save/copy results. A queued environment read rechecks
retirement before invoking Main, not merely before publication. Main work already
issued is not represented as canceled or rolled back. Partial startup cleans earlier
bindings before surfacing the primary failure; cleanup failures are not hidden.

Metrics/topology CSS moves beneath the existing `.connection-layout.connection-overview`
root. `:where()` preserves selector specificity; DOM IDs, brand tokens, text, layout,
keyboard/focus, underlay selection and reduced-motion behavior remain unchanged.
The control-card projection now follows the same supplied status into this owner,
without moving its click command or changing the connection switch's behavior.
The app bootstrap is 502 lines at this candidate tree; remaining legacy
script/global/bootstrap debt keeps #79 open. No dependency, IPC/schema,
Main/Browser/Engine or installed-App change.

## Validation and rollback

Owner tests cover focus preservation, unsubscription/listeners, late environment,
save/copy/timer callbacks, queued-read retirement and partial startup. Registry,
HTML/global-boundary and CSS contracts follow the actual registered entrypoint.
Initial missing-entrypoint/index and old-CSS assertions were repaired locally before
publication; failed runs are not passing evidence. Native narrow/standard/wide,
overflow, keyboard/focus, reduced-motion and workspace zoom checks passed locally.
The integrated Node suite passed 1,618 tests with 14 platform skips; native ASAR
loading/disposal also passed. Its initial missing development dependency was an
environment failure, not a passing run. Exact-source package checks remain required.
Synthetic UI/ASAR evidence
does not establish real Gateway latency, MFA support or Windows report #127.

Rollback reverts native entrypoint/style registration, App wiring, removed legacy
script and associated contracts together. No persisted-data migration is necessary.
