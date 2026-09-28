# Desktop Routing policy coordination ownership

- Status: Proposed M3 ownership contribution; not full Main/M5 convergence
- Owner: Desktop Routing maintainers
- Last verified: 2026-09-29
- Applies to: candidate based on development `main@60e028aa`, not published v2.0.3

`RoutingPolicyCoordinator` lives in the existing public
`lib/routing/rules/routing-policy-transaction.js` entrypoint. It owns external PAC URL
publication, Browser PAC projection, rule mutation snapshots and the commit/restore
operation bundle. It delegates atomic files to the existing `savePacFile` and all
ordering, rollback and stale-context enforcement to the existing
`RoutingPolicyTransactionQueue`; it does not create another transaction policy.

Main constructs the coordinator with the current DomainRoutePolicyStore and opaque
PAC paths, the settings/port readers, Browser lifecycle callbacks, readiness guard,
persistence admission and its single active-context transaction helper. The
coordinator does not import Browser, Engine or Profile modules. Construction performs
no filesystem or Browser effects. Each rule snapshot is read inside the queued
factory, after persistence admission, not when the request is first received.

External PAC still uses `defaultRoute: direct` and campus-private routing. Browser
PAC still selects HTTP for strict proxy auth and SOCKS5 otherwise, writes its durable
diagnostic copy before returning an in-memory PAC, and retains the loopback bypass
policy. Failure never supplies a DIRECT Browser fallback. Browser resume still
requires both a connected state and an active Engine; these are injected observations,
not inferred by Routing. Failed recovery leaves the Browser suspended according to
the existing transaction owner. Cancellation/drain and Profile/Account/Workspace
context handling are unchanged.

## Evidence and remaining work

At the candidate tree Main falls from 951 to 896 lines, 32 to 31 direct dependencies,
and 46 to 45 effective dependencies. Its 170 transitive modules do not increase.
The Routing transaction/coordinator entrypoint is 224 lines. Main's direct private
PAC-file import is removed, so the exact static-JS legacy inventory and cap fall from
116 to 115. The remaining exceptions, dynamic Renderer dependencies and Rust
visibility are still M5 work. Main still exceeds the M3 intermediate/final targets.

Synthetic tests cover effect-free construction, proxy modes, current-context queue
admission, external-before-Browser order, disconnected resume suppression, rollback
uncertainty, deferred Browser apply with mandatory recovery, and diagnostic-write
failure. They are not live-school routing evidence. Relevant native Electron,
persistence/profile, package and exact-tree gates must be recorded on the final
candidate separately from these source tests.

Rollback reverts the coordinator, Main wiring, contracts and reduced debt record
together. No IPC payload, schema, credential, network protocol, GUI, persistent path,
dependency version, release or installed-application change belongs to this slice.
