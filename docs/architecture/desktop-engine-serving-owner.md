# Desktop Engine serving ownership

- Status: Proposed M3 structural contract
- Owner: Desktop Connection maintainers
- Last verified: 2026-09-26
- Applies to: development source after v2.0.3, not published installer contents

## Boundary

The existing `engine-connection-runtime.js` owns per-attempt serving promotion,
Browser activation single-flight, typed-event presentation, bounded diagnostic
tail and fatal-code receipt through `EngineServingCoordinator`. Protocol admission,
hello deadlines, private Control stream and exit drain remain in `EngineConnectionRuntime`.
The connection state machine remains the single authority for connection phase.

Main injects current generation/context validation, presentation, Browser gate,
diagnostic writer, translator, serving revocation, stop request, capability observation
and first-connection telemetry effects. The coordinator receives no password,
credential owner, filesystem path, Profile store or child stdin. Its constructor
only stores ports and handler closures: no async yield is introduced between the
final credential/settings snapshot and process spawn.

Promotion still requires both listener readiness and a connected candidate in the
same admitted generation. Browser activation must settle before promotion; duplicate
signals do not repeat activation or telemetry. Stale-context activation completion
does not publish. Existing connected-but-Browser-degraded behavior is retained.
Typed failure classification consumes the current shared Engine output module, so
post-v2.0.3 pre-login classification is not replaced by a historical implementation.

## Ratchets and validation

Main falls from 1,682 to 1,604 lines; its cap falls to 1,604. The existing runtime
is 303 lines and bounded by a 600-line unit contract. No production module,
dependency, IPC API, protocol schema or settings migration is added.

Tests use the real state machine and protocol admission owner to exercise both
readiness orders, exactly-once telemetry, single-flight activation, stale completion,
current-context degradation, fatal/timeout revocation and terminal-only exit drain.
Main contract tests follow the moved handlers while retaining context, stdin,
generation and close-boundary assertions. Full Desktop and synthetic native Engine
lifecycle, architecture, governance, syntax, secret and package gates remain required.

This extraction does not claim M3 completion, a new authentication method, live
Gateway/MFA success or native Windows acceptance from a macOS fixture. Human
diagnostic presentation is retained; it is not promoted to connection-state authority.

## Rollback

Revert this extraction, matching tests and ratchet together. No user data, credential,
installed application or system-network state is migrated. Broader process-start,
termination and persistence ownership remain separate work.
