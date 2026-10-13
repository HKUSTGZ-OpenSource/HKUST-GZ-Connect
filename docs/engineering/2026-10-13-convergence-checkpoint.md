# Repository convergence checkpoint

- Status: Current checkpoint; overall goal remains Active
- Owner: project maintainer heeh02
- Last verified: 2026-10-13
- Applies to: `main@d14e10e78756678f73f1120ab086cbe7ccb5be26`, stable `v2.0.4`
- Supersedes: earlier current-state totals/release selection, not historical test receipts

## Exact-source acceptance

The current main tree is `64372bb84b04a87d8a6a5ab2805d7b53bc0f38a3`.
Dependabot PRs #261/#262/#263 were independently reviewed under the maintainer account and normally
squash-merged after the seven strict required contexts and three platform package checks passed
on each final head. No administrator bypass or protection change was used for this queue.

| Outcome | Squash commit | Exact-main CI |
| --- | --- | --- |
| Acorn 8.19.0, existing build-time parser | `8d6dccaf195c9229e43e9d53941df9cb5bbbcff7` | `38339120482` — success |
| libc/Tokio/zeroize patch updates | `5e2250dd3eada2c909a36eba82679b1de1d375ed` | `38340160009` — success |
| Ten immutable Action-pin updates; events/permissions/budgets unchanged | `d14e10e78756678f73f1120ab086cbe7ccb5be26` | `38357198828` — success |

PR #263's original head failed its existing 30-second Electron performance deadline. Its required
once-only synchronization with main passed the unchanged test and completed 30/30 soak cycles;
that does not establish the original timeout cause. Updated-head switch p95 was 8.3 ms but one
sample was 1043.7 ms; hidden-idle CPU missed its observation-only target. These limits remain
explicit and no performance/timeout budget was increased. Offline performance is not live Gateway
performance.

Local Node 24.19.0 verification of #261 used the integrity-checked Acorn package and exact cached
dependency versions: 2,131 tests passed, 16 platform skips, zero failures/cancellations, plus
architecture, governance, syntax, secret, install-script, vulnerability and native offline-soak
checks. For #262, local pinned Rust 1.97.1 formatting and source gates passed; large local Rust
Clippy/test compilation was omitted because storage was nearly full. Production/laboratory Rust,
native platform compilation and package evidence came from the separately identified CI runs.
For #263, 21 local workflow/package-policy contracts, YAML/pin/permission review, governance,
exact-head secrets and syntax passed. No omitted local test is represented as passed.

## Published release is a separate identity

Latest stable `v2.0.4` dereferences through annotated tag object
`ef84287741e015289a079d00859c8bd8b27c5b8e` to source
`50731a94664464d5910375f4f6832e8f069d3937`. Native build `37914773313` and source CI
`37914765501` succeeded. The four installer names/sizes/API digests match the downloaded
`BUILD_RECEIPT.json`; both downloaded metadata files match their API SHA-256 digests.
This is metadata/receipt readback, not another byte-level installer verification.

The receipt records ad-hoc Mac signatures without notarization and unsigned Windows. The earlier
post-2.0.3 maintenance and #258 recovery policy are included; #261-#263 are not. Installed applications,
release assets and current source must not be conflated. No installed application or user data was
replaced during this checkpoint, and no additional release/tag operation was performed.

## Remaining acceptance — keep issues open

| Issue | Current evidence | Required remaining result |
| --- | --- | --- |
| #79 / M1 | Explicit native feature owners; frozen 24-file legacy list; Renderer root 420 lines | Complete bootstrap/global-order/CSS/localization dependency authority and GUI lifecycle acceptance |
| #80 / M2 | Browser root 592 class / 751 source lines; bounded entry/tab/host/routing retirement repairs | Whole-owner public contracts, Session/campus-data boundaries and idempotent/context-retired teardown acceptance; not just a root-size target |
| #83 / M5 | Path/entrypoint subset enforced; root-test debt zero; private-JS-edge cap 89 | Full allowed-import, dynamic Renderer and Rust visibility enforcement without increasing debt budgets |
| #84 / G4 | Original repository transfer and existing strict main checks retained | Named role teams/review/release ownership and separately authorized target settings; Security/Release membership is explicitly deferred until activation |
| #127 | Reproduced bounded pre-login/indeterminate failure repairs and native/platform tests | Sanitized reproduction or affected Windows reporter retest for the original failure |
| #177 | Seven-day personal-calendar source-query regression repaired through #178 | Sanitized reporter confirmation of the formerly missing real portal course |
| #60 | M3/M4 source acceptance; dependency queue reviewed; current-source/package CI | Complete or explicitly accepted deferrals for every G0–G4 requirement, final documentation/security/settings audit and safe cleanup |

Main remains 662 lines with 20 direct / 35 effective / 170 transitive dependencies; Engine root
remains 498 lines. These counts and green checks are evidence, not permission to close the remaining
issues. No real-school support, Gateway MFA or company-address compatibility claim is added here.

## Preservation and cleanup

Shared dependency caches, installed data and uncertain/unmerged work are preserved. Task-owned
dependency overlays contain only verified symlinks; removing them does not delete their targets.
Managed archive requests are counted as pending until archive metadata and checkout removal are
actually confirmed. Historical chat PR attachments may be unlinked after merge/ancestry proof;
that does not delete GitHub PRs or commits. Remaining worktrees/branches still require individual
ownership, process, source-retention and recoverability checks before cleanup.
