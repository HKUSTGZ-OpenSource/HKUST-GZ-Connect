# Browser Manager open retirement

- Status: Proposed bounded repair for #217; not a release or complete Browser ownership
- Owner: Desktop Browser maintainers
- Last verified: 2026-10-03
- Applies to: candidate based on `main@205054f4ec76184d97b25c38e8cb50c1c6076b95`

## Reproduction and boundary

The production Manager awaited Engine readiness before allocating a Browser. A
managed close could therefore confirm closure while no window existed, yet the
pending request would subsequently create one. After allocation, an old Browser
completion could also return success or publish an error after Manager disposal
or replacement. Existing bookmark-manager retirement checks did not cover this
ordinary open path.

Nineteen existing Manager tests passed on the base. Four new synthetic production-
Manager tests failed for windowless close, late readiness rejection, late Browser
success/rejection and close admission before confirmation. They use injected I/O,
not another implementation of the Manager policy or real account evidence.

The actual Main/Electron/IPC regression holds the fixed synthetic Engine's readiness,
closes/clears only its isolated test partition, then releases readiness. With the
base production Manager byte-identical to main, it failed because the retired
request returned `ok: true`. With the bounded epoch checks it returns stale,
allocates no Browser window and leaves the Engine connected for a fresh request.
The existing concurrent retry, generation, listener, renderer-recovery, graceful
shutdown and original two-attempt assertions remain before this added third-attempt
stage. This is synthetic/native evidence, not a real Gateway or installed-app test.

## Repair

The Manager owns a private open epoch. `close()` and `closeForContextSwitch()`
advance it at admission, before any await or early no-window return. An open
captures that epoch, rechecks it after readiness, and checks both epoch and exact
Browser identity after Browser completion or rejection. Retired outcomes are the
existing bounded `{ ok: false, stale: true }` shape and do not report an error into
the current presentation.

Current readiness rejection still propagates its original cause; current route,
connection and Browser errors retain their existing handling. URLs, route policy,
labels, blank/direct behavior and fresh re-open remain unchanged. The epoch does
not cancel Engine work, replace connection-state authority, clear Session data or
permanently retire the reusable Manager. Browser/window/request-gate owners still
control their own work and teardown.

The added readiness barrier is confined to the existing non-shipped child fixture:
one dev-only boolean, one fixed marker beneath its isolated profile, and a bounded
ten-second wait. Production launch selection, protocol/wire, fixtures' default
timing, native package inputs and existing test deadlines are unchanged. No new
production module/dependency/IPC/global export or architecture exception is added.

## Acceptance and limits

Manager contracts, the native Main regression, Profile switch, routing, MFA,
strict proxy, Browser performance/soak, full Desktop and source gates form the
local matrix. Exact-head Windows/macOS/Linux package and required CI remain
separate before merging. No real login/calendar result or full M1/M2/M3/M5 outcome
is inferred; #127/#177 are unrelated unresolved reports.

This repair covers Manager-managed close admission and pending ordinary opens.
It does not claim a redesign of arbitrary direct calls to a Browser instance,
all new-open-versus-clear races, or process-wide shutdown/cancellation policy.
Rollback the Manager epoch checks and regression/fixture barrier together. There
is no persistent schema, user-data migration, installed app or global-network change.
