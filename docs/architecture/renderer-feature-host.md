# Renderer feature host: first lifecycle-owned module

- Status: Proposed behavior/lifecycle contribution, not merged or installed
- Owner: Desktop Renderer maintainers, issue #79
- Base: PR #110 at `82da86388d0d135cda27bebde5aae5e1d3434d6e`
- Last verified: 2026-09-11
- Applies to: Issue #79, post-2.0.2 campus-data lifecycle candidate

## Boundary

`features/feature-host/index.mjs` is the explicit static catalog and factory entrypoint.
Its internal registry accepts synchronous constructors/start/dispose contracts, mounts a known
ID once, preserves injected options and reverses mounted-owner disposal. Startup failure retires
the partial owner and earlier owners. Cleanup failures are collected rather than hiding failure
or skipping subsequent owners. Definitions cannot be swapped after registry creation.

The catalog deliberately contains only `campus-data`. `app.js` mounts that module through the
host at its existing startup position, removing its separate manual start call. Official favorites
and the legacy features stay on their existing paths until they have reviewed lifecycle contracts.
This reduces direct native feature factory/start pairs in app.js from two to one, not to zero.
It is a real running entrypoint, but not completion of the full Renderer registry/migration goal.

The machine inventory adds one owned `feature-host` root with exactly one allowed dependency:
the existing campus-data public entrypoint. It does not expand the legacy global allowlist,
permit private cross-feature imports or add an HTML bootstrap exception. This inventory change
requires independent review along with the implementation.

## Campus-data owner contract

The instance adds synchronous, terminal `dispose()`. `start()` returns true only for its first
successful invocation. Repeated start or disposal is inert. Partial startup failure cleans owned
bindings; disposal closes its own detail dialog, disconnects its observer, removes its listeners,
cancels its timer and clears owned DOM/data. Other modules' listeners and dialogs are not removed.
Closing the detail dialog and clearing its markup are independent cleanup attempts. A close
failure is reported but cannot skip the text purge or retirement of other owned resources.

Generation checks make queued events, observer callbacks, timer callbacks and pending read results
inert after retirement, including retirement from an injected catalog callback. Published data
cannot be cached or returned afterwards. Authorization-epoch changes made by a valid denial still
render that denial rather than accidentally preserving old data. The earlier compact pending-week,
cache-revocation and full-revalidation fixes remain intact.

The instance is not restartable after disposal; a new document/host constructs a new owner. This
does not add BFCache resume or runtime plugin discovery. In-flight Main/Preload work already issued
is not claimed to be canceled: its Renderer publication is fenced. No IPC, persistence schema,
credential, routing, Engine or system-network behavior is added.

## Historical acceptance — 2026-09-08

- Registry tests cover definitions, exact options/order, duplicate IDs, reverse disposal,
  invalid/async lifecycle contracts, startup/cleanup failure, pagehide and reentrancy.
- Owner tests cover idempotence, partial-start cleanup, queued callbacks, cache/timer retirement,
  external-listener preservation and reentrant catalog publication.
- Windows native SSH: 33 focused registry/lifecycle/module/cache tests passed.
- Linux 5070: complete Desktop suite 1,344 passed / 6 platform skips.
- Native ASAR Renderer tests passed on Mac, Windows and Linux/xvfb, including host-driven pagehide
  clearing campus-data DOM while leaving the unregistered favorite dialog alone; parent confirmed
  child close and fixture deletion. This is asset/bootstrap evidence, not full installer acceptance.
- Mac control-shell layout and schedule width/zoom/detail/expiry recovery gates passed; stylesheet
  comparisons retained the delivered compact calendar behavior.
- Architecture/install-script gates passed; syntax tree
  `7c72870bb7f6cfaba4511102aef1f3b68abd8db5` passed 489 source checks. No budget or dependency increase.

The controller is 469 lines (existing 500-line limit); the internal registry is 77 lines. Full
Windows unit, real-school, signed installer, long soak and hardware GPU acceptance were not run.
No installed App was replaced and no release/transfer/protection change is included. Revert this
isolated contribution to restore direct campus-data creation without reverting the prior calendar
fixes; no user-data migration is involved. Localization and other feature lifecycles remain open.

## Current synchronization and failure regression — 2026-09-11

The parent above contains published main `39850415c901aeaa77ecb86cd3ce49a2e75290a8`.
Previous lifecycle candidate: `77da76f4123a5ace4111ab3312585c6ff2b3924c`.
The parent synchronized without conflicts or history rewriting. The new regression first failed:
throwing from the detail dialog's close operation left its synthetic personal markup intact.
Separating close and markup-clear attempts makes the test pass while retaining the AggregateError,
listener/observer cleanup, empty snapshot and terminal disposal state.

Tested integration tree before this documentation update:
`ceaff99594fbc1f2de8077910e0657a7d7b39030`.
Mac Node 24 full Desktop suite: 1,368 passed, 14 platform skips, zero failures (1,382 total).
Focused lifecycle/registry/cache tests: 32 passed. Native Electron schedule navigation and
Node-owned ASAR module/child-close/fixture-cleanup checks passed. Architecture and install-script
checks and campus-workspace layout passed without raising budgets or changing dependencies.
Exact integration-tree syntax passed for 495 sources. Desktop lib, Rust, workflows,
package manifest and lockfile match the parent.

Windows/Linux native acceptance, installers, live-school/MFA and long soak were not rerun for this
tree. Earlier results retain their original source scope. This behavior PR remains separate from
the structural extraction; it does not complete the entire feature registry or authorize a merge,
release, installed-app replacement, Organization transfer or protection change.
