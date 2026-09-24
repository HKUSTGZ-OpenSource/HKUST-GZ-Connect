# Windows activation fixture acceptance

- Status: Historical test-only candidate evidence
- Owner: Desktop/Persistence maintainers
- Verified: 2026-09-08
- Parent: #83 validation follow-up; does not close M5
- Base: `9e1135c05dc21998c66627e25477d4bd799cd5d7`
- Code: `6a2143f5d637f432f376f71ac38b369a5938e1b7`
- Tested code tree: `91ececb5e81ced5c8f529c4dcdd779e7f734e2fd`

## Finding and correction

Four activation-store tests failed on native Windows before reaching their intended assertions.
Their `writeJson` helper created files with POSIX mode 0600, which does not establish a protected
current-user DACL on Windows. The real store correctly rejected them as `GlobalSettings ACL is invalid`.

The fixture now uses the existing `ensureOwnerOnly` boundary and asserts preparation succeeded.
No production permission check, activation logic, persistence schema or dependency was changed.
A new Windows-only negative test recreates the source without hardening, proves mode 0600 is
insufficient, and verifies the production store still rejects that source before activation.

## Evidence

- Native Windows on the designated 5070 host, Node 24.20.0: original suite 1 passed / 4 failed;
  corrected suite 6 passed / 0 failed / 0 skipped, including the real ACL rejection case.
- 5070 WSL/Linux focused suite: 5 passed / 1 Windows-only skip.
- macOS focused suite, Node 24.19.0: 5 passed / 1 Windows-only skip.
- 5070 WSL/Linux full suite under `umask 022`: 1238 passed / 7 platform skips / 0 failed.
- Architecture, install-script allowlist and exact-tree syntax/secret gates passed.
- Candidate test-file SHA-256 matched on Mac, Linux and Windows:
  `c4066bf766a7c89eea08b8c97e1df45afb34184fde5b814e3f3b4bf38c6ac518`.

Focused command, from the corresponding `desktop/` tree:

```sh
node --test test/unit/switching/active-context/active-context-activation-store.test.js
```

The full Linux command was `umask 022; node --test`. An initial SSH invocation inherited umask
0002 and caused eight unrelated profile-registry fixtures to fail on group-writable directories;
the failures disappeared under the standard non-group-writable test environment. Production
registry checks were not relaxed to accommodate that setup error.

## Journal fixture follow-up (2026-09-08)

The same test domain contained one more native Windows false failure: the journal disappearance
test recreated malformed JSON using mode 0600, so it stopped at `journal ACL is invalid` rather
than reaching content validation. Native RED was 5 passed / 1 failed / 2 POSIX-only skips.

The recreated fixture now passes the existing `ensureOwnerOnly` gate first. Assertions separately
verify invalid JSON (`SyntaxError`) and invalid journal schema (`TypeError`), both wrapped as
`journal is invalid`. A native Windows negative test verifies an inherited ACL still blocks parsing;
only after hardening that same synthetic file does the parser error become observable.

- Code follow-up: `7e499ef8751b18a19de9b14204d4a62a0a2396fd` (test-only);
  tested tree `371897631959ebffaf9c93520653b6bc2ce094c1`.
- Mac Node 24.19.0 and native Windows Node 24.20.0 combined activation/journal suites:
  13 passed / 0 failed / 2 platform-specific skips on each platform.
- 5070 Linux Node 24.20.0 full suite under `umask 022`: 1238 passed / 0 failed / 8 platform skips.
- Architecture, install-script, exact-tree syntax, staged secret and governance gates passed.
- Journal test SHA-256 matched on Mac, Linux and Windows:
  `a7d6d50b6455ba6ef5b34f3a7ab5c8c4b430ccb7d6ec1383be1fcb735e838264`.
- Remote tracked source remained at `6a2143f` plus this exact journal-test replacement; intervening
  local changes were documentation only. No unrelated remote runtime edits were used.

Combined focused command, from `desktop/`:

```sh
node --test test/unit/switching/active-context/active-context-activation-store.test.js test/unit/switching/active-context/active-context-switch-store.test.js
```

## 2026-09-09 revalidation: Git checkout, C bytes and elevated fixture ownership

