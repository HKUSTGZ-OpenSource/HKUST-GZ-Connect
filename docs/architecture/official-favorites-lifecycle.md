# Official favorites operation and lifecycle ownership

- Status: Proposed behavior/lifecycle contribution, not installed or released
- Owner: Desktop Renderer maintainers, issue #79
- Base: PR #114 at `0ba176ca7ad5584052c6186436d265f31fa4c61c`
- Last verified: 2026-09-12
- Applies to: Issue #79, post-2.0.2 favorites lifecycle candidate

## Behavior contract

The favorite dialog owns each submit revision. Names, URL and description are captured before
the first await; later locale/entry changes cannot replace the submitted payload. Every awaited
group/resource/placement result is checked against the live dialog and revision before publishing
data or issuing the next write. Setter callbacks are followed by another ownership check.

Close, replacement and terminal disposal retire the operation. Its late result cannot change the
new dialog's controls, publish success, move a resource or replace current group/resource snapshots.
The saved resource identity is captured before calling external setters. A queued close event from
an earlier modal cannot clear a reopened modal. Successful completion retires its own revision
before closing, preserving normal native asynchronous close semantics and completion callbacks.

Start is idempotent. Partial startup failure releases prior bindings. Dispose removes only owned
listeners, closes its modal and clears its display/input/options; queued callbacks are inert and
the instance cannot be restarted. Cleanup errors are reported after attempting other cleanup.
The existing public module exports remain `create` and `comparableUrl`.

## Registry integration

The static feature-host catalog now mounts official-favorites and campus-data. Their creation
order in app.js remains unchanged, and both have explicit synchronous start/dispose contracts.
No direct native factory/start pairs remain in app.js; the other legacy features are not silently
wrapped. The host's allowed dependency list names the existing favorite public entrypoint, without
changing the global allowlist or allowing private/HTML import bypasses.

The owner is 217 lines under its existing 250-line limit. app.js and its architecture cap reduce
from 564 to 562 lines. No dependency or other budget was increased.

## Limits that remain explicit

Already-issued Main mutations may finish. Renderer cancellation is not rollback and does not
delete committed folders or resources. A user may therefore find an already-created folder or an
ungrouped favorite after interrupting a multi-step save. The IPC/persistence transaction model is
unchanged; atomic multi-step saving is not claimed by this patch.

The current group API returns a list rather than an exact created-group ID. When comparison with
the prior IDs finds multiple new groups, the dialog reports failure instead of guessing a target.
A future backend creation receipt is needed for seamless concurrent group creation. The normal
single-creation and existing/ungrouped-folder flows remain supported and tested.

## Historical evidence — 2026-09-08

- RED cases reproduced stale group publication, an older save unlocking a newer one, and missing
  disposal. Additional tests cover entry/locale mutation, reentrant setters, delayed native close,
  late move completion, queued callbacks, partial startup and ambiguous group replies.
- Mac and Windows native SSH: 28 focused favorites/module/registry tests passed.
- Linux 5070 full Desktop suite: 1,355 passed / 6 platform skips.
- Native ASAR Renderer tests passed on Mac/Windows/Linux with parent-confirmed child close and
  cleanup. Pagehide retires both registered owners and closes the favorite dialog.
- Mac/Windows control-shell layout passed, including actual synthetic new-folder favorite saving,
  personal-tab handoff and star state. Mac calendar width/zoom/detail/expiry regression also passed.
- Architecture, install-script, exact index secret and syntax gates passed. No workflow was edited.

Windows GPU exit 34 warnings remain. Full Windows unit suite, signed installers, long soak and
live-school checks were not run. No installed App, credentials, user-data schema, routing or system
network settings changed. This is independently reviewable after its base; it is not a merge or
release authorization. Reverting the contribution restores manual favorite startup and the earlier
save races, without reverting the separate calendar fixes or requiring a data migration.

## Current parent synchronization — 2026-09-11

Previous candidate: `20062e2b4c7345642a383cdc0957a82c4075cfff`.
The parent above, including published 2.0.2 main and the detail-close cleanup regression, synchronized
without conflicts or public-history rewriting. This remains the separate favorites behavior PR;
no lifecycle behavior is backported into the structural extraction. Desktop lib, Rust, workflows,
package manifest and lockfile match the parent exactly.

Tested integration tree before this documentation update:
`e04a4dd8de1bf0ff51b94b2bba3c4ee499aaa3f0`.
Mac Node 24 full Desktop suite: 1,379 passed, 14 platform skips, zero failures (1,393 total).
Focused favorites behavior/module/feature-registry tests passed. Native Node-owned ASAR checks
passed both module pagehide retirement and child-close/fixture-cleanup verification. Control-shell
layout passed, including the synthetic favorite/new-folder workflow. Architecture, install-script,
exact integration-tree syntax (495 files) and diff checks passed; no budgets or dependencies increased.

Windows/Linux native acceptance, installers and live-school/MFA canaries were not rerun on this
tree. Earlier receipts retain their exact-source scope. Reused dependency caches are unchanged;
no installed app, user data, system network, GitHub protection or Organization ownership changed.
The multi-step save still cannot roll back a Main mutation that has already been dispatched.

## Direct-parent cleanup synchronization — 2026-09-12

The updated #114 parent above merged locally without conflicts; no history was rewritten and no
other descendant was changed. The exact pre-receipt tree is
`60dd2184c2f521f9a888e03e518d8c409ae77451`. Mac Node 24 full source tests pass: **1,381 passed,
14 platform skips, zero failures (1,395 total)**. Native schedule navigation passes including the
detail-close fault regression. Control-shell layout passes including synthetic new-folder favorite
creation and personal-tab handoff, using isolated temporary userData rather than the installed app.
Architecture, exact-tree syntax/secret, install-script and diff checks pass. Desktop lib, Rust,
workflows and package manifest/lock match the parent; the favorites contribution remains distinct.

This checkpoint reuses the existing dependency runtimes. No Windows/Linux whole-tree rerun,
distribution package, live-school action, new branch/PR, public merge or protection change occurred.
Revert the local synchronization commit to recover the prior candidate; persisted user data has
not changed. Prior cross-platform evidence is not promoted to this new tree.
