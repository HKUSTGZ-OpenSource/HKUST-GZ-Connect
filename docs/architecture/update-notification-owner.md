# Update notification ownership

- Status: Current source contract
- Owner: Desktop / platform maintainers
- Last verified: 2026-09-26
- Applies to: development source after v2.0.3; not the published installer
- Scope: `UpdateNotificationRuntime` in `desktop/lib/platform/update/update-check.js`

Main injects version, settings effects, the existing serialized context transaction,
the identity-checked update checker and OS opener. The existing update domain owns
the last verified notification, startup/recurring timers and throttle orchestration.
Main only binds `run`, `snapshot`, `open`, startup and `will-quit` disposal.

The fixed-ID checker and verified-link action retain their existing public entrypoints.
No new module, dependency, IPC method or network endpoint is introduced. Main falls
from 1,719 to 1,682 lines; the line cap ratchets to 1,682. The 36/170 direct/transitive
dependency caps are unchanged. This does not complete M3's 500–700-line target.

## Preserved behavior

- Source/dev startup schedules no automatic requests. Packaged startup checks after
  five seconds and then every 24 hours, using persisted `updateCheckedAt` throttling.
- Manual checks bypass only the throttle. Network failure does not update the timestamp.
- Settings are read after the request, inside the existing context transaction, so
  intervening preference changes are retained. Failed persistence cannot publish success.
- No-update/failed replies preserve the last verified notification. Only the exact
  Main-issued release URL can reach the OS opener; no download or installation occurs.
- Start/stop scheduling is idempotent. Retired timer callbacks cannot run against a
  restarted schedule. `stopAutomatic` cancels timers, not an already issued bounded
  HTTP request or settings transaction. Existing context/shutdown authorities remain.

## Validation and rollback

Injected-clock tests cover timer generations, repeated teardown, packaged/dev startup,
24-hour throttle, manual checks, read errors, current settings and transaction rollback.
The real Main/Preload/Renderer release-link fixture uses synthetic network/OS effects.
Full Desktop and relevant Electron regressions remain required; native Windows/Linux
results and package gates are not inferred from macOS tests.

Rollback reverts this extraction, tests and matching ratchet together. The earlier
verified-link fix remains independently reviewable. There is no schema migration,
user-profile access, credential change or replacement of published artifacts.