The earlier results above are historical. Revalidation used native Windows Node 24.20 through the
designated host, not WSL interop, with separate Git worktrees for the current review chain and this PR.
No PR was merged. GitHub direct clone timed out and ended; a read-only local object source and an
incremental bundle were then used. `git bundle verify` validated prerequisite availability, and
checkout/readback established the exact requested HEAD and clean tracked files. The original
Windows checkout was not changed; shared object-source directories must remain available while
these temporary validation clones exist.

On review-chain `3d323e2a0b99b0d89b3bfbf23a1bf21e934c77d5`, exact-index governance now passes.
The proper-Git Windows full run reports **1,412 total / 1,298 passed / 74 failed / 40 skipped**.
The previous source-archive probe reported 75 failures, including the confirmed missing-Git-index
environment error. This removes that harness error; it does not turn the remaining failures into
accepted behavior or prove all are fixture defects. M5 issue #83 owns their separate attribution.

Two additional fixture/reproducibility issues were reproduced and corrected in this PR:

1. `* text=auto` without a C-specific LF rule permits native C checkout as CRLF, even with
   `core.autocrlf=false` when the effective EOL is CRLF. The helper source was 6,658 bytes / 150 CRLF
   sequences versus the committed 6,508 LF bytes; normalized contents matched. `*.c text eol=lf`
   now fixes native-source byte identity. A real temporary Git checkout test was RED before the
   rule and passes for `false/crlf`, `true/crlf` and `input/lf` settings. No global Git setting changed.
2. A temporary-file ownership probe confirmed this elevated session's default owner is
   Administrators, not the current user SID. The old fixture's `ensureOwnerOnly` therefore correctly
   refused to tighten it. These test-owned, newly created synthetic files now use the existing
   Windows **creation** protection API; POSIX fixtures retain `ensureOwnerOnly`. Production ownership,
   DACL, symlink and source-authority checks are unchanged. Do not copy this fixture initialization
   into a production existing-file read/migration path to seize foreign-owned material.

Revalidation source: `095a5eb18cb50e03b874439547ff9e21461e2a46`; C EOL regression first added at
`df9e9e0c62ff702fc4fb022d14ac4d96ba09eddd`. On native Windows the earlier fixture version failed
eight preparation assertions; the corrected combined activation/journal/C-checkout suite passed
**14 / 0 failures / 2 POSIX-only skips**. Mac Node 24.19 passed **14 / 2 Windows-only skips**.
Linux Node 24.20 full suite passed **1,239 / 8 skips / 0 failures** under `umask 022`.
The inherited-ACL negative tests still reject before activation/parsing; malformed JSON/schema
tests still assert their distinct causes after correct fixture preparation.

The fixed PR's native C checkout SHA-256 matches its committed source and the verified helper's
source: `9341aba8971b5b45b73adad9a7eb48c505559214d4f14ad5b1d3ae9f6d0e8af8`.
The reused Windows test helper reported `ec-private-file 1`, SHA-256
`43448327e29d9054cdd65d2c822d216d880de922a97c72e71d17e15c4b0f5d9c`.
The current review-chain baseline built its own helper before the full run because its raw C
checkout was CRLF. Do not conflate a Git blob, working-tree bytes and binary identity.

The two activation/journal test files and their persistence/switching/storage/profile production
domains are unchanged between the current review chain and the main baseline, apart from this
separate proposed fixture repair. The five corresponding baseline failure locations are covered
by this passing scoped run; no combined full-suite reduction is claimed without an authorized
integration and rerun. No new Windows full-suite, application, installer, live-school, release,
transfer, protection or Actions claim follows from these scoped results.

## 2026-09-09 follow-up: bottom-level private-file fixtures

Source `c02af45eba9414f64fd44d10c87772b736a09584` corrects two more preparation errors in
`private-file.test.js` and `windows-private-file.test.js`. The native Windows RED run reported
9 passed / 2 failed: both success fixtures attempted to tighten a newly created file whose default
owner in the elevated session was Administrators, not the current user. Production correctly
refused them. No production C/JS file or security policy was changed.

A test-only helper under `test/unit/platform/storage/support/` now establishes current ownership
on newly created synthetic files, independently confirms that owner through PowerShell, and adds
a broad Users read ACE. Verification must reject that broad DACL before the actual `tighten` or
`ensureOwnerOnly` assertion runs. This preserves a real hardening test rather than replacing the
operation under test with the creation-protection API. Existing broad-DACL preparation reuses the
same helper. Special-character paths, independent PowerShell verification, missing/directory,
hardlink and symlink checks remain in place.

