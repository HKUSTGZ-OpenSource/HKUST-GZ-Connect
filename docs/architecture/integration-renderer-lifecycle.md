# Integration Center Renderer lifetime

- Status: PR #120 behavior candidate based on merged #119; not installed or released
- Owner: Desktop maintainers, #79 / #81
- Last verified locally: 2026-09-25
- Runtime: `612a9dfb` (full SHA in Git); acceptance: `ea1620c4e9e7510bbe55abba18a251b28c27b424`
- Prerequisite: [Main scoped cancellation](integration-export-intents.md)

The public `create` factory owns document locale/state subscriptions and the controller's terminal
lifetime. The feature host explicitly mounts it beside auth-challenge; the old HTML initializer
and both Integration Center globals are removed. The native controller remains available through
its public entrypoint for injected tests. No private peer import or new global exception is added.

Operation and list revisions reject late results. Local cancellation closes the current dialog
immediately and sends only its validated confirmation handle. A late preparation result can
discard only its own handle; malformed metadata never triggers global cancellation. Confirmations,
refreshes, timer callbacks and translations cannot publish after retirement. Timer/listener removal
is explicit; cleanup errors remain observable. Startup/disposal are idempotent and disposal before
startup is terminal. Profile changes/logouts retire the current preview.

Dialog retirement clears metadata and timers. Delegated action buttons avoid per-render listener
accumulation. The unchanged layout, bilingual descriptions and copy/save-only surfaces remain.
The package verifier now requires all five native integration files. Main composition and Renderer
bootstrap line budgets did not increase; the controller remains below its 250-line ratchet.

## Historical evidence — 2026-09-09

- RED: all eight initial lifetime regressions failed before implementation.
- Twelve focused lifetime cases cover stale prepare/cancel/confirm/read, malformed/expired preview,
  modal failure, pre-start retirement, accepted-operation expiry and profile/locale subscriptions.
- Mac Node 24.19 and Linux Node 24.20 full suite at `ea1620c`: **1,427 passed / 6 skips / 0 failed**.
  Two initially stale startup/catalog assertions were updated to the exact four-owner contract;
  no feature permission or production guard was relaxed.
- Native Windows Node 24.20 focused Renderer/host/Main-intent/IPC/Preload tests at runtime source:
  **74 passed / 0 skipped / 0 failed**. Later commits change assertions only.
- Mac and native Windows Renderer ASAR fixtures pass through actual DOM button clicks, not removed
  globals. Pagehide closes an open integration modal, clears rows/metadata, and later state/locale
  events remain inert. Parent confirms Electron exit and fixture cleanup.
- Windows ASAR logged the previously observed GPU exit-code-34 warnings; clean GPU behavior is not
  claimed. Mac resource-manager and control-shell layout suites passed.
- Architecture, exact runtime syntax (519 files), indexed secret, install-script and governance
  gates passed. Shared dependency links do not introduce downloaded dependencies or build outputs.

ASAR APIs are synthetic and HTTP(S) is blocked. This is not actual user export, real-school,
installer/signature, full Windows or Linux Electron acceptance. The earlier separate Windows
full-suite baseline remains unaccepted; no reduction is claimed from this scoped run.

## Remaining scope and rollback

This completes the proposed integration host/controller retirement path, not the whole Renderer
migration, 2.0.2 release or governance goal. Keep this optional modularization stack separate from
the published 2.0.2 release. Revert native lifecycle/controller, bootstrap, registry, removed bridge,
package requirements and tests together. There is no persisted-data or credential migration.

## Current parent synchronization — 2026-09-11

Parent #119: `5b59c270ede8988e752d220b54ab3873a173b042`, above published 2.0.2 main.
Previous candidate: `64dd9ada67dc072ba267ce2b97ac6e5f63da1e7b`.
Conflicts in the two native-path fixtures retained synthetic absolute paths, spaces, the exact
default filename/parent, unsupported-adapter rejection and canceled-dialog assertions. Historical
documentation was reconciled without treating old Windows failures as a current run. No source
guard, ACL validator or global-export exception was weakened. Public history was preserved.

