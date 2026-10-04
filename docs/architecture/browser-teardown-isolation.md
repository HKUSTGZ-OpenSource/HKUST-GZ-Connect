# Browser teardown isolation

- Status: Proposed M2 source repair; exact-head/platform acceptance required
- Owner: Desktop maintainers; accountable maintainer heeh02
- Last verified: 2026-10-04
- Applies to: post-v2.0.3 source after `main@87d003bd89e2130042a9ab66875c52c837570a4c`, not installed/released behavior
- Supersedes: fail-fast cross-owner Browser close sequencing

## Outcome and boundaries

`BrowserTeardownOwner` coordinates independent Browser cleanup through the existing Session
entrypoint. It does not own a second window, tab list, routing state, credential algorithm or
storage policy. The Browser root only composes its existing owners and delegates pre-create,
cancel, public close and native-close cleanup. One failure must not suppress another owner's
cleanup or the native close request. Failure causes are aggregated, not reported as success.

After native closure, all page/popup and presentation owners are attempted. Tab/view references
are committed clear only when those attempts succeed. Failed native window cleanup retains the
existing fail-closed window record and blocks replacement/Profile retirement; this repair does
not invent automatic retry or bypass the existing window owner's incomplete-cleanup contract.
An owner's explicit cleanup retry may release its resources, but does not silently clear that
failed window record. Ordinary successful close/reopen, Session cookie persistence, native
opener/postMessage/self-close and user-entered MFA remain unchanged.

The tab owner attempts each timer, candidate and page independently across every owned tab.
Native WebContents are captured by that owner in a WeakMap at page/Workspace construction;
retry does not reread a destroyed native view getter. This runtime pointer is not a persisted
schema or Renderer DTO. Candidate clearing remains in its credential owner, without copying
passwords into the teardown coordinator.

Managed child close no longer deletes its record before a thrown/vetoed native close. Other
children still receive their close request. Credential-association retirement completes before
the child record is removed; failed native terminal observers retain their cause and association
for explicit retry rather than throwing out of the native event callback. No change to login
success evidence, OTP/form classification, shared login delivery or vault encryption/schema.

## Evidence and corrections

Eight behavioral RED cases were observed before their corresponding repairs: credential timer
failure interrupted Browser close; page-reset failure skipped later owners; tab timer/candidate
failure interrupted view/transient cleanup; native child close throw/veto lost its record;
retry reread a destroyed native view; failed popup association cleanup escaped its observer.
The first tab fixture attempt mutated a copied/frozen effects object and was not a valid RED;
the fixture was corrected to inject failures through its original constructor effect closures,
then both cases failed against the restored baseline teardown implementation. No production
freeze was removed. A fake destroyed-contents predicate originally reread its fake view; that
fixture was corrected to model a captured native handle. Source-location credential assertions
were updated to follow the actual coordinator and retain candidate-clearing checks, not removed.

Real Electron fault injection exposed the destroyed native getter after an earlier cleanup
failure. Its regression now passes: the native window closes despite injected credential
cancellation failure, independent command/popup owners run, staged password clears, and the
failed native record still rejects replacement and Profile-close success. Fixture cleanup is
explicit and does not fabricate successful retirement. Prior toolbar, page/viewport, compact/
standard/wide geometry, keyboard and active-view assertions remain. No GUI/CSS/motion change.

Final local complete source suite:2,048 cases,2,032 passed,16 platform skips,0 failures. Native
toolbar/fault injection, password/popup MFA, strict proxy, tab retirement, routing restart,
Main integration, Profile switch/relaunch and migration command exit0 pass on this batch. Final
offline20-tab/100-switch p95 1.3ms/max8.4ms;30/30 soak views retired and terminal tab/view/timer
residue0. These are synthetic/private-fixture measurements, not original Windows/Gateway proof.
Windows/Linux native package acceptance still belongs to the exact-head CI matrix.

Teardown owner78, tab lifecycle263, popup162; Browser919->897/class763->740. The co-located
Session file is not claimed to be a sub600 file. Main662/20 direct/35 effective/170 transitive
and static JS debt90 remain unchanged; no production graph node, dependency, budget, wire or
schema added. The Browser line ratchet goes down; the tab module remains570 below its600 cap.
M2 composition/route/open work, M1/M5, reporter retests and the full goal remain incomplete.

## Unreleased user-facing note and rollback

Closing the campus browser now attempts other modules even if one module cannot confirm cleanup;
unconfirmed native windows/children remain owned and cannot be mistaken for successful context
retirement. This source-only note is not part of immutable v2.0.3 or an installed-app update.

Revert the coordinator/delegates, captured tab cleanup, popup terminal handling, contracts/native
fixture, downward ratchet and documentation together. No migration. Rollback restores reproduced
partial-cleanup/lost-child risks. No real-school canary, installed application or active Clash/
system proxy/TUN/DNS/route mutation, release or tag operation was performed.