A new native negative test explicitly assigns Administrators ownership to its own synthetic
temporary file. Native tightening, PowerShell tightening and the descriptor wrapper must all
reject it without changing the complete security descriptor or contents. This test ran and passed
under the designated elevated RBMS session. On a non-elevated Windows runner, only this new
foreign-owner fixture test reports a named skip because creating that fixture requires elevation;
no existing failure is skipped. No machine privilege, account, user file or global configuration
was changed. Expected PowerShell rejection text appears in the native negative-test log.

Validation of the exact source above:

- Mac Node 24.19 full `node --test`: **1,249 total / 1,240 passed / 9 skipped / 0 failed**.
- 5070 Linux Node 24.20 full `node --test`, `umask 022`: the same counts. The total includes
  Node's discovery of the side-effect-free support module; it is not an extra behavioral assertion.
- Native Windows Node 24.20, two private-file suites: **12 passed / 0 skipped / 0 failed**.
- Combined private-file, C-checkout, activation and journal suites: native Windows
  **26 passed / 2 POSIX-only skips**; Mac **21 passed / 7 Windows-only skips**, no failures.
- Architecture, exact-HEAD JavaScript syntax (464 files), indexed secret, install-script and
  repository-governance gates passed. Tracked source was transferred through verified Git bundles
  into the existing separate Windows and Linux PR #107 worktrees.

Combined command, from `desktop/`:

```sh
node --test test/unit/platform/storage/private-file.test.js test/unit/platform/storage/windows-private-file.test.js test/unit/platform/storage/native-source-checkout.test.js test/unit/switching/active-context/active-context-activation-store.test.js test/unit/switching/active-context/active-context-switch-store.test.js
```

The earlier review-chain full-Windows baseline remains **74 failures, not remeasured here**.
These two reproduced failure sites are resolved in this isolated PR; do not subtract them from a
different tree's full-run count without a combined rerun. No installed application, package,
real-school, release, transfer or GitHub merge claim follows from these fixture-only changes.

## Rollback boundary

### Combined release-tree full rerun — 2026-09-09

Local integration `7f896c1fb4d89ade4d88681bd590054a5f8a59f6`, tree
`5bfbef837a92a66710eccd885650a10b4ac45bec`, combines PR #107 through `8ba228b` with PR #106
`020fa42`, PR #88 `35a9c8b` and PR #95 `cdc0398`. It is a local acceptance commit, not main or a tag.
All hosts checked out that same source. Full `node --test` results:

- Mac Node 24.19: 1,306 total / 1,292 passed / 14 platform skips / **0 failed**.
- 5070 Linux Node 24.20, umask 022: identical counts.
- 5070 native Windows Node 24.20: 1,306 total / 1,266 passed / 40 platform skips / **0 failed**.

This supersedes the earlier combined 46- and 27-failure results for the measured full run; it is
not arithmetic subtraction of scoped tests. Architecture, indexed secret, install-script and
exact-HEAD syntax gates passed (474 JavaScript files). Existing platform skips were not expanded.
Logs are named `hkustgz-202-consolidated-*-full-20260909.log` on Mac and
`hkustgz-202-consolidated-full-20260909.log` in the designated hosts' work directories.

No runtime code changed in these fixture follow-ups. No administrator merge, tag, published asset,
installed-App replacement or live-school test occurred. Exact-main packaging, signatures/digests,
release review and installation acceptance remain separate requirements. A passing test run does
not waive unresolved findings from other reviews.

### Native provisioning and coordinator fixtures — 2026-09-09

Commit `5a662ef` replaces POSIX-only success assertions with real native ACL verification on
Windows and prepares newly created conflicting targets/legacy migration inputs before exercising
content rejection. Production materialization, index, deletion and migration rules are unchanged.
Five failure sites from combined Windows `949bd0b` are covered by this correction.

The custom-profile-storage and migration-coordinator suites passed **18 tests / 3 existing Windows
skips / zero failures** on 5070 native Windows Node 24.20; Mac Node 24.19 and 5070 Linux Node 24.20
each passed **21/21**. Conflict/no-overwrite, prepared-journal retention, indexed crash recovery,
Browser cleanup failure, index-last retirement and old-to-new migration assertions remain intact.
All corrections must still be combined and tested as one release tree; scoped totals are not
subtracted from a prior full-suite result to claim Windows completion.

