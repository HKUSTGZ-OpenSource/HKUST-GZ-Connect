# Browser route presentation through navigation owner

- Status: Proposed bounded M2 follow-on; not full Browser lifecycle ownership
- Owner: Desktop Browser maintainers
- Last verified: 2026-09-29
- Applies to: candidate based on development `main@c81906fb32e80540cf4212b5ef3148761cc63d29`, not published v2.0.3

The existing `BrowserNavigationOwner` now owns the displayed/current URL, effective route
selection for a navigation, per-tab route metadata and refresh after policy changes. Browser
still injects its active `routingPolicy.resolve` callback. On an invalid or failing policy result,
the owner calls the existing Routing fallback `resolveDomainRouteForUrl`; it does not implement a
second rule engine. The reviewed initial resource route is honored only when policy reports the
default source. A user rule always takes precedence. Local blank Home remains Direct, and local
error-page `data:` URLs are not exposed as the current destination.

The owner remains co-located with `BrowserTabLifecycle` so Main's 170-module transitive
dependency cap does not grow. Its file is 563 lines, below the existing 600-line owner ceiling;
the Browser orchestrator falls from 1,368 to 1,333 lines. Routing readiness, PAC/Session
activation, credential/MFA and browser request gates remain their prior owners. M2 still requires
additional independently tested lifecycle extractions.

Synthetic tests cover default-only requested routes, exact-rule priority, Routing fallback,
local blank/data URL handling and tab metadata refresh. Existing Browser, MFA, strict-proxy,
routing-restart, performance/soak and package checks must pass before merge. These checks do not
prove real school routing, installed-application behavior or a new release.

Rollback the owner methods, Browser forwarding, tests and this record as one change. No persisted
schema, IPC contract, Engine behavior, user data or published artifact is changed.
