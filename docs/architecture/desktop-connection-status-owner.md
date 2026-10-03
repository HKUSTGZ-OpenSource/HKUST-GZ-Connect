# Desktop connection status owner

- Status: Proposed bounded extraction for M3; not full M3 acceptance
- Owner: Desktop maintainers
- Last verified: 2026-10-04 (local source checks; exact-head CI recorded in the PR)
- Applies to: Desktop Connection presentation and Main composition

## Ownership

The existing Connection presentation module owns the display record, connected
timestamp, status notification order and log/recovery feedback. Main constructs
`ConnectionStatusRuntime` through the existing Connection public entrypoint and
injects late-bound shell, telemetry, locale/update, clock and capability effects.
No production file, dependency, IPC method, persistent schema or channel is added.

The `ConnectionStateMachine` remains the sole phase/intent/generation authority.
The presentation owner never promotes, disconnects or retries a connection. Engine,
Persistence and startup owners retain the same display-record reference for their
existing bounded writes. The unchanged `projectConnectionStatus` function remains
available from its original public entrypoint and overrides display flags with
the current FSM projection. Renderer receives no new data or secret capability.

## Preserved ordering and lifecycle

- Emit: refresh PAC display URL, observe current FSM for waiters, send projected
  status plus current locale/update, then refresh the tray. A missing early shell
  is tolerated; effect failures retain their original propagation boundaries.
- Connected callback: capture the clock, then start telemetry with the same
  generation/context token. Admission remains the existing Engine serving owner.
- Clear: erase the timestamp/IP, reset DNS display, clear capability projection,
  then stop telemetry. Existing error/notice domains are not erased.
- Log failures/recovery emit once per diagnostic-notice transition and do not
  overwrite connection, settings, recovery or Browser outcomes.
- Tunnel-recovery feedback checks the injected current generation/context predicate
  before updating the display or emitting. Main's original predicate is unchanged.

## Evidence and limits

Baseline FSM/Main settings contracts passed before movement. Six absent-runtime
cases failed before implementation; a seventh absent-recovery method case also
failed before movement. Contracts exercise independent display records, immutable
projection, late effects, thrown effects, timestamp/clear order, notification
deduplication and stale generation/context suppression. Main's source contracts
continue to check the original Engine admission and context-token fences.

Main falls from 720 to 699 lines with 20 direct, 35 App-expanded effective and
170 transitive dependencies unchanged. The hard line budget ratchets down; the
existing production graph and private-edge inventory/cap of 101 are unchanged.
Meeting these numerical targets is not full composition acceptance: residual
Browser-open presentation, login-account adaptation and inline settings/lifecycle
effects still require semantic review. M1/M2/M5, governance and reporter outcomes
are separate unfinished work. Offline/native fixtures do not prove live-school
networking, the installed app or a released capability.

Rollback restores Main presentation wiring, the original projection location,
contracts and the previous line ratchet together. User data, credentials, routing,
dependencies, Engine protocol and installed software are unaffected.
