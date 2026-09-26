# Desktop connection-operation ownership

- Status: Proposed M3 structural contract
- Owner: Desktop Connection maintainers
- Last verified: 2026-09-27
- Applies to: development source after v2.0.3, not published installer contents

`ConnectionOperationCoordinator` lives in the existing public
`connection-state-machine.js` entrypoint. Its imperative coordination is separate
from the pure FSM: it owns pending connect/stop/reconnect records, manual intent
creation, quit gates and post-stop admission. Main injects the existing Engine
attempt, recovery cancellation, Browser stop barrier and presentation effects.

There is one operation implementation, not an IPC/Renderer copy. A manual action
cancels queued recovery; stopping invalidates the old generation before awaiting
drainage. Reconnect cannot start before confirmed clean shutdown, after quitting,
or after a superseding user intent. Concurrent connects/reconnects retain the
existing shared-operation behavior. The profile-bound credential selector,
private stdin binding, serving/termination context fences and event-driven Browser
readiness waiters remain in their existing owners.

The Browser-before-Engine stop barrier stays in the switching domain and is
injected, not imported through a private cross-domain implementation. PAC/drain
failure still closes an unconfirmed Browser surface before releasing the listener.
Plaintext sidecar removal follows stop completion; stable encrypted credential and
profile/workspace ownership do not change. Main no longer supplies duplicate
grace/force constants: EngineSupervisor's existing reviewed defaults remain the
same 6-second graceful and 2-second forced windows, plus Control grace.

## Ratchets and validation

Main falls from 1,247 to 1,136 lines, direct dependencies from 35 to 34, effective
direct dependencies from 50 to 49. The existing state entrypoint is 463 lines,
below 600; no new runtime module, dependency or transitive-budget increase occurs.
The first M3 line target is met, but its 30-dependency and final 500–700/20 targets
are not. Keep #81 open.

Tests exercise duplicate clicks, pending stop drainage, cancellation/invalidation
order, stale retry intents/health generations, quit before/after async boundaries,
unclean stop, superseding disconnect, retired disconnect presentation and the
actual injected Browser barrier on suspension failure. Main contracts verify its
ports and the moved owner rather than deleting assertions tied to the former
location. Full Desktop, native synthetic Engine lifecycle, profile-switch,
architecture/governance/syntax/exact-tree secret and three-platform package gates
remain required. Synthetic tests do not establish live-school password/MFA/L3
behavior or resolve the original Windows report #127.

Rollback reverts this owner, Main wiring, relocated contracts and lowered ratchets
together. No data/schema/IPC/protocol/GUI migration, global network change or
installed-app replacement occurs.
