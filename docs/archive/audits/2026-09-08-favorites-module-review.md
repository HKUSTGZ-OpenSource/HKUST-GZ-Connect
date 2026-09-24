# Official favorites native entrypoint acceptance

- Status: Historical source acceptance; draft contribution, not release authority
- Owner: Desktop Renderer maintainers
- Verified: 2026-09-08
- Scope: Issue #79 / M1, second native feature entrypoint
- Base: `40dc7f4d4e733db81a6552cb3209d3ab7ac73ddb` (PR #108)
- Code: `ea3b9a5e0b66ed9b7cb9279a504efdbc6bb4115b`
- Tested tree: `03169349acf5fcc5fd6f35dba99b771becb165a4`

## Change and parity

The 184-line legacy wrapper becomes a 174-line native feature entrypoint. The application imports
the factory and the old HTML script is removed. A direct comparison with the base confirmed the
entire implementation body matches after indentation/export/wrapper normalization. There are no
intended behavior, stylesheet, localization, API, native resource or persistent-data changes.

The module-entrypoint test failed before extraction (missing native entrypoint). It now verifies
the two public exports, absence of the legacy script/factory and bounded module ownership.
Behavior fixtures cover existing and ungrouped placement, bilingual payloads, empty new-group
validation, ordered group/resource/move writes and a failed create that does not publish success.

## Actual evidence

- Mac Node 24.19.0 focused favorite/module/Renderer contracts: 22 passed.
- Native Windows Node 24.20.0 on 5070 via RBMS SSH: the same 22 passed, 0 skipped.
- 5070 Linux full Desktop on the exact code commit under umask 022: 1281 passed,
  6 platform skips, 0 failures. Windows used a fresh Git archive of that code.
- Mac Electron ASAR: both native feature imports load; the favorite chooser opens; no Window
  favorite factory remains; authentication has exactly one subscription.
- Mac Electron full control-shell, category expansion, schedule navigation, resource-manager and
  campus-workspace fixtures pass, retaining narrow/wide, keyboard and reduced-motion coverage.
- Native Windows full control-shell and category fixtures pass. GPU-process warnings (34) remain;
  hardware acceleration is not certified by these checks.
- Architecture, exact-tree syntax (478 sources), staged secret scan, install-script and governance
  checks pass. No architecture budget or required GitHub status name changed.

Focused command from desktop:

```sh
node --test test/official-favorite-dialog.test.js test/unit/renderer/official-favorites-behavior.test.js test/unit/renderer/official-favorites-module.test.js test/renderer-contract.test.js
```

## Native ASAR lifecycle follow-up (2026-09-08)

- Base: `54705558b01e71d0854e3cab80d47d6e25151e69`.
- Harness code: `52c16e2280a1e8312c37ccbc633dc4fec02e00c6`.
- Verified tree: `91c6ad32518d43020865ef1440d52c57089cbbfb`.

Native Windows exposed a false-green fixture: the loader assertions printed PASS, then deleting
the still-open Chromium profile failed with EPERM, yet Electron exited 0. Initial setup also
required a junction to the existing dependency cache; NODE_PATH alone did not resolve the ASAR
builder. Neither result was treated as a product authentication/permission failure.

The canonical command is now `npm run test:renderer-asar`, which starts a Node parent and a
bounded Electron child. The parent waits for close, verifies the generated directory's identity,
deletes it and checks absence before printing lifecycle PASS. The child uses the parent's isolated
directory (including spaces in its path) and no longer attempts pre-exit cleanup. Unhandled child
rejections fail explicitly. Normal application, Renderer, IPC and storage code are unchanged.

The runner rejects nonzero exit, missing success marker, unconfirmed close, launch error, timeout,
interrupt and output overflow. Execution is limited to 20 seconds, with bounded termination/close
grace; diagnostic capture is capped at 1 MiB of both incoming bytes and printable UTF-8. An output
fixture caught the initial multibyte-boundary accounting error; decoding is now stream-aware.
Root cleanup refuses changed identity or symlinks and propagates failure instead of hiding it.

- Mac and native Windows: 3 parent-runner tests pass, exercising real child success, failed exit,
  timeout and Unicode output overflow, plus cleanup identity/failure cases.
- Mac, native Windows, and Linux under existing `xvfb-run`: actual ASAR module loading and
  post-close cleanup both PASS. No sandbox or system permission override was used.
- 5070 Linux full Desktop: 1284 passed / 6 platform skips / 0 failures.
- Architecture, exact-tree syntax (480 sources), secrets, install-script and governance gates pass.
- Native Windows GPU warnings (34) remain; these tests do not certify hardware acceleration.

The original failed Windows fixture directory was separately checked and removed after its process
had exited. It contained only generated staging/profile data and can be recreated from source.
The shared dependency cache and installed application data were not removed or changed.

This closes the native Windows/Linux ASAR loader gap for this source, not full installer/signing,
real-school or production lifecycle acceptance. The earlier Windows-ASAR omission below is historical.

## Original phase limits and rollback

No new lifecycle cancellation/disposal guarantee is claimed. Already-dispatched Main operations,
shared registry/global-export enforcement, full Windows unit tests, Windows ASAR, native installers,
signing and real-school validation remain outside this phase. All data is synthetic; user profiles,
accounts, sessions, credentials and the installed app were not changed.

The parent feature repairs must be preserved when reverting only this extraction. The contribution
remains a draft for independent review and required-check disposition. No Actions dispatch, GitHub
PR merge, tag, release, repository transfer or protection change was performed.

## Post-release parent synchronization — 2026-09-10

Parent: PR #108 at `649397b6df436624b0db90463b00807987550a86`, including published
main `39850415c901aeaa77ecb86cd3ce49a2e75290a8`. Previous candidate:
`88813e0f3994eba0673439017926de9fde7fd3d5`.
Tested integration tree: `88b98766ba62aed4a57bbefc0d414ced02f08f60`.

The parent merged locally without conflicts or history rewriting. The remaining 16-file difference
is the official-favorites entrypoint, its tests/ASAR runner and review records. Desktop lib, Rust,
workflows and dependency lockfile match the parent exactly. The package manifest adds only the
existing ASAR fixture command, not a dependency or release-version change.

Mac Node 24 full Desktop suite: 1,317 passed, 14 platform skips, zero failures (1,331 total).
Architecture and install-script checks passed. The Node-owned native ASAR runner passed both module
assertions and child-close/fixture-retirement checks. Resource-manager and campus-workspace Electron
layout tests passed. Tests reused the existing dependency cache without installation.

This synchronization does not import the separate #115 save-continuation lifecycle behavior into
the structural PR. Parent calendar, security-storage and ProxyCommand repairs remain preserved.
Windows/Linux native validation, installers and real-school canaries were not rerun for this tree;
earlier receipts do not stand in for new exact-source platform acceptance. No installed app, user
data, GitHub protections, release or repository ownership changed. Revert only the favorites
extraction on the current parent to retain its already-delivered repairs.
