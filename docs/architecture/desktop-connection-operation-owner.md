# Desktop connection-operation ownership

- Status: Proposed M3 structural contract
- Owner: Desktop Connection maintainers
- Last verified: 2026-10-04 (local source and native synthetic follow-on)
- Applies to: development source after v2.0.3, not published installer contents

`ConnectionOperationCoordinator` lives in the existing public
`connection-state-machine.js` entrypoint. Its imperative coordination is separate
from the pure FSM: it owns pending connect/stop/reconnect records, manual intent
creation, quit gates, post-stop admission, and connectivity recovery admission,
invalidation and restart. Main injects the existing Engine attempt, settings,
recovery cancellation, Browser stop barrier and presentation effects.
`ConnectivityRecovery` remains the sole owner of outage epochs, debounce timers,
and online/offline/suspend/resume scheduling; it calls the operation owner through
the existing callback seam.

The Connection admission follow-on keeps the remaining initial-offline intent and
cross-owner admission in this same coordinator. Main injects the existing opaque
context lease and connectivity recovery objects; the coordinator observes actual
Supervisor generation first, then current FSM intent and lease validity. No second
generation, intent, context or mutable connection authority is introduced. Browser
resume preserves connected-first/active-second observation; telemetry reconnect
delegates to the existing reconnect only for the same current Engine context.
The stale path retains its resolved `{ ok: false, stale: true }` Promise. These
observations preserve their previous short-circuit, raw return and failure behavior;
they do not invent a quit, retry or route policy. Live reconnect now returns the
existing owner's Promise directly rather than passing through Main's async facade.

Initial offline startup cancels only `ConnectivityRecovery`, creates the desired
intent through the actual FSM and returns that intent only when networkOffline
accepts it. It must not call general cancelRecovery, which also cancels the startup
coordinator and would invalidate its own pending initialization. Monitor baseline,
outage/debounce state, startup single-flight, Engine attempts and every existing
deadline stay in their original owners. Main callbacks remain lazy: construction
does not evaluate admission before the operation owner has been composed.

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

The historical storage-effects slice reduced Main from 1,013 to
950 lines. The state entrypoint grew from 463 to 541 lines, below 600.
Direct/effective dependencies remained 32/46 and transitive dependencies 170;
no runtime module or dependency was added. That slice did not meet M3's below-800/24 or
final 500–700/20 targets at that checkpoint.

The current admission follow-on reduces Main from 665 to 662 lines, ratcheting
the cap downward. The existing state file is 573 lines, below its unchanged 600
cap. Direct/effective/transitive metrics remain 20/35/170 and private-edge cap 98;
no module, dependency, barrel, IPC, schema, global-network or installed-app change.
Numerical staging is met but full M3 semantic/public-entrypoint acceptance is not
inferred. The remaining Profile campus-data source selection and final exit audit
keep #81 open; other original goal issues remain independent requirements.

Tests exercise duplicate clicks, pending stop drainage, cancellation/invalidation
order, stale retry intents/health generations, same-intent connectivity recovery,
settings-read failure, disabled auto-reconnect, unclean stop, quit/superseding
intent, retired operation presentation and the actual injected Browser barrier on
suspension failure. Main contracts verify its ports and the moved owner rather than
deleting assertions tied to the former location. Full Desktop, native synthetic
Engine lifecycle, profile-switch,
architecture/governance/syntax/exact-tree secret and three-platform package gates
remain required. Synthetic tests do not establish live-school password/MFA/L3
behavior or resolve the original Windows report #127.

Six new unit contracts first fail without the owned methods, then pass with actual
FSM/opaque lease and real recovery for valid/stale generation, intent and context,
foreign/context-only tokens, short-circuit/raw observation, failures, live/stale
reconnect and offline cancellation order. Main source contracts reject remaining
inline policy and initial intent choreography. Native Main captures its actual
public owners and injected telemetry effects; ordinary routing transactions and
synthetic offline/online Engine serving exercise the new owner. Windows-selected
integration compiles Main's actual public callback expressions and ports with the
real FSM/lease/recovery, not another policy implementation. Local execution is not
native Windows acceptance; its real CI case and exact-source packages remain gates.

Rollback reverts this owner, Main wiring, relocated contracts and lowered ratchets
together. No data/schema/IPC/protocol/GUI migration, global network change or
installed-app replacement occurs.
