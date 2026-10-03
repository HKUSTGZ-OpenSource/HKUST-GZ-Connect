# Queued Browser routing single-flight repair

- Status: Proposed source repair for #207; not a release or live-network acceptance
- Owner: Desktop Browser maintainers
- Last verified: 2026-10-03
- Applies to: candidate based on validated `main@5ca8d6d68d15b7b2c9fcc250448f94d7a5f3d0e9`

The existing Browser method awaited one original in-flight Session transition. If
several requests were waiting, the first follower could start a replacement while
other followers continued without checking it. A synthetic invocation of the
actual production method reproduced duplicate same-port transitions and overlapping
different-port admission. This is not proof of a reported live connection failure.

Admission now rechecks the current flight after each await and reuses the current
Session only when its port is ready and the request gate is open. A queued
same-port follower shares the replacement flight; another port waits before
re-evaluating the authoritative Session. This loop only coordinates existing
configure/resume operations. It does not apply PAC, change route policy, retry a
rejected operation, modify context/Engine authority or introduce a new owner.

The new tests call `CampusBrowser.prototype.activateRoutingPolicy`, not a duplicate
implementation. Before the fix, the two queued-request regressions fail while four
reuse/resume, rejection, fail-closed and reset cases pass. After the fix all six
pass. Existing Browser/Session/context retirement and native Electron checks
remain required separately; synthetic evidence is not real Gateway or campus access.

Keep this behavioral fix separate from #80's pure ownership move. No dependency,
wire/schema, persistence, GUI, global network, third-party configuration or installed
application change. Rollback reverts the method, regression and this record together.
