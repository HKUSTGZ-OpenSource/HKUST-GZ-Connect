# Desktop Main composition boundary

- Status: Current source contract; final M3 acceptance recorded separately
- Owner: Desktop and architecture maintainers
- Last verified: 2026-10-04
- Applies to: development source after immutable v2.0.3, not installed/released behavior

Main constructs owners, injects configuration/DTO/OS effects, registers bounded capabilities
and binds application lifecycle. It does not own a second mutable connection intent, Engine
generation, retry timer, credential transaction, routing rollback or update flight.

## Reviewed entrypoints

These existing Main APIs were absent from the module map. Declarations reconcile the actual
consumed contracts, not whole implementation directories or a new generic barrel.

| Existing file under `desktop/lib/` | Main API | Ownership and evidence |
| --- | --- | --- |
| `app/card-board-main-runtime.js` | `createCardBoardMainRuntime` | Validated composition, trusted sender, serialized layout mutation/rollback; Card Board/Main contracts |
| `connection/recovery/connectivity-recovery.js` | `ConnectivityRecovery` | Outage epoch/debounce, cancellation/disposal; recovery/startup/Engine cases |
| `connection/telemetry/connection-telemetry-coordinator.js` | `ConnectionTelemetryCoordinator` | Current-generation telemetry/health, sanitized snapshots, injected effects; health/Main tests |
| `connection/telemetry/network-status-monitor.js` | `createNetworkStartupSystem`, `createStartupAutoConnectEligibility` | Bounded monitor/baseline/admission, packaged fixture denial, queued cancellation contracts |
| `integrations/external-proxy-config.js` | `ensureProxyCredentialSidecar`, `externalProxyHelperPath` | Validated private-file/ACL/zeroizing sidecar and native helper location; integration/strict-proxy/package gates |
| `platform/update/update-check.js` | `UpdateNotificationRuntime`, `checkForUpdate` | Repository-ID-bound checker/link and terminal abort/quit owner; offline/actual Main quit cases |
| `profiles/runtime/school-profile-controller.js` | `createPreReadySchoolProfileController`, `createSharedPortalCredentialProvider` | Profile/candidate authority and reviewed portal policies; primary/custom/switch/Windows/ASAR contracts |
| `switching/effects/browser-engine-barrier.js` | `stopEngineAfterBrowserSuspend` | Confirm Browser boundary or close the surface before releasing Engine; stop/suspension-failure tests |

The declarations are file-level, not curated symbol allowlists: existing exported helpers
remain importable to allowed domains. No new export or runtime access right is introduced.
Internal siblings are not promoted; allowed directions, ownership, risk/check vocabulary,
coverage, dependencies and runtime budgets do not expand. All 20 Main edges must be public in
allowed domains; matching legacy exceptions can never override that Main-specific check.
The remaining 90 static-JS exceptions cannot authorize new bypasses. Computed Renderer/Rust
visibility work remains M5; `dependencyEnforcement: inventory-only` stays unchanged.

## Whole-root semantic review

- Persistence owns settings reads/recovery/transactions, protected/memory credential selection,
  login DTO and stored paths. Main passes stores/backends/effects, not cipher/journal algorithms.
- FSM, OperationCoordinator and Engine application own intents/generations/flights/retry,
  readiness and event/stop lifecycle. Main delegates and injects the Browser-stop barrier.
- OperationCoordinator owns generation/intent/opaque-lease admission and initial offline
  choreography; Root does not reproduce those predicates or create connection intents.
- Browser Manager, Resource Library and Routing own command feedback, resource opens, epochs,
  PAC publication and rollback. Main effects/projections do not own new asynchronous flights.
- Profile owns portal credential/data selection. Main supplies the maintained adapter map and
  persistent opener; no primary-ID/origin selection policy remains in Main.
- Platform/Connection/Diagnostics own locale/status, telemetry, logs and updates. Main binds
  existing menu/Browser/status notifications and terminal disposal.
- Native paths, pre-ready permissions, single-instance, clipboard and OS startup are narrow
  infrastructure/lifecycle effects, not duplicate path or filesystem/platform implementations.
- Numeric port coercion/legacy fallback and constant PAC options are configuration adapters;
  input validation, persisted defaults and PAC generation remain in their owners.
- IPC connect/reconnect result stripping is pure DTO projection after an owned operation;
  it performs no new IO/state action after an unguarded await.
- Profile retirement, display-error and quit callbacks apply ordered effects to owned records.
  Unconditional log drainage must complete before proxy disposal; it is not a new state authority.

Only delayed composition references to Shell, Browser Manager, telemetry, writer and update
owners are mutable top-level Main values. The status record is an owned presentation projection,
not an independent FSM. Lazy capability construction/order is exercised by native startup.

## Acceptance and rollback

#81 requires all settings/credential/connection/Browser/update ownership, preserved Profile/
Account/Workspace/intent/generation/migration bindings, three numerical stages, public entrypoints
and contracts, no new Main algorithm/generic IPC/secret projection, and Desktop/Electron/upgrade/
routing/Engine/Windows/package gates. The current 662 lines/20 direct (35 effective,170 transitive)
meet size staging but do not prove those outcomes. Record exact source and full requirement-by-
requirement platform evidence before M3 closure; this does not close other waves or reporters.

This contract changes no runtime/schema/GUI/protocol/credential/network/installed-App behavior.
Rollback map/checker/debt/tests/docs together restores the former migration tolerance without
data migration. Verify runtime byte identity and unchanged dependency directions. Local tests,
exact GitHub checks/packages and published artifacts are distinct; none authorizes a release or
real-school canary. Dynamic Renderer and Rust boundaries remain incomplete M5 work.
