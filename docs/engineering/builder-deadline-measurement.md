# Builder in-flight deadline measurement

- Status: Proposed contract repair; final exact-main acceptance required
- Owner: Desktop maintainers; accountable maintainer heeh02
- Last verified: 2026-10-04
- Applies to: test-only source after `main@7c18cc2b66d6c2627826be6db8e4b826545c01ed`, not runtime/download/release policy
- Supersedes: deadline fixture signal consuming its budget before request admission

## Original failure and measured scope

Final-main CI37194023565 attempt1 at the base above failed its Desktop test job111412019477.
Only `builder retains its configured request deadline on a stalled loopback download` failed:
the request-count assertion was false. Other eight jobs, including actual native Browser and all
three packages, passed. PR#246 same-tree gates and local complete suite passed. No failed-main
job or whole matrix was rerun; it remains a failed observation, not retrospectively called green.

The existing builder27 fixture created `AbortSignal.timeout(300)` before the installed builder's
preparation/cache/lock/fetch admission. A busy worker may exhaust that signal before the loopback
server sees a request. An expired pre-request signal is not an in-flight download ignoring its
deadline, and0 requests must not be accepted as evidence of that download contract.

The regression delays preparation by750ms, longer than the original300ms signal. It genuinely
failed the actual-request assertion before repair, without external endpoints, real installers,
dependency mutation, Node module monkeypatching or a guessed runner-load threshold.

## Repair and unchanged guards

The test passes the actual installed builder an AbortController signal. Its existing300ms
abort deadline is armed only when the owned loopback server receives the stalled request;
the same TimeoutError reason is observed through the builder's real signal forwarding.
The acquired timer is cleared in finally. A new marker requires actual timer arming, not simply
an arbitrary rejection. Missing request, ignored abort or wrong failure still fail the fixture.

The20s child watchdog,25s test timeout,18s elapsed guard, legacy50ms request timeout and
non-deadline10s signal remain unchanged. No timeout/performance budget raised. The normal and
delayed cases both require at least one actual request; cache, checksum mismatch, proxy receipt,
503 retry, permanent404 and corrupted-cache assertions remain unchanged.

Everything is test-only: one fixture and this scoped note. No production/runtime, builder,
dependency/lock, CI/status/permissions, package/release, installed application, credentials,
active Clash/system proxy/TUN/DNS/route changes. Proxy/cache versions remain process-local,
synthetic and owned. This tests the in-flight abort deadline, not a new claim that pre-request
preparation fits300ms; its existing independent watchdog remains the preparation guard.

## Local evidence and required remote acceptance

`node --test test/contracts/packaging/builder-download-compatibility.test.js`:8/8 pass.
Complete Desktop suite:2,063 cases,2,047 passed,16 platform skips,0 failures. The installed
lockfile-matched builder is27.0.0-alpha.9 with Electron43.7.7; no reinstall or override was used.
Source architecture/governance/install-script/syntax/exact-tree secret/whitespace gates are
required before the single push. Production source/tree comparison must show no change.

All seven exact-head checks, three supported native packages and the final repaired-main CI
remain acceptance gates. Original Windows/login and portal reporter retests are not supplied
by this fixture. The runtime Browser.open-after-user-close finding is a separate M2 repair;
it is not mixed into this packaging contract. Full repository goal remains incomplete.

## Rollback

Revert the fixture and note together; no migration or dependency rollback. This restores the
observed premature-signal measurement failure. Keep the original failed CI receipt distinct
from any later repaired commit and never raise deadlines, skip the request assertion or
fabricate a status to make main appear qualified.
