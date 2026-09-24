# Interactive-auth lifecycle and explicit activation

- Status: Behavior review candidate based on merged #117; not installed or released
- Owner: Desktop / authentication UI maintainers, issue #79
- Last verified locally: 2026-09-25
- Base: `main@aec107f` after PR #117
- Applies to: post-2.0.2 Renderer auth lifecycle, Issue #79

## Actual behavior change

The native public entrypoint provides `create`, its compatibility alias `createAuthChallengeFeature`,
the explicit convenience function `start`, and `MAX_RESPONSE_BYTES`. The instance has synchronous
`start`, terminal `dispose`, `render` and `clearResponse`. Creation only obtains required DOM nodes;
start acquires bindings and the subscription. Repeated start is idempotent; disposal prevents restart.
An owner disposed before start does not clear another owner's existing DOM.

`app.js` explicitly mounts `auth-challenge` through the existing feature host. The host's static
catalog uses the native public entrypoint. The old HTML script, `window.authChallenge` export and
legacy exception are removed; the eight-line facade is deleted, recoverable from PR #117/Git history.
No substitute HTML bootstrap or hidden timer starts the feature. Other legacy startup owners are
unchanged, so this is not completion of the whole M1 migration.

The view controller (208 lines) owns DOM bindings, visible metadata, response input, action state
and boundary timers. The lifecycle owner (49 lines) owns the initial snapshot and unsubscribe handle.
No architecture budget is raised; app.js remains 562 lines and one legacy global owner is retired.

## Isolation and cleanup

- Every new/cleared challenge advances the view revision. Old command success, failure and finally
  continuations cannot paint an error or unlock the new challenge. Retirement fences all revisions.
- Initial state is accepted only if no newer display event arrived, including an event delivered
  synchronously during subscription. A retired snapshot is ignored.
- Response input is cleared before invoking Preload, when a challenge clears/expires, on unload
  and on disposal. Empty, oversized, expired, cooling-down and unsupported synthetic actions do
  not reach Main. The existing 4,096-byte bound remains; long UTF-16 input is rejected before encoding.
- Disposal removes owned DOM/locale/unload listeners, cancels the timer (including handle zero),
  unsubscribes once and closes/clears owned UI. Cleanup errors do not skip subsequent cleanup.
  A missing unsubscribe contract fails startup and fences a callback retained by that invalid API.
- Partial startup, reentrant binding/subscription/timer retirement and canceled timer callbacks
  cannot recreate a live owner. A late method/result from a retired owner cannot clear a new owner.
- Locale changes repaint dynamic description/error text without replacing the challenge revision,
  erasing typed input or unlocking pending submission. This covers an existing challenge at startup
  before the application applies its effective language.

Disposal does **not** send a remote cancellation command: a command already issued to Main may
still finish, and Main/Engine retain transaction and account authority. These Renderer fences do
not add protocol identifiers, bypass MFA or prove real-school SMS/popup support. No IPC schema,
credential storage, Browser Session, Profile, account, routing or Engine source is changed.

## Historical acceptance — 2026-09-08

The first five regression tests failed on the parent implementation (new-challenge error pollution,
late errors after clearing, missing disposal, disabled actions reaching Main, non-idempotent start).
A separate locale-repaint test also failed before the repair. All now pass.

- Mac Node 24.19: auth/owner tests 26 passed; package/Renderer boundary tests 40 passed.
- 5070 Linux Node 24.20: full `node --test` — 1,383 passed, 6 platform skips, zero failures.
- Native 5070 Windows Node 24.20: auth, lifecycle, registry and package unit tests — 54 passed.
- `node e2e/renderer-module-asar.js` passed on Mac, Windows and Linux/Xvfb. Both startup languages
  restore a pre-existing synthetic challenge with the correct text; one submission clears input.
  Host pagehide then closes both auth/favorite dialogs, clears calendar/auth DOM, leaves zero auth
  listeners and ignores a subsequent fake challenge. Parent-confirmed child exit/profile retirement
  passed. HTTP(S) is blocked; fixture metadata and responses are synthetic.
- Mac `control-shell-layout.electron.js` passed. Architecture, staged-secret, install-script and
  governance gates passed. Exact-tree syntax passed 512 files at tree
  `15be367ae6bf7d6961ef1a4e05a718982e730220`.

Windows retains the existing GPU exit-code 34/state-invalid warnings. No full Windows Desktop
suite, real-school MFA, hardware-GPU acceptance or full installer verification is claimed. Package
verification now requires the native index/controller/lifecycle instead of the removed facade;
all three are exercised inside native ASAR fixtures, but full release-package gates remain required.
No Actions build, merge, tag, release, installed-App replacement, transfer or protection change ran.

## Rollback

Revert this behavior unit as a whole: restore the facade/HTML declaration, old controller API,
registry ownership and old package-required path together. PR #117's structural extraction can
remain. No persisted data migration or Engine rollback is needed. User sessions remain untouched.

## Current parent synchronization — 2026-09-11

Previous candidate: `4818009`. The parent above synchronized without conflicts or public-history
rewriting and includes published 2.0.2 fixes. Desktop lib, Rust, workflows, package manifest and
lockfile match that parent; the package verifier's changed required auth asset paths remain an
explicit review and full-package acceptance concern.

Tested integration tree before this documentation update:
`c1ff918659f103a7041bf69aa4a5e3095fde9de0`.
Mac Node 24 full Desktop suite: 1,408 passed, 14 platform skips, zero failures (1,422 total).
Node-owned native ASAR and control-shell fixtures passed. ASAR verifies both launch languages,
synthetic submission/input clearing, pagehide retirement with zero auth listeners, ignored late
events and confirmed child-close/fixture removal. Two macOS task-policy warnings occurred during
the ASAR run; they are not treated as a clean operating-system diagnostic result.
Architecture, install-script and diff checks passed without budget/dependency increases.

Windows/Linux native acceptance, full installers, real-school/MFA and long-soak tests were not
rerun for this tree. Older receipts retain their exact-source scope. No account password, real OTP,
installed app, user data, network setting, repository protection or Organization ownership changed.
Renderer retirement still does not cancel an already-issued Main operation or prove provider MFA.

## Current-main synchronization — 2026-09-25

The published #117 tree and the local structural parent tree were byte-identical. The
squash-history merge, including the deliberate deletion of the obsolete facade, preserved this
candidate's exact pre-merge source tree. On that tree, local Node 25 auth/lifecycle/registry tests
passed 39/39, as did the full Node suite, architecture/install-script/syntax/secret gates and
native ASAR child retirement. No real password, OTP, Gateway MFA or installed application was used.
Fresh platform CI and package verification remain separate gates on the final PR head.
