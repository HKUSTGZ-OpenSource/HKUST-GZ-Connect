# Desktop update quit retirement

- Status: Proposed bounded repair for reproduced issue 231; not full M3/M5 completion
- Owner: Desktop Platform maintainers
- Last verified: 2026-10-04 (local source and synthetic native checks)
- Applies to: existing update request/notification owner and Main terminal quit bindings

Before this repair, a successful check returning after quit still constructed a
settings transaction and could read retired Workspace files or publish a result.
The original Main integration diagnostic and a deferred-result experiment through
the actual Main quit callback reproduced this boundary without real user data.

The existing owner now distinguishes terminal `dispose()` from reversible
`stopAutomatic()`. Main invokes disposal first in its shutdown effects, before
other owners/credentials/resources, and repeats it idempotently on `will-quit`.
Disposal closes admission, clears the last issuance, stops timers and aborts every
owned request. Records remain tracked until their request/transaction settles;
an injected check that ignores cancellation is not detached or claimed drained.

The default HTTPS request receives its own AbortSignal, with the existing URL,
TLS, response-size and timeout boundaries unchanged. `checkForUpdate` retains its
two-argument fetch injection and adds optional third-argument cancellation options;
cancelled identity/release stages cannot start the next request or issue a URL.
Main's explicit check adapter and the owner default both forward that signal.
There is no public timeout/dependency/policy expansion or install/download action.

Every check result and queued transaction stage revalidates terminal ownership.
A retired factory returns inert operations without persistence admission or reads;
captured commit/rollback also refuse late writes. Live writes already completed
before retirement remain legitimate. The original serialized settings snapshot,
live rollback and failure behavior remain; only failures of retired work become
null rather than a post-quit rejection. No retired result publishes, opens a URL,
reads settings on a later invocation, or restarts scheduling. Ordinary automatic
stop/restart and a concurrent manual check remain compatible.

Regression evidence covers concurrent pending checks/cancellation/tracked settling,
late rejection, a factory behind the real mutation queue, captured commit/rollback,
late publication, new invocations and reentrant effects, plus original live errors.
An isolated native loopback ClientRequest test runs the actual default request
adapter through a test-only transport mapping and verifies destruction on abort;
its Agent explicitly creates only a loopback socket, never an installed proxy.
This is not live GitHub or HTTPS certificate evidence. Native Main integration
keeps all original assertions, replaces incidental live update I/O with synthetic
transport, and holds cleanup until a deliberately late result proves no further
read/write/notification. The actual Main quit callback is also exercised in the
existing Windows-selected integration file; platform evidence is recorded in CI.

Version comparison, repository identity and release-URL allowlisting are unchanged.
No new production module, dependency, IPC, schema, credential, system-network or
installed-app change. Main remains 666 lines with 20 direct/35 effective/170
transitive dependencies and private-edge cap 98; no budget is raised. Rollback
owner/request/Main/fixtures together needs no data migration but restores the
reproduced late-work risk. Published 2.0.3 is not silently replaced by this source
repair. Original report outcomes and full M1/M2/M3/M5/governance remain separate.
