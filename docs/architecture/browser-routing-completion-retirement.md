# Browser routing completion retirement

- Status: Proposed source repair discovered by the M2 exit audit
- Owner: Desktop maintainers; accountable maintainer heeh02
- Last verified: 2026-10-05
- Applies to: post-v2.0.3 source after `main@4c78c502bf48b87eb233635c85c85e169907bf85`
- Supersedes: readiness success/failure continuing after accepted activation retires its Browser admission

## Observed failure

The M2 requirement-by-requirement review found that routing readiness checked context before
Session activation but not after the await. Actual Browser/Session regressions showed address
navigation and reload proceeding after context or ordinary close when native close was vetoed.
The original page and tab remained alive, so a tab-presence check did not retire that work.
An activation failure also escaped after its context had retired.

Seven baseline REDs cover context/reset retirement during accepted activation, retired versus
current failure, and actual address/reload after both close forms. This is a reproduced source
fault, not an assumed environment failure or a numerical-only M2 milestone.

## Ownership and behavior

`BrowserRoutingActivationOwner` owns one coordination generation in addition to its existing
flight record. Readiness captures it and revalidates generation, context and optional entry
admission before effects, after Engine readiness, after accepted Session activation, before
reading Session state, and after that read. A retired result is false; retired failures are
quiet, while a current failure preserves its exact original cause.

Ordinary close resets routing admission before requesting native close, even when another
cleanup fails or native close is vetoed. Confirmed close/reset remains repeatable; an old
completion cannot erase a replacement flight. Initial window creation does not reset routing
admission. The generation is a Browser coordination lifetime, not another Engine/Session state.

Already accepted configuration remains owned by `BrowserSessionManager` and its original
serialized intent/request gate. This repair does not roll back accepted IO, stop Engine, discard
shared cookies or rewrite routing/DNS/authentication. Superseding Session suspension remains
fail-closed. Direct routes still avoid Engine startup; both routes retain the same Browser Session.

The obsolete Root `refreshRoutingPolicy` method had zero repository callers and exposed an
alternate unfenced configure/route/UI sequence. It is removed rather than given a second policy
implementation. Existing `RoutingPolicyCoordinator` transactions and `BrowserRouteCommandOwner`
commands remain; their configure/suspend/resume/route/toolbar entrypoints are unchanged. There is
no Preload/wire/user API or persisted-schema change.

## Evidence and acceptance

Owner contracts cover activation/readiness failures, already retired contexts, independent
admission, reentrant state-read retirement, current readiness, shared flights and replacement
reset. Rooted tests use the actual Browser and Session manager with deferred PAC generation,
not a second policy implementation. Teardown tests retain independent cleanup/native-close
attempts after failure and ensure routing retirement precedes native close.

Real Electron keeps its synthetic HTTPS page in the actual shared Session, defers configuration,
vetoes the real native close and verifies zero late load/reload calls. Confirmed cleanup then
finishes; a later explicit open still works. Marker: `native Browser routing completion retirement: PASS`.
Original entry/creation/locale/route/credential/page/viewport/teardown and compact/standard/wide/
keyboard contracts remain. No GUI/CSS/motion redesign or real-school canary.

Complete Desktop, exact-tree syntax/secret/architecture/governance, native MFA/strict proxy,
Profile/relaunch/migration, routing/retirement and offline performance remain local gates.
Exact-head required CI, three-platform package and actual-final-main verification follow.
These are source/synthetic/native/package boundaries, not the original Windows/portal reports.

Root class598 ->592/source757 ->751; routing activation67, teardown80. Production240/451,
Main662/20 direct/35 effective/170 transitive, JS private-edge cap89 and root-test debt0 remain.
No dependency or budget growth. M2's size ceiling is satisfied, but the whole-wave exit receipt
remains pending until the audit and this repair's final acceptance are complete.

## Rollback

Revert generation/completion admission, close reset, unused Root-entry retirement, regressions/
native fixture/downward ratchet/docs together. No migration. It restores the reproduced stale
navigation/reload risk. No immutable release/tag, installed app, private/student data, active
Clash/system proxy/TUN/DNS/route mutation or new live-school authorization is involved.
