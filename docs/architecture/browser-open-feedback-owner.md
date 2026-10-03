# Browser command feedback owner

- Status: Proposed bounded fix for issue #222; not full M2/M3 completion
- Owner: Desktop Browser maintainers
- Last verified: 2026-10-04 (local source/native regression; exact-head CI in the PR)
- Applies to: CampusBrowserManager and Main Control/tray open commands

## Defect and boundary

At `main@c7184f76852f0f06d2fc206f8b8816ba3611313a`, Main cleared Browser feedback
before opening and again after a successful Manager result. Manager's internal
epoch checks protected opening, but not the later Main continuation. A Manager
close or context retirement after that result could make the old command clear
newer feedback and still return success.

The existing Browser Manager now owns `openWithFeedback`. It captures its current
open epoch before the initial feedback effect, rechecks before opening, after
completion/rejection and after the terminal effect. Retired results are the existing
`{ ok: false, stale: true }` shape; they never erase newer feedback. Current results,
error identities and feedback-effect exceptions retain their original semantics.

Main only delegates Control/tray opening to this existing public entrypoint. The
injected feedback effect still writes only the Browser notice and emits the same
status. Resource-library requests keep the lower-level `open` contract, without
new clear events. That method's URL/route validation, direct/local no-Engine path,
connection reuse and Browser creation are unchanged. No new request-order policy
is introduced for simultaneous commands in one unchanged epoch.

## Regression evidence

The original 23 Manager cases passed before movement. Eight new feedback cases
failed before the API existed, covering success, current failures, post-completion
retirement, windowless close, current/retired rejection, reentrant close, feedback
effect failure and the distinct resource-open contract.
An additional case failed when an effect retired the Manager and then threw;
the same epoch fence now covers both feedback effects and async rejection. Current
effect exceptions retain their original identity; retired ones become stale.

The actual Main/IPC/synthetic Engine fixture injects a retirement after the original
Manager successfully opens an isolated synthetic URL. Before the fix, it returned
success instead of stale. After the fix it must preserve the replacement notice,
healthy Engine and connected timestamp with no Browser window left. Injection is
test-process-only: no production environment switch or generic IPC field is added.
The fixture's original URL-only IPC boundary and 25-second budget are preserved.

Main falls from 699 to 689 lines; direct/effective/transitive dependencies remain
20/35/170, the production graph and private-edge inventory/cap 101 unchanged. The
line cap ratchets down. M3's remaining login/account and inline coordination still
require semantic review; M1/M2/M5, governance and reporter outcomes are independent.
Native synthetic and package evidence are not installed-app or live-school evidence.

## Compatibility and rollback

No Renderer/preload channel, persistent schema, Profile/Account/Workspace binding,
credential, MFA, routing, DNS, Engine protocol or dependency changes. Restoring Main
feedback wiring, the Manager entrypoint, matching tests and previous line ratchet
rolls back this slice, but reinstates the reproduced feedback race. User data is
not migrated and no installed application or system network is changed.