### Native school-selection fixtures — 2026-09-09

Commit `af460491` prepares owner-only ACLs only when creating new synthetic GlobalSettings and
school/account/workspace JSON fixtures. Existing fixture rewrites do not reassign ownership.
The pre-ready-profile-resolution and profile-candidate-directory suites passed **7 tests / 1
existing Windows skip / zero failures** on native Windows Node 24.20 and **8/8** on Mac Node 24.19
and 5070 Linux Node 24.20. Six cases previously failed in combined Windows `949bd0b`.

Linux initially rejected the isolated checkout's group-writable directories (mode 775); the
owner-created temporary verification worktree was tightened to remove group/other writes and the
same source reran successfully. No application validation was bypassed or production data changed.
Assertions still cover custom-school startup, unknown-school rejection, separate browser partitions
and alternating reviewed/custom authorities without inheriting another school's workspace state.

### Native workspace upgrade fixture — 2026-09-09

Commit `e4926182` prepares real owner-only ACLs for fresh synthetic upgrade files and uses the
host adapter for folder creation/reopen. `profile-workspace-upgrade.test.js` passed **2/2 without
skips** on Mac Node 24.19 and 5070 native Windows/Linux Node 24.20. One case previously failed in
combined Windows `949bd0b` during activity-file permission validation.

Existing assertions retain URLs, favorites, recents, hidden resources, routing, unchanged original
favorites bytes and reopened folder membership. Package identity assertions are configuration
checks only, not an executed installer upgrade. Production code and user data are unchanged.

### Native account/workspace authority fixtures — 2026-09-09

Commit `eee766dd` prepares owner-only ACLs when creating synthetic account/workspace JSON and
credential fixtures. Rewrites of an existing fixture do not reassign ownership. Production readers
and cross-account/Gateway binding assertions are unchanged. Three formerly failing Windows cases
now reach their intended read/binding paths instead of failing on setup permissions.

`profile-workspace-runtime-authority.test.js` passed **4 tests / 1 existing platform skip / zero
failures** on 5070 native Windows Node 24.20, and **5/5** on Mac Node 24.19 and 5070 Linux Node 24.20.
This covers credential-free accounts, exact authority loading without decryption, and preserved
cross-account/Gateway rejection. It does not establish full release or user-data migration acceptance.

### Native startup recovery fixtures — 2026-09-09

Commit `7a5343b2` prepares private ACLs on freshly created synthetic legacy startup files and
uses the host platform consistently in the startup, crashing credential and crashing settings
adapters. Production state transitions and recovery logic are unchanged. The fixture retains
checks for credential replacement/clear, failure before Account commit, recovered credentials,
settings redo and transaction-file removal.

`profile-workspace-startup-runtime.test.js` passed **3/3 without skips** on Mac Node 24.19 and
5070 native Windows/Linux Node 24.20. All three failed during platform/permission setup in combined
Windows `949bd0b`. The exact commit now reaches the intended simulated interruption and recovery
paths. This is not a real user migration, full Windows acceptance or package/release evidence.

### Native migration/runtime selection fixtures — 2026-09-09

Commit `90deca4d` replaces host-inconsistent `darwin` storage parameters in migration/runtime
fixtures with the host platform, and prepares private ACLs only on newly created synthetic legacy
files before migration. The orphaned-credential fixture also gets a valid ACL so the test reaches
the intended orphan-authority rejection. Production migration, recovery and data retirement remain
unchanged; simulated Windows adapter-call coverage remains separately injected.

The migration-runtime and pre-ready-selection suites passed **8/8, no skips**, on Mac Node 24.19
and 5070 native Windows/Linux Node 24.20. Six of these cases failed in combined Windows `949bd0b`.
The successful runs retain assertions for complete/credential-free migration, orphan rejection,
interrupted retirement recovery and verified destination selection during credential mismatch.
These synthetic filesystem cases are not user-data migration or a full Windows release gate.

### Native path fixtures — 2026-09-09

Commit `7ba6f912` corrects three host-path assumptions reproduced by combined candidate `949bd0b`:
the VS Code export now receives canonical Windows paths with spaces on Windows; the native resource
fixture and save-dialog default use host-native path construction. No production normalizer, export
adapter, clipboard, file write or executable resolution rule changed.

