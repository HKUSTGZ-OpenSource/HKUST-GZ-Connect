# Desktop Engine termination ownership

- Status: Proposed M3 structural contract
- Owner: Desktop Connection maintainers
- Last verified: 2026-09-27
- Applies to: development source after v2.0.3; not published installer contents

Main delegates serving revocation, process-exit cleanup, close-outcome classification
and retry scheduling to `EngineTerminationCoordinator` in the existing Engine runtime.
It uses the original state machine and injected generation/context checks, scheduler,
proxy cleanup, settings, presentation and Browser suspension effects. It owns no
credential file, process handle, persistence service or second retry state machine.

Proxy cleanup stays in its persistence domain. Old process/context close can clear
only generation-scoped memory credentials, not a newer shared sidecar, Browser gate
or retry state. `exit` closes the request boundary before stdio finishes; `close`
consumes terminal-only drain before classifying the outcome and reading retry policy.
Stable-session uptime survives stopping, so short sessions cannot earn unlimited retry.
Unreadable settings remain terminal/fail-closed. Private stdin, reviewed profile binding,
memory-credential fallback and Windows durable owner checks are unchanged.

Main falls from 1,604 to 1,509 lines; its cap falls to 1,509. The runtime is 418 lines,
below its 600-line contract. No production module or dependency is added; direct and
transitive dependency caps remain 36/170. This does not complete M3's composition target.

Tests use the real state machine and generation-scoped cleanup policy for stale close,
retired FSM generations, exit/close order, retained uptime, bound retry intent, terminal
precedence, unreadable policy and exhausted/disabled retries. Main contracts follow
the actual injected ports and moved implementation without dropping safety assertions.
Full Desktop, exact-source gates and native synthetic lifecycle/Profile-switch tests
remain required. Synthetic evidence does not prove a real Gateway/MFA session.

This structural change retains existing asynchronous error-presentation behavior.
Late-promise error fences are separate behavioral work and must have RED/GREEN tests;
the extraction alone does not claim that risk resolved. Revert this slice with its
tests and ratchet to roll back. No data, schema, network or installed-App migration occurs.