Tested integration tree before this documentation update:
`0d5aa6f64e3ba61bd3c2303ea5ce22cb069ecda0`.
Mac Node 24 full Desktop suite: 1,452 passed, 14 platform skips, zero failures (1,466 total).
Native Node-owned ASAR (synthetic export preview, host retirement, child close and fixture cleanup)
and control-shell layout passed. Architecture, install-script and diff checks passed without
dependency installation or budget increases. Existing dependency caches were reused.

Windows/Linux native acceptance, full installers and real user export/MFA tests were not rerun
on this tree. The earlier Windows baseline is historical and is not implicitly repaired by merging
PR #107's fixtures into the source. Full native/package checks remain required for this Main/IPC/
Preload and package-path change. No installed app, user configuration, release, protection or
Organization ownership changed. Completed clipboard/file effects cannot be retroactively undone.

## Exact-source Windows follow-up — 2026-09-11

Code commit: `7beadca7332bbd20ac0603273a67c92f2ddeb2d9`.
The existing proper-Git Windows full-suite inspection checkout was updated from historical
`3d323e2a0b99b0d89b3bfbf23a1bf21e934c77d5` using a 157 KiB incremental bundle. The native private-file
helper was rebuilt with the existing x64 compiler; no compiler, Electron or installer was installed.

The first Node v24.20.0 run reported 1,390 passed / 2 failed / 40 skipped (1,432 total): two test
files could not load because the reused dependency cache lacked declared dev dependency Acorn.
The Acorn 8.18.0 registry tarball was checked against the lockfile's SHA-512 integrity, then extracted
to an isolated tooling directory and exposed only through process-local NODE_PATH. No tracked
source, dependency declaration, assertion or platform skip changed.

The same code then passed the complete Windows suite: **1,426 passed / 40 platform skips /
zero failures (1,466 total)**. Native architecture and Node-owned ASAR module/lifecycle checks
passed, including confirmed child exit and fixture removal. One GPU process exit warning (34)
remains; clean hardware acceleration is not claimed.

This supersedes the historical Windows full-suite failure state for this exact commit, not the
limitations of earlier sources. Linux full-chain, full installers, real-user export and real-school
MFA remain unverified here. No installed application, user data, system setting, repository protection,
release or Organization transfer was changed. Local temporary transfer archives were removed;
the remote test logs and isolated tooling are retained for reproducibility.

## Exact-source Linux follow-up — 2026-09-11

Code commit: `7beadca7332bbd20ac0603273a67c92f2ddeb2d9`, the same as the Windows follow-up.
Reuse the existing 5070 WSL Git checkout, verified clean except its existing dependency symlink.
A 157 KiB incremental bundle advanced it from `95902b015b1ac8a9d03e0c4813e2c670827d0532`.

The initial Linux run reported 1,416 passed / 2 failed / 14 skipped (1,432 total); both failures
were test-file loading errors for missing Acorn, not failing assertions. Process-local NODE_PATH
then referenced the same lockfile-verified Acorn 8.18.0 already installed in the isolated Windows
tooling directory through WSL's mounted filesystem. No additional package download, source edit,
skip or assertion change was needed.

Node v24.20.0 with umask 022 passed the full Linux suite: **1,452 passed / 14 platform skips /
zero failures (1,466 total)**. Native architecture and `xvfb-run -a node e2e/renderer-module-asar.js`
passed, including child-close and fixture-removal confirmation, without a no-sandbox override.
Together with the preceding Mac and Windows receipts, this establishes full-suite source acceptance
on all three designated platforms for the code commit above, not full installer/signing acceptance.

Real export, campus MFA, long-soak and distribution-package checks remain outside these results.
No installed application, repository protection or Organization ownership changed. The initial
failure and successful retest logs remain on 5070; temporary transfer bundles were removed.

## Current-main synchronization — 2026-09-25

The published #119 tree and local parent tree were byte-identical. The squash-history merge,
including removal of the obsolete Integration Center initializer, preserved the exact candidate
source tree `fe26e104d59cb74e1ea55a316b62789761d0abec`. On that tree, local Node 25 focused
export-intent, IPC and Renderer lifetime tests passed 58/58; the full Node suite, architecture,
install-script, syntax (528 tracked files) and Git-index secret gates passed. Native macOS ASAR
child retirement and control-shell layout also passed. No real clipboard/file export, user
configuration, school account or installed application was touched. Fresh platform CI and package
verification remain separate gates for the final PR head.