The generic-export-adapters, engine-process and integration-center-suite tests passed **8 tests /
2 existing Windows skips / 0 failures** on native Windows Node 24.20. Mac Node 24.19 and 5070 Linux
Node 24.20 each passed **10/10**. These are synthetic path/export assertions, not an installed
VS Code, SSH server, package or live-school canary. The prior combined full count remains 27 failures
until this follow-up is integrated and the full suite reruns.

### Credential/configuration rejection fixtures — 2026-09-09

Commit `d3726b45` establishes real owner-only ACLs on three newly created synthetic fixtures:
the malformed encrypted credential, valid custom Engine configuration and conflicting destination.
This makes the assertions exercise decryption, compiled Profile binding and content conflict rather
than fail during permission setup. The credential case additionally asserts one decryption call
and still proves no replacement/new entropy. No production code or rejection rule changed.

The external proxy credential, custom Engine config and destination-files suites passed **13 tests /
4 existing platform skips / 0 failures** on 5070 native Windows Node 24.20; Mac Node 24.19 and
5070 Linux Node 24.20 each passed **17/17**. These three failure sites were present in combined
Windows `f597bfa`. Full combined acceptance, installed-App and package checks remain separate.

### Native legacy input and retirement fixtures — 2026-09-09

Commit `50e8b790` prepares owner-only ACLs on newly created synthetic legacy source files before
collecting migration receipts. It also prepares the newly created empty rotated log and unexpected
source fixtures, so those cases reach content/absence checks rather than fail on setup permissions.
Production migration readers, retirement rules, receipt equality and deletion ordering are unchanged.

The `legacy-flat-source-retirement.test.js` and `legacy-migration-inputs.test.js` suites passed
**9 tests / 2 existing POSIX-only skips / 0 failures** on native Windows Node 24.20. The same exact
commit passed **11/11** on Mac Node 24.19 and 5070 Linux Node 24.20. Prior combined Windows
`f597bfa` had nine failures in these suites; no combined total is inferred without a fresh full run.
Fixtures cover receipt mismatch, unexpected sources, interrupted retirement/resumption, empty
diagnostics versus authoritative payloads, and zeroizing owners without using real user data.

### Native card/favorite storage fixtures — 2026-09-09

Commit `1c8b45db` changes only three test files. Four failures in the combined Windows run
at `f597bfa` used an explicit `darwin` file adapter on the Windows filesystem. Success paths now
use the actual host adapter and assert real Windows owner-only ACLs, or POSIX mode bits on POSIX.
The newly created synthetic v1 favorite document receives and verifies a private ACL before
testing schema migration. Existing user files are not touched; production ownership validation,
negative tests and persisted schemas are unchanged.

The card-board store, card-board Main runtime and favorite-group store suites passed **7/7**
with zero skips on Mac Node 24.19 and 5070 native Windows/Linux Node 24.20 at this commit.
This proves the scoped storage roundtrips and tests, not a green combined Windows release suite.
The combined integration branch and installed application have not yet consumed this follow-up.

### Native probe environment fixture follow-up — 2026-09-09

Test-only commit `1d9b2454` corrects two macOS probe fixtures which selected a macOS executable
and expected `TMPDIR` but implicitly inherited the Windows host platform. The native combined
release run at `f597bfa` reproduced both environment assertion failures. They now explicitly select
`darwin`; three additional cases independently assert the `darwin`, `linux` and `win32` environment
allowlists through the runner's injected spawn boundary. Proxy, certificate and token overrides
remain excluded. No production environment forwarding policy was changed.

`node --test test/unit/profiles/onboarding/gateway-probe-runner.test.js` passed **8/8**, without
skips, on Mac Node 24.19 and designated 5070 native Windows/Linux Node 24.20 at this exact commit.
These synthetic child tests do not contact a Gateway. They do not establish a green full Windows
suite or eliminate any other release gate. The combined release tree has not yet incorporated
this follow-up, so its earlier full-suite count remains unchanged.

This corrects one test domain, not the entire Windows suite. Other Windows fixture portability
failures remain separately tracked. No full Windows green-suite, package, live-school or new release
claim is made. No application data or credentials were read; all modified files were synthetic
temporary fixtures. GUI and package reruns are omitted because production runtime files are unchanged.

Reverting the test commit restores the old fixture setup without affecting application behavior
or persisted user data. No GitHub protection, required status name or release configuration changes
are part of this candidate.
