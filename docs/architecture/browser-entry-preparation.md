# Browser entry preparation

- Status: Proposed source repair; exact-head/platform acceptance required
- Owner: Desktop maintainers; accountable maintainer heeh02
- Last verified: 2026-10-04
- Applies to: post-v2.0.3 source after `main@46b8326f80fd6d72514a5b41fd6a52fc51a14646`
- Supersedes: new Manager entries capturing an epoch before pending native-window cleanup

## Outcome and ownership

An explicitly opened page, feedback command or bookmark organizer first prepares an existing
Browser, then captures the Manager's current entry epoch. Preparation may retire old entries,
but must not make the new explicit command stale. An earlier pending connection wait remains
retired; feedback and organizer focus are still bound to the admitted epoch and Browser identity.

The existing `BrowserOpenOwner` validates context before and after synchronous preparation.
Its small Root facade is an internal service port, not a Preload API or Renderer export.
The native window owner remains the authority for destroyed-window cleanup and retained failure
causes. Preparation never creates/shows a window or retries an unconfirmed cleanup record.
Live ready/loading windows remain shared and untouched. Retired, failed, closing or unknown
records fail closed, including a vetoed native close and a primary toolbar-load failure.

The Manager records only a per-call admission result using its existing private epoch. A replaced
Browser or context-retired result stays quiet. Current preparation failure retains existing
localized command feedback and cannot begin a new Engine connection. Existing async checks,
accepted Session IO, routing policy, credentials/MFA and resource teardown remain unchanged.

Three unread Root copies of native constructors/Session factory are removed; the same original
objects already go directly to their Window, Tab and Session resource owners. This is not a new
factory, Session, state authority, dependency node or file-size-budget exception. Legacy injected
window factories without the new optional preparation port retain their existing clear behavior.

## Evidence

Four actual Browser + actual Manager baseline REDs cover page open, command feedback, organizer
focus and an earlier connection wait after native destruction without its close notification.
The first repair exposed a fifth rooted failure: unconfirmed cleanup still admitted an Engine
connection. The window owner now reports that original retained failure before admission.

Owner/Manager regressions additionally cover missing/live/shared-loading preparation, idempotent
retirement, reentrant context replacement, quiet context errors, current feedback, original failed
load cause, unknown-state rejection and unchanged dependency identity in resource owners.

Real Electron deliberately withholds only the owned native close observer, confirms destruction
while the original record is still unretired, then executes all three Manager commands against
the actual Browser. New entries succeed with one replacement tab and the same independently
owned Session. Marker: `native Browser Manager entry preparation: PASS`. This is a synthetic
fault-injection contract, not a claim that native close notifications are generally lost.

The complete Desktop suite, exact-source gates, native toolbar/MFA/strict proxy, Main startup/
cancel/Profile/relaunch, routing restart, migration and offline performance remain acceptance
requirements. Three-platform package checks and exact-final-main validation remain separate.
No GUI, keyboard, motion or layout change; existing narrow/standard/wide native checks remain.

## Risk and rollback

No persisted schema, wire DTO, URL-routing or credential changes; no dependency additions or
raised budgets. Native Window/Open/Manager owners remain below600; Browser root class remains
697, so M2 and the full convergence goal are not finished. Remaining creation/composition and
M1/M5/governance/reporter qualification still apply.

Revert this repair, its regressions/native fixture and this record together; no migration is
needed. That restores the reproduced stale-new-entry risk. No installed-app replacement,
immutable release/tag change, live school/private Gateway or active Clash/system network mutation.
