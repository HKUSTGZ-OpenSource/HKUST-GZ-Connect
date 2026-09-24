# Integration Center Renderer ownership

- Status: Structural review candidate based on merged #118; not installed or released
- Owner: Desktop / integration maintainers, issue #79
- Last verified locally: 2026-09-25
- Base: `main@f506031` after PR #118
- Applies to: Issue #79, post-2.0.2 Integration Center structural extraction

## Public boundary

`desktop/renderer/features/integration-center/index.mjs` exposes `adapterView`, `previewView` and
`createIntegrationCenter`. Its native import has no browser globals or startup effects. The model
owns the existing adapter/action/display-state validation and redacted preview projection. The
controller receives its API, document, translator, clock and timers through existing parameters.
Native peer imports must use the public entrypoint; the adapter set remains an internal model detail.

The model is 61 lines, controller 206 and public entrypoint two. The old 293-line file is now a
22-line compatibility initializer with a 24-line ratchet; model/controller ratchets are 80/250.
It retains the existing two global names and locale/state event wiring. HTML declares this bridge
as a module, alongside the already-deferred legacy consumers. No new global exception, bootstrap
exception, package dependency or architecture budget is introduced.

Only the existing Clash/Mihomo YAML copy/save and VS Code Remote-SSH template copy surfaces remain.
This adds no SSH manager, terminal, application installation or automatic third-party configuration
edit. Main still owns generated content, destinations, profile binding and confirmation consumption;
Renderer receives metadata and an opaque handle, not exported content or credential values.

## Structural fidelity

A one-off comparison against the base verified the model/controller bodies are unchanged except
for module exports/imports and indentation. A further 120 adapter/action/expiry preview cases
matched the old implementation. Public function references remain identical through the bridge.
Existing projection, independent-adapter availability, confirmation and expiry tests remain intact;
the credential-boundary source assertion now scans the bridge and both native implementation files.

This is deliberately **not** the lifecycle repair. The legacy initializer still subscribes to
document events and the controller lacks complete disposal/async publication ownership. It is not
added to the feature host with a fake disposer. The next separate behavior unit must verify late
prepare/refresh/confirm/cancel results, timer/dialog retirement and cancellation ownership before
removing that initializer. In particular, a retired UI must not cancel another context's pending
export through an unscoped cancellation call. No fix for that lifecycle boundary is claimed here.

## Historical acceptance — 2026-09-08

- Mac Node 24.19: existing/new integration Renderer and strict-proxy boundary tests — 16 passed.
- 5070 Linux Node 24.20: full `node --test` — 1,388 passed / 6 platform skips, zero failures.
- Native 5070 Windows Node 24.20: the same 16 related tests passed.
- `node e2e/renderer-module-asar.js` passed on Mac, Windows and Linux/Xvfb. Both languages show two
  export adapters on initial startup without a manual refresh. A synthetic prepare/confirm displays
  the 512-byte metadata summary and succeeds without exposing installation actions. Existing
  auth/favorite/calendar retirement coverage remains active, including reopening the favorite
  dialog before host teardown. Node parent confirmed child exit and fixture-profile deletion.
- Mac `resource-manager-layout.electron.js` and `control-shell-layout.electron.js` passed. Their
  real DOM checks include compact export preview/confirmation and narrow/wide/zoom layout.
- Architecture, staged-secret, install-script and repository-governance gates passed. Exact-tree
  syntax passed 516 files at `434c9829bc15705c5359bae63de108651a386c83`.

ASAR APIs are synthetic and HTTP(S) is blocked. No actual clipboard/configuration export, real
school account, full Windows suite or installer/signature validation is claimed. No Actions build,
application replacement, merge, release, repository transfer or protection change ran. Installed
Mac archive remained `705d83f90356cf3b1973d723f4d785765cba4adbba53843394d32c5a013baf0c`.

## Rollback

Revert the native files, compatibility bridge, HTML module declaration and matching registry/tests
together. The facade/package path is unchanged. No data schema, Main, Preload, routing, Session,
credential storage or Engine migration is involved. Other feature lifecycle repairs can remain.

## Current parent synchronization — 2026-09-11

Previous candidate: `f520db3`. The parent above synchronized without conflict or public-history
rewriting and includes published 2.0.2 plus the preceding reviewed candidates. The remaining
twelve-file difference is the native model/controller, bounded bridge, matching tests/registry
and review records. Desktop lib, Rust, workflows, manifest and lockfile match the parent exactly.
Separate #120 export-intent/cancellation lifecycle changes are not included in this extraction.

Tested integration tree before this documentation update:
`dc8ebbf883005694cd2834e22a5da773ec6c2b27`.
Mac Node 24 full Desktop suite: 1,413 passed, 14 platform skips, zero failures (1,427 total).
Native Node-owned ASAR startup/synthetic preview-confirm/child-close/cleanup and control-shell
layout checks passed. Architecture, install-script and diff checks passed with no budget or
dependency increase. Existing dependency caches were reused, not reinstalled.

Windows/Linux native, full installers, live-school/MFA and actual clipboard/configuration exports
were not rerun for this tree. Earlier receipts retain their original scope. No installed app,
user settings, file export, repository protection, release or Organization transfer occurred.

## Current-main synchronization — 2026-09-25

The published #118 tree and local parent tree were byte-identical; merging squash history left
this candidate's source tree unchanged. On that tree, local Node 25 integration/proxy/Renderer
boundary tests passed 36/36, as did the full Node suite, architecture/syntax/secret gates, native
ASAR synthetic preview/confirmation with child retirement, and control-shell layout. No actual
clipboard/file export, user configuration, real account or installed app was touched. #120 remains
the separate export-intent and async lifecycle repair; fresh platform CI is required for this head.
