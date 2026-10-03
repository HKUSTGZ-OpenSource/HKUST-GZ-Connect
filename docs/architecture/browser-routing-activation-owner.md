# Browser routing activation owner

- Status: Proposed bounded M2 extraction; not merged or full Browser ownership
- Owner: Desktop Browser maintainers
- Last verified: 2026-10-03
- Applies to: candidate based on development `main@7e86a41451f0788e09e8a9e4f505885c59744119`; not published v2.0.3

## Ownership

`BrowserRoutingActivationOwner` lives alongside `BrowserSessionManager` in the existing Session
entrypoint. It owns the Browser-facing in-flight activation record, Engine-readiness admission,
reuse of an already active Session and selection of configure versus resume. Browser's existing
methods delegate to this owner, and its diagnostic flight property is a read-only projection.

Actual PAC generation, Session configuration, request interception, epoch fencing and fail-closed
suspension remain in their existing owners. The activation owner consumes injected capabilities;
it does not resolve route rules, change global proxy/DNS/routes, access authentication secrets or
introduce a second Session authority. This is an ownership move, not a routing behavior repair.

## Compatibility and teardown

Direct navigation still skips Engine startup. Campus navigation still requires Engine readiness.
After that wait, context retirement forbids activation; a Session superseded by a suspend intent
remains fail closed. Concurrent same-port requests share one transition, while a different port
waits for the preceding transition before re-evaluating the current Session.

Window cleanup resets the coordination record idempotently, without cancelling the shared
Session/Engine transition or removing cookies. A late completion only clears the exact record it
owns, so it cannot erase a replacement flight. The Window, Tab and Session owners retain their
separate terminal authority. Browser method names and return values remain compatible.

## Acceptance

Before movement, the existing Browser/Session regression subset passed 70 tests on local macOS.
The new independent owner contract initially failed eight tests because the owner did not exist;
after extraction all nine owner tests and the unchanged subset pass (79 total).
They cover input capability validation, reuse/resume, same/different-port concurrency, rejected
flights, direct/campus readiness, context retirement, superseding suspension and repeated reset.

Full Node, architecture/governance, install-script, exact-tree syntax/secret, native Browser routing,
MFA, strict proxy, retirement and performance/soak checks remain the local acceptance matrix.
Actual macOS/Windows/Linux package checks on the eventual PR head are separate requirements.
These tests do not establish live Gateway behavior or change the installed application.

No new production dependency node, IPC wire, persistent schema or package dependency is added.
M2 remains open: the Browser orchestrator still contains page-event and other residual lifecycle
logic, and the existing Session entrypoint still co-locates legacy campus-data behavior.

## Rollback

Revert the Browser wiring, Session owner, tests and this record together. No user-data migration,
credential reset, installed-app replacement or published-tag modification is needed.
