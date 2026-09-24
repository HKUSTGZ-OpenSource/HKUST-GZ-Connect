# Native Browser downloads and context retirement

- Status: Historical lifecycle review receipt; source merged in #113, not a release claim
- Owner: Desktop / Browser maintainers, related to issue #80
- Last verified locally: 2026-09-25
- Structural base: `main@8024fa8` after PR #112
- Applies to: Browser download owner, manager disposal and synthetic download acceptance

## Reproduction and behavior

Historically, the algorithm waited for a custom save dialog before attaching native completion
callbacks. A Mac native regression reproduced a completed file with the owner still reporting
`downloading`; #126 fixed that timing, and merged #112 preserved the fix in the extracted owner.
This #113 unit retains the native timing behavior and adds context/Session retirement guarantees.

The owner now synchronously configures Electron's native picker with `setSaveDialogOptions` and
registers item events inside `will-download`, without awaiting a second save dialog. This follows
the [Electron DownloadItem contract](https://www.electronjs.org/docs/latest/api/download-item).
Completion snapshots the native selected path before awaiting the explicit reveal-in-folder prompt.
Native cancellation clears only that item's visible progress, silently; it cannot erase a newer
download's presentation. Unknown lengths remain unknown, and percentages remain bounded.

The owner has an idempotent retirement boundary. It detaches item callbacks, clears presentation,
and schedules exactly one cancellation per active item after the native observer unwinds. Retired
Sessions keep a deny-only listener without retaining their old owner. A new owner for that Session
replaces the old binding. Stale callbacks cannot report progress/errors or reveal a completed path.

Manager disposal retires downloads immediately. Context-switch closure retires them only after
Browser closure is confirmed; a veto leaves the existing owner intact. A late old-context close
cannot clear the replacement Browser or its portal-session hint. Ordinary window closure is not
treated as manager disposal, but an old download cannot open a completion prompt in a replacement
window. Revealing a file remains an explicit user action, never automatic execution.

The owner is 155 lines, within the 600-line target. CampusBrowser remains 1,804 lines, so M2 is not
complete. Main's direct/transitive dependency caps remain 36/170. No Renderer, credential storage,
Profile schema, routing policy, live-school API or system network setting is changed.

## Historical exact-source evidence — 2026-09-08

Run from `desktop/`, reusing existing designated-host dependencies:

| Check | Result |
| --- | --- |
| `node --test 'test/unit/browser/**/*.test.js'`, Mac Node 24.19 | 166 passed |
| Same command, Windows 5070 native RBMS SSH / Node 24.20 | 165 passed, 1 platform skip |
| `node --test`, Linux 5070 Node 24.20 | 1,254 passed, 6 platform skips |
| `node e2e/browser-native-download.js`, native Mac and Windows; Linux under xvfb | complete, cancel and active-transfer retirement passed; child close and fixture deletion confirmed |
| `electron e2e/campus-browser-toolbar.electron.js`, Mac | passed |
| `electron e2e/campus-popup-mfa-safety.electron.js`, Mac | existing synthetic assertions passed |
| Architecture / install-script / governance / exact index secret gates | passed |
| Exact-tree syntax, `938c86395abd8e08a5f474cecac43c5f0d876e82` | 466 files passed |

The native fixture serves only a loopback synthetic payload. A first test listener supplies a
temporary selected destination synchronously, so no OS save dialog opens. It checks actual file
bytes, native options, terminal status, cancellation after partial transfer, empty owner registries,
no post-retirement UI effects and parent-confirmed temporary-directory removal. It uses software
rendering deliberately; this is not GPU or OS file-picker UI acceptance.

The parent fixture helper is byte-identical to PR #111's tested helper. A read-only merge-tree check
of the runtime with PR #111 head `ebd3284584ba998ed93fcc967bcc7997711e2f35` produced conflict-free tree
`d17c3e5bb5ee980f71d748e89a12029534b28a2e`; this is an integration tree, not a GitHub merge or main.
Windows native MFA with that tree confirmed assertions, child close and profile removal. Windows
still emitted the known GPU process exit 34 warning in MFA; hardware acceleration remains unverified.

## Limits, integration and rollback

The native fixture does not automate a real user's OS save-dialog choice. Full Windows unit tests,
Mac x64 hardware, signed packages, long-running performance/soak and live-school checks were not run.
The old Windows MFA child-only harness is not a clean gate by itself; use PR #111's parent runner
when integrating these changes. Synthetic MFA is not proof of live-provider compatibility.

Review the structure-only extraction separately, then this behavior repair. PR #111 is independently
reviewable and its shared helper has no production dependency. Do not import the older backend
candidate chain or overwrite the current Renderer improvements. No release, installed application
replacement, repository transfer or branch-protection change is included.

Rollback reverts this lifecycle change to merged #112, removing manager retirement wiring while
retaining #126's synchronous native-save algorithm; no user data migration is needed. The
stale-callback and active-transfer retirement defects would return and must be recorded as unresolved.

## Current synchronization — 2026-09-12

Previous candidate: `6a66ccfa335045da6210fe494269cc5bf51a4f95`. The structural parent above
synchronized without conflicts or history rewriting and contains published 2.0.2 main.
Tested integration tree before this documentation update:
`d8ee1bf24c11a8d3ee97a3c70dfd5ff4bab7e363`.

Mac Node 24 full Desktop suite: 1,317 passed, 14 platform skips, zero failures (1,331 total).
The Node-owned native DownloadItem fixture passed completed byte verification, silent cancellation
and retirement during active transfer; child closure and temporary-directory removal were confirmed.
It used only a loopback synthetic server and test-owned destination, not a school endpoint or user
Downloads directory. No real OS file-picker choice or hardware acceleration acceptance is implied.
Architecture, install-script and diff checks passed without increased budgets or dependencies.

Windows/Linux native downloads, full installers, popup-MFA cleanup and live-school canaries were
not rerun for this synchronized tree. Older receipts retain their original source scope. No installed
app, saved credentials, user browser data, network settings, release, protection or Organization
ownership changed. The Renderer candidate chain is not imported into this main-based Browser lane.

## Current-main synchronization — 2026-09-25

The published #112 tree and the local Browser owner parent tree were byte-identical, so merging
its squash history preserved this lifecycle candidate's exact source tree. On that tree, the full
local Node 25 suite, architecture/install-script/syntax (531 tracked files)/secret gates, the
native loopback DownloadItem bytes/cancellation/retirement fixture, Campus Browser toolbar and
20-tab synthetic performance/soak fixture passed. Tab-switch p95 was 1.2 ms against the unchanged
250 ms offline disaster guard. No real OS save choice, user's Downloads directory, school account
or installed app was touched. Fresh Windows/Linux/macOS CI remains a separate gate on the PR head.
