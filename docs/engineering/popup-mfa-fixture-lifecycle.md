# Popup MFA fixture lifecycle

- Status: Proposed test-gate repair; not a product MFA change
- Owner: Desktop / Browser maintainers, related to issue #80
- Last verified: 2026-09-12
- Applies to: `desktop/e2e/campus-popup-mfa-safety*` and its Node test support
- Base: `main@39850415c901aeaa77ecb86cd3ce49a2e75290a8` (published 2.0.2)
- Tested source: `03e81dd3af8703c788be0effd91d8ec989b964ff`

## Failure and correction

Current synchronization: previous candidate `ebd3284584ba998ed93fcc967bcc7997711e2f35`
merged the published main above without conflict or history rewriting. Tested tree before this
documentation update: `2d4cd05ff8314a5e5ec8a0e3d54e40401b2461d9`.
Mac Node 24 full Desktop suite passed 1,304 tests, skipped 14 platform cases, failed zero (1,318 total).
The native Node-owned popup fixture passed assertions, child closure and temporary-profile removal;
architecture and install-script checks passed. Production Desktop lib, Renderer, Rust, workflows
and lockfile match main exactly. The manifest changes only the existing test runner command.
No dependency installation, installed-app change or live-school login occurred. Windows/Linux
native cleanup and full installers were not rerun on this synchronized tree; older results below
retain their original source scope. This is a test-gate repair, not product MFA acceptance.

The prior Windows native run printed PASS before its asynchronous fixture cleanup tried to remove
an Electron profile that Chromium still held open. Cleanup threw EPERM, the rejection was unhandled,
and the process still returned zero. Assertion success alone was therefore misleading.

Run `npm run test:campus-popup-mfa-safety` (Node parent), not the `.electron.js` child directly.
The existing workflow command and status contexts remain unchanged. No workflow is edited.

The Node parent creates and records the identity of one temporary profile, launches Electron, and
waits for authoritative child `close`. It then verifies the root identity, removes the profile and
checks its absence. Only successful assertions, zero child status and successful cleanup produce
the final PASS line. Unknown close, signal, launch error, interruption, timeout, excess output,
unhandled rejection or cleanup failure cannot produce success. Unknown-close fixtures are retained,
not recursively deleted while an unconfirmed process may still be using them.

The execution deadline remains 20 seconds. On failure, termination has a bounded cleanup grace;
output capture is limited to 1 MiB. Windows termination targets the owned child PID tree, and POSIX
termination targets the child's dedicated process group. The cleanup root must still be the exact
directory created by this invocation, not a replacement or symlink. There is no detached deletion
helper whose result can be lost.

The Electron child validates its parent-supplied temporary path, keeps its synthetic assertions,
reports runtime cleanup errors and exits nonzero on rejection. It no longer deletes an active
Chromium profile. Browser production code, stored credentials, Profile/Workspace schemas, routing,
real-school URLs and live authentication are untouched.

## Evidence on the tested source

| Command / environment | Result |
| --- | --- |
| `node --test test/unit/browser/mfa/fixture-lifecycle.test.js`, Mac Node 24.19 | 3 passed |
| Same command, Windows RBMS native SSH / Node 24.20 | 3 passed |
| `node --test`, Linux 5070 / Node 24.20 | 1,241 passed, 6 platform skips |
| `node e2e/campus-popup-mfa-safety.js`, Mac native Electron | assertions + child close + profile removal passed |
| Same command, Windows native Electron via RBMS SSH | assertions + child close + profile removal passed |
| Same command under `xvfb-run -a`, Linux 5070 | assertions + child close + profile removal passed |
| Architecture / install-script / governance gates | passed; production dependency caps unchanged |
| Exact-tree syntax, `4ec08ed5b0e9048e813f72274985171564c91cea` | 465 files passed |
| Exact index secret gate | passed |

Node tests cover actual child success/nonzero exit/timeout/Unicode output flood and fault-injected
cleanup/identity changes. Linux uses the existing dependency cache via NODE_PATH; Windows executes
Node through native RBMS SSH, not WSL-to-Windows interop. No dependency installation was needed.

Windows still emits GPU process exit 34 warnings. This repair does not establish hardware GPU
stability. No full Windows unit suite, Mac x64 device, package/signing, performance/soak or live-school
test was run. Synthetic opener messaging, shared-cookie and OTP-safety assertions do not establish
compatibility with a school's current live MFA provider.

## Integration and rollback

This test-only change is directly based on main, independently of the download-owner candidate
and Renderer PR chain. It does not require importing either branch. The parent runner follows the
owned-child pattern previously reviewed in the ASAR candidate; consolidating that candidate onto
this reusable support module is a subsequent test-only integration, not a production dependency.

Rollback reverts this isolated test commit and its npm command; it requires no user-data migration.
That also restores the known false-green risk, so the old Windows PASS must not be used as clean
release evidence. Merge, publication, Organization transfer and protection changes remain separate
maintainer decisions.
