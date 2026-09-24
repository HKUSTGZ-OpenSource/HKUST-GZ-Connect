# Integration export intents and effect-boundary validation

- Status: Main repair candidate based on merged #119; prior three-platform source acceptance passed, installers unverified, not deployed
- Owner: Desktop / integration maintainers, issues #79 and #81
- Last verified locally: 2026-09-25
- Base: `main@a4a188d` after PR #119
- Initial intent repair: `e94c642539c99d1bdbf428c18d85cd45ed87453a`
- Scoped-cancellation source: `65065b422044bb2a00a56264eec6c518a8b9f934`
- Native path-fixture acceptance: `95902b015b1ac8a9d03e0c4813e2c670827d0532` (runtime unchanged)

## Why Main must be repaired before Renderer retirement

Current-source results are recorded in the [Renderer lifetime synchronization receipt](integration-renderer-lifecycle.md).
The dated Windows full-suite failures below remain historical evidence, not a new run on the
post-2.0.2 integration tree. Platform acceptance is tied to the exact tested source in that receipt.
The later exact-source Windows follow-up in that receipt now records a full-suite pass on
`7beadca7332bbd20ac0603273a67c92f2ddeb2d9`; historical failure logs below are retained, not current status.
The same code also passed the Linux full suite and native ASAR follow-up. See that receipt for
platform counts and the missing-Acorn environment correction; full installers remain unverified.

The previous runtime captured a context before awaiting a native save target and did not revoke
that continuation on cancel. Its confirmation catch also called global cancellation, which could
erase a newer preview. Finally, the coordinator awaited pre-export preparation without rechecking
authority immediately before clipboard/file output. Eight offline regression cases demonstrated
these failures. Removing a UI dialog alone cannot prevent an already-received Main request.

## Ownership and compatibility

`IntegrationCenterRuntime` now assigns an internal intent to each valid prepare/accepted confirm.
Global cancel advances the intent before clearing pending state. A late target selection cannot
publish or replace a preview; the current binding is re-read after selection and compared with the
immutable initial digest. That existing digest covers Profile/account/workspace, credential,
listener, port and policy revisions. This does not invent a second binding schema.

Confirmation checks its intent before delegating. `GenericExportCoordinator.confirm` requires an
explicit synchronous assertion (void return, failure by throwing); missing, declared-async and
promise-returning checks cannot silently grant authority. The assertion runs before consuming the
handle and again after `beforePerform`, immediately before synchronous clipboard/file commit.
Production supplies it from the runtime's current intent/binding owner; standalone test callers
explicitly provide their stable synthetic assertion.

Internal `cancel(handle)` only clears matching prepared material. Old failure cleanup therefore
cannot erase a newer preview. The initial repair left public IPC unchanged; the additive
scoped-cancellation follow-up below exposes the same ownership boundary through the existing channel.
Existing invalid
**execute**-handle behavior still fails closed and invalidates prepared material, as its regression
contract requires; this change must not be read as altering that policy.

A failed replacement target selection retains a prior valid preview. A duplicate confirm with no
pending record does not revoke the already-accepted operation. Already-committed clipboard/file
output is not retroactively reported as canceled or rolled back. Preparation effects already run
(for example a private helper sidecar) are not rolled back by this guard. Logical cancellation
does not claim to dismiss the OS save dialog; its late answer becomes inert. The existing cancel
return value still describes whether prepared material was cleared, not native-window closure.

No configuration format, credential storage schema, routing, Engine or system-network behavior
is changed. Main still owns raw generated content; Renderer sees only
metadata/handles. Executing payloads are zeroed in the existing transaction finally path, including
guard failure after preparation; save regressions observe a nonempty borrowed buffer before testing
zeroization. Confirmation TTL semantics and Renderer lifecycle are not replaced by this repair.

## Scoped cancellation follow-up — 2026-09-09

The Renderer cannot safely retire an old dialog using only global cancellation: a late callback
could revoke a newer preview or a newer native target-selection intent. The existing
`cancelIntegration()` remains the unchanged value-free global operation. An additive
`cancelIntegration({ confirmationHandle })` now uses the same trusted `cancel-integration` channel,
the existing closed handle-request validator and status-only responses. Null, arrays, missing or
overlong handles and unknown fields fail validation; none fall back to global cancellation.
No new channel, generic invocation method or generated-content projection is introduced.

Runtime scoped cancellation never increments the global intent. It clears only a matching prepared
record or revokes the matching accepted confirmation's private guard. This matters when an old
preview still exists while a newer native save dialog is pending: canceling the old handle must
not invalidate the new selection. An accepted operation is checked again at the existing synchronous
effect boundary; its finally cleanup can retire only its own guard, never a newer confirmation.
Unknown/stale handles are no-ops and the old invalid-confirm/execute fail-closed behavior remains.

For an accepted operation, `cancelled: true` means its logical confirmation authority was revoked;
it does not mean the OS dialog was dismissed, committed output was rolled back, or an unresolved
preparation Promise was interrupted. Borrowed payload bytes are zeroed by the transaction's existing
finally path when execution settles. These limitations apply equally to copy and save.

Source `65065b4` validation:

- RED before implementation: 30 passed / 8 failed across lifecycle, IPC and Preload tests.
- GREEN with the additional accepted-operation/new-target race: **39/39** on Mac Node 24.19 and
  native 5070 Windows Node 24.20. Tests verify cancellation alone blocks copy/save (not merely a
  subsequent prepare), malformed requests never call the runtime, stale handles preserve newer
  previews/accepted confirmations, and old cleanup preserves new file-selection intents.
