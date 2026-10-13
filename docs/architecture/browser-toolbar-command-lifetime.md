# Browser toolbar command lifetime

- Status: Proposed M2 lifecycle repair; exact-source/native/platform acceptance required
- Owner: Desktop maintainers; accountable maintainer heeh02
- Last verified: 2026-10-13
- Applies to: toolbar command repair against `main@7e45000f04f3eb7fd4618e1d52095e6c6d475a40`, not a released or installed application

## Contract

`BrowserToolbarCommandOwner` owns bounded dispatch and per-window find state. A successful or
failed asynchronous action does not itself prove that its initiating window is still current.
The base could report an old resource error after close or refresh a replacement toolbar.

Each command/shortcut captures native window identity and the command owner's generation. Late
publication also checks current context and native destruction. Resource completion and all
existing asynchronous error callbacks publish only while that admission remains current.
Navigation, route, credential and resource transactions stay with their original owners;
this repair does not cancel/replay their work or replace their admission policy.

Repeated `reset()` invalidates old publications and erases per-window find state. The existing
teardown coordinator independently attempts this reset before close, after native close and
before creation; one cleanup failure does not skip other owners or erase unconfirmed resources.
The optional cleanup port preserves callers that have no toolbar-command owner. Current
windowless value-free facade commands and synchronous action exceptions keep their contracts.

No GUI/CSS, payload or IPC channel, Profile/Account/Workspace identity, persistence, dependency,
Engine/protocol, system networking or release change. Root composition injects context and
cleanup ports; no second navigation/routing/credential authority is introduced.

## Evidence and rollback

Eighteen baseline RED cases cover late successes/errors after close/replacement/context/reset,
toolbar and keyboard paths, admission and repeatable find cleanup. Existing current feedback and
synchronous controls remain. Native evidence uses a new isolated Browser, Chromium-blocked
synthetic URLs, actual close/reopen and close veto; no user session or Gateway is involved.

Full Desktop, actual Main/Profile/MFA/strict-proxy, exact-tree source gates and three-platform
package checks remain acceptance prerequisites. These bounded repairs do not establish complete
M2 or original reporter acceptance. Revert owner/context/cleanup ports, tests and this contract
together for rollback; no data migration, but the old stale-publication risks may return.
