# Interactive-auth Renderer boundary

- Status: Structural PR #117 record; the #118 lifecycle supersedes its compatibility facade, with no app release
- Owner: Desktop / authentication UI maintainers
- Last verified locally: 2026-09-25
- Applies to: M1 after merged localization ownership PR #116

## Public ownership

The following records the separately proposed structural step. Its compatibility startup is
superseded in the subsequent proposed [lifecycle unit](renderer-auth-challenge-lifecycle.md), which
owns disposal and explicit host activation. Do not treat the old facade description as current code.

`desktop/renderer/features/auth-challenge/index.mjs` exports `createAuthChallengeFeature`,
`MAX_RESPONSE_BYTES` and `start`. Importing this native entrypoint has no global export or automatic
startup. The controller receives `api`, `document`, `i18n` and an event `target`; factory tests can
also inject the clock and timer functions. It does not import peer internals or select real school
endpoints. Engine transaction/session identifiers, account passwords and protocol interpretation
remain outside this display-only metadata boundary; the typed response is transient input, cleared
from the DOM before invoking the bounded Preload method.

This is a structural extraction: retain the existing 4,096-byte response bound, non-numeric
one-time-code semantics, unknown-kind behavior, cancellation, expiry and resend cooldown, and
subscription-before-initial-snapshot ordering. A newer challenge event still fences the older
initial snapshot. Existing field IDs, translations and styles are unchanged.

## Deliberate transition boundary

The old `renderer/auth-challenge.js` is an eight-line compatibility entrypoint with a twelve-line
test ratchet. It preserves the existing `authChallenge` export and zero-delay automatic startup
while injecting its window dependencies into the native owner. No new global allowance is added.
Its HTML/module and package-verifier paths remain unchanged; shipped resource requirements are
not weakened to accommodate extraction.

This is **not** complete M1 startup migration. The host catalog deliberately does not mount this
owner: the old API does not yet return a complete `dispose`, track unsubscribe or fence every
pending command against a replaced challenge. Do not supply a no-op cleanup to satisfy the host.
The next independently reviewed behavior unit must own listener/timer teardown, transient input
clearing, late async completion and explicit bootstrap activation before retiring the facade.
No claim that these pre-existing lifecycle gaps have been fixed is made here.

## Historical evidence — 2026-09-08

- Base: `90937ab2b6ea2d96dcbeae6c3a1d4314c1d940e6` (PR #116).
- Tested source: `3d009c201dc301041bc41a0e3a079f547e2ac038`; the final review commit only adds
  this receipt and removes one empty trailing controller line.
- Mac Node 24.19: 9 auth-owner/legacy behavior tests and 25 Renderer boundary tests passed.
  Coverage includes initial snapshot/event ordering, initial restoration, input clearing before
  submission, byte bounds, Escape cancellation, timer-driven cooldown/expiry and the legacy ratchet.
- 5070 Linux Node 24.20: full `node --test`, 1,366 passed / 6 platform skips, zero failures.
- Native 5070 Windows Node 24.20: 9 auth-owner/legacy behavior tests passed.
- `node e2e/renderer-module-asar.js`: Mac/Windows/Linux-Xvfb passed Chinese and English startup,
  exactly one auth listener, actual modal open, one synthetic submission, immediate input clearing,
  close, and existing calendar/favorites/chrome regressions. The parent confirmed Electron exit
  before deleting each isolated fixture profile. HTTP(S) is blocked and no school account is used.
- Mac `control-shell-layout.electron.js` passed. Architecture, exact-tree syntax (511 files),
  staged-secret, install-script and repository-governance gates passed.

Windows continues to emit the existing GPU process exit-code 34 warning. A full Windows Desktop
suite, full installer verification, popup-MFA device acceptance and real-school MFA are not claimed.
No Actions build, application replacement, merge, release, repository transfer or protection change
is authorized by this receipt. Installed user settings, sessions and credentials are untouched.

Rollback reverts the controller/entrypoint extraction, compatibility facade and matching registry
and tests together. No data migration or Engine rollback is required.

## Current synchronization — 2026-09-11

Parent #116: `c5c89dc841c3e811c27494841c48d3d50a2b5136`, above published 2.0.2 main.
Previous candidate: `3e44771`. Parent synchronization was conflict-free and preserved public history.
The ten-file difference remains the auth module/facade, registry, tests and review records; Desktop
lib, Rust, workflows, manifest and lockfile match the parent exactly. The separate #118 lifecycle
work is not included or represented as fixed by this extraction.

Tested integration tree before this documentation update:
`de9fd2e9caea49dfd1e6e5e1051c71be004df531`.
Mac Node 24 full Desktop suite: 1,391 passed, 14 platform skips, zero failures (1,405 total).
Node-owned native ASAR checks passed bilingual startup, one auth listener, synthetic modal/input
submission and input clearing, plus child-close/fixture-cleanup confirmation. Control-shell layout
also passed. Architecture, install-script and diff checks passed without increased budgets or
dependency installation. Existing caches were reused and the temporary dependency link removed.

Windows/Linux native acceptance, installers and real-campus/MFA tests were not rerun on this tree;
earlier results remain historical. No real password, OTP or school response was used. No installed
app, user data, settings, release, Organization transfer or protection change occurred.

## Current-main synchronization — 2026-09-25

The merged #116 tree and its local parent tree were byte-identical, so the squash-history merge
preserved this candidate's exact source tree. On the current tree, the local Node 25 auth/boundary
tests, full Node suite, architecture/install-script/syntax/secret gates, synthetic bilingual native
ASAR and control-shell layout passed. No real Gateway MFA, installed application or user account
was exercised. Fresh platform CI remains a separate gate on the final PR head.