- Mac and 5070 Linux full Desktop suites: **1,421 total / 1,415 passed / 6 skips / 0 failures**.
- Main composition and dependency budgets are unchanged; architecture passes.
- Exact-source syntax (517 files), secret, install-script and governance gates pass. Mac native
  Renderer ASAR smoke passes, including confirmed Electron exit and fixture retirement. Its first
  attempt could not resolve the shared ASAR dependency; a temporary link to existing dependencies
  corrected that test environment and was removed afterward. No dependency was downloaded.
  The ASAR fixture uses synthetic APIs, so it does not prove a real Main export or the new optional
  Preload argument in an Electron IPC round trip. That argument is covered by the Preload/IPC unit
  contracts; a full packaged/native-save-dialog acceptance remains outstanding.

At that checkpoint the Renderer still called the legacy no-argument operation. This established the safe
cross-process prerequisite; it does **not** complete GUI retirement, host mounting, timer/listener
cleanup or the user-visible async fix. That follow-up must use scoped cancellation and prove late
prepare/confirm/refresh publication is inert. No application installation or release is implied.
The security/ownership contract is recorded as a proposed addendum to
[ADR-0005](../adr/0005-external-tool-integration-center.md), pending independent review.

## Initial intent-repair evidence (historical)

- Mac Node 24.19: 34 runtime/coordinator/transaction/IPC tests passed, including 18 new lifecycle
  and guard cases. Save-success regression writes only a test-owned temporary file; clipboard is
  injected. New cancellation tests use in-memory effects, not a user's destination or clipboard.
- 5070 Linux Node 24.20: full Desktop suite — 1,406 passed / 6 platform skips, zero failures.
- Mac native Renderer ASAR smoke passed. It exercises the unchanged Renderer with synthetic APIs;
  it is not evidence of real Main export or native save-dialog interaction.
- Architecture, install-script, repository-governance and secret gates passed. Exact HEAD syntax
  passed 517 source files. Main dependency/line budgets did not increase.

### Windows follow-up on 2026-09-09

The earlier helper-build failure and SSH outage are historical, not the current targeted-test state.
SSH returned without host/network changes. Initializing the existing `VsDevCmd.bat -arch=x64` in
the test process allowed the fresh native helper build to complete; automatic environment discovery
in the standalone build script was not changed. No compiler installation or persistent environment
change was made. The helper reported `ec-private-file 1`, SHA-256
`43448327e29d9054cdd65d2c822d216d880de922a97c72e71d17e15c4b0f5d9c`.

The first native scoped run passed 33/34; its failing default-path assertion assumed POSIX spelling.
The full-suite probe also found a VS Code fixture supplying noncanonical POSIX paths on Windows.
Both integration fixtures now use native absolute paths, including spaces. Assertions still require
the exact default filename/parent, only one supported save dialog, cancellation rejection, secret
exclusion and generated-payload validation. No production path validator or ACL check was relaxed.

Native Windows Node 24.20 then passed **37/37** runtime, transaction, adapter and IPC tests, including
real owner-only writes in test-owned temporary directories using the compiled helper. Linux was
rerun on the same source: **1,406 passed / 6 skips**; the expanded **37/37** also passed on Mac.
Runtime code remains byte-identical to the
tested `e94c642` implementation; these follow-up commits change fixtures only.

**The repository-wide Windows gate is still not accepted.** An exploratory full run on the final
source archive reported **1,412 tests: 1,297 passed, 75 failed, 40 skipped**. The prior probe before
the second fixture correction had 76 failures. One failure is explicitly a harness limitation:
the archive lacks `.git`, so the exact-index governance test cannot run there. Other failures span
storage/migration, switching, profiles, resources and Engine tests. Some active-context fixtures
overlap existing PR #107; not all failures have been attributed or proven to be production bugs.
No claim that these are all caused by, or unrelated to, PR #120 is made from path comparison alone.
Follow-up belongs to M5 issue #83: use a proper Windows Git checkout, reconcile PR #107, then audit
each remaining fixture/implementation without broad Windows skips or weaker permission checks.

A later proper-Git checkout at `3d323e2a0b99b0d89b3bfbf23a1bf21e934c77d5` passed the exact-index
governance gate and reported **1,412 total / 1,298 passed / 74 failed / 40 skipped**. This confirms
the missing-index environment failure is removed. PR #107 was then tested separately at
`095a5eb18cb50e03b874439547ff9e21461e2a46`: its activation/journal and native-C checkout suite passed
14 with 2 platform-specific skips on both Mac and Windows. It also corrects elevated-session
fixture creation and fixes C source LF checkout semantics. It is not merged into this review
chain, so no combined full-suite reduction is claimed. M5 #83 records the remaining attribution.

Windows full-suite, full installer/signature, live-school and actual user-export acceptance remain
unproven. Targeted success is not a release approval. No Actions build, installed-App replacement,
merge, release or transfer is claimed.

## Remaining work and rollback

The subsequent [Renderer lifetime repair](integration-renderer-lifecycle.md) now implements explicit
host startup, terminal disposal and scoped async publication on this review branch. Its receipt
separates native evidence from unperformed package/user acceptance. Neither stage completes issue
#79 or authorizes a release.

Revert runtime/coordinator/transaction, IPC/Preload extensions and their tests together. Internal coordinator
callers then return to the prior guard signature. No persisted-data migration is involved. The
separate Renderer structural PR can remain; unchanged user sessions and installed packages need
no rollback for this uninstalled candidate.
