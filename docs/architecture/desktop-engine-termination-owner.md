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

The structural extraction alone retained existing asynchronous error presentation.
A separate RED/GREEN callback-fence repair captures the suspension intent and checks
generation, context and intent again before publishing a rejected Browser suspension.
Retired work is inert; a current failure still emits its actionable notice. No retry,
primary failure, credential or proxy policy changes. Revert each slice independently
with its matching tests/ratchet. No data, schema, network or installed-App migration occurs.
