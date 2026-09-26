# Engine process ownership

- Status: Proposed M4 convergence slice, pending review/acceptance
- Owner: Rust Engine maintainers
- Last verified: 2026-09-26
- Applies to: `independent/src/bin/ec-engine.rs` and binary-private `engine_app/`
- Base: `main@71dc05e55964226604d62bfaee87ffdacbc64435`
- Issue: #82; not part of immutable 2.0.3 packages

## Owners and composition

The root composes argument/environment/config/credential input, the closed provider factory,
connector/netstack creation and terminal-event dispatch. It shrinks from 2,138 to 498 lines. The
downward composition cap is 499; each private owner has a 600-line cap, not a raised aggregate
budget. Module interfaces use `pub(super)` rather than exposing process internals through the
library. No second protocol, credential, configuration or routing authority is introduced.

| Private module | Responsibility | Excluded responsibility |
| --- | --- | --- |
| arguments | Closed flags, generation hints, test-feature selection | Secret input, files, network |
| control | Inherited pipe, bounded frames/channel, pending shutdown requests | Credentials, lifecycle phase, process termination |
| events | Ordered lifecycle/control event emission | Protocol parsing, resource cleanup |
| operation | Worker/control/signal/deadline arbitration and bounded cancellation drain | Provider selection, Session/Transport cleanup |
| startup | Provider/Transport workers and late-result cleanup | Reading stdin, choosing a protocol, creating listeners |
| runtime | Prepared netstack/listener/health, ordered drain and logout | Authentication or Gateway connector selection |
| failure | Stable primary/secondary error projection | Resource ownership, I/O, secrets |

Readiness, phase order and EOF semantics are preserved: loss of the inherited control owner before
listener readiness cancels the attempt; after readiness it closes only the optional channel. The
100 ms shutdown-cancel window, 500 ms worker drain, initial handshake and teardown budgets remain.
The stdin reader is still process-scoped, not claimed independently cancellable while blocked in
an OS read. Cleanup uncertainty remains secondary and cannot replace a primary failure.

The current pre-password Gateway error mapping and its regression move to the failure owner;
they are not dropped while replaying earlier candidates. Current crypto dependencies/MSRV and
profile/credential ownership are preserved. Desktop changes are only source-location assertions
in the stop-policy test; no Main/Renderer/runtime algorithm changes are bundled here.

## Deadline regression

An elapsed accepted-shutdown or operation deadline is committed before a ready worker can promote
its result, including a timer's first-poll registration edge. Synthetic tests cover expired
deadlines, independent cancellation, uncommitted shutdown, repeated stop/ready races and late
completion cleanup. This does not widen deadlines, invent real authentication outcomes or claim
that vendor blocking syscalls become immediately cancellable.

## Production/laboratory boundary

[ADR-0034](../adr/0034-compatibility-laboratory-feature-boundary.md) gates five research APIs/CLI
targets and six archive/disassembly dependencies behind explicit `compatibility-lab`. Default
production imports fail at compile time; opt-in positive tests retain research functionality.
The credential-free shipped Gateway probe is not a research-only module. The compatibility-watch
consumer explicitly opts in; existing CI names, permissions and production commands are retained.

This is default-build isolation, not per-target isolation when a developer intentionally enables
the laboratory feature for the whole crate. Production/package commands keep `--no-default-features`.
No feature opt-in grants access to credentials, vendor artifacts or live-school operations.

## Acceptance and rollback

Local macOS checkpoint: production 315 passed/0 failed/2 ignored; laboratory 327/0/2 with positive
API coverage; lifecycle fixture 317/0/2 including the 100-round subprocess soak. Warning-free
Clippy passes in all three modes. Five separate production compile-fail doctests and the dependency
graph test pass. Desktop remains 1,538 total/1,524 passed/14 platform skips/0 failed; stop-policy
source-location regressions and synthetic auth-control pipe pass. Native/required exact-head and
package/performance checks remain separate gates before merging or closing #82.

Validate formatting, warning-free Clippy and full tests independently in production, laboratory
and lifecycle-fixture modes. Run the synthetic Desktop/Engine auth pipe, 100-round process soak,
offline performance guards, exact-tree architecture/governance/secret/syntax checks, native
Windows/Linux compilation/tests and package gates. Skips, source/fixture evidence and real-campus
outcomes remain distinct. Only passing default tests is not acceptance after hiding research APIs.

Revert this ownership/feature slice, source-location tests and downward caps together if needed.
There is no persisted/wire/credential migration or installed-app replacement. Do not rewrite the
published 2.0.3 tag or packages to include this later source.
